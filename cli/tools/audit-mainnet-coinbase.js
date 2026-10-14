#!/usr/bin/env node
'use strict'

// Read-only P2Pool coinbase candidate auditor against an ALREADY RUNNING BYZE mainnet node.
// NEVER starts/stops Core, opens wallets, sends funds or submits blocks.
// A matching fee output and ratio alone DO NOT prove PPLNS accounting or which build mined it.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const policy = require('../config/pool-policy.json')

function parseArgs(args) {
  const parsed = {}
  for (const arg of args) {
    const match = /^--(cli|from|to|max|output)=(.+)$/.exec(arg)
    if (!match) throw new Error('Usage: node audit-mainnet-coinbase.js --cli=/absolute/path/byze-cli [--from=2026-10-13] [--to=2026-10-15] [--max=1000] [--output=/tmp/byze-p2pool-evidence.json]')
    parsed[match[1]] = match[2]
  }
  if (!parsed.cli || !path.isAbsolute(parsed.cli)) throw new Error('--cli must be an explicit absolute byze-cli path; no automatic node discovery.')
  parsed.from = parsed.from || '2026-10-13'
  parsed.to = parsed.to || '2026-10-15'
  const fromMs = Date.parse(parsed.from + 'T00:00:00Z')
  const toMs = Date.parse(parsed.to + 'T00:00:00Z')
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) throw new Error('Invalid UTC date range')
  parsed.fromTs = Math.floor(fromMs / 1000)
  parsed.toTs = Math.floor(toMs / 1000)
  parsed.max = Number(parsed.max || 1000)
  if (!Number.isSafeInteger(parsed.max) || parsed.max < 1 || parsed.max > 10000) throw new Error('--max must be 1..10000')
  return parsed
}
function rpc(cli, method, ...args) {
  const output = execFileSync(cli, [method, ...args.map(String)], { encoding:'utf8', timeout:25000, maxBuffer:16*1024*1024 }).trim()
  try { return JSON.parse(output) } catch { return output }
}
function toSats(x) {
  const scaled = Number(x) * 100000000
  if (!Number.isFinite(scaled) || scaled < 0 || !Number.isSafeInteger(Math.round(scaled)) ||
      Math.abs(scaled - Math.round(scaled)) > 0.00001)
    throw new Error('Unexpected coinbase output value: ' + x)
  return BigInt(Math.round(scaled))
}
function scriptMatches(vout, fee, script) {
  const spk = vout?.scriptPubKey || {}
  return spk.address === fee || (Array.isArray(spk.addresses) && spk.addresses.includes(fee)) ||
    (script && String(spk.hex||'').toLowerCase() === script.toLowerCase())
}
function getCoinbase(cli, hash) {
  const block = rpc(cli, 'getblock', hash, 2)
  if (!block || !Array.isArray(block.tx) || block.tx.length === 0) throw new Error('Invalid decoded block')
  const tx = typeof block.tx[0] === 'string'
    ? rpc(cli, 'getrawtransaction', block.tx[0], 'true', hash)
    : block.tx[0]
  if (!tx || !Array.isArray(tx.vin) || !tx.vin.some(v => v.coinbase !== undefined) || !Array.isArray(tx.vout))
    throw new Error('First transaction is not a decoded coinbase')
  return { block, tx }
}
function scan(cli, options) {
  const info = rpc(cli, 'getblockchaininfo')
  if (info.chain !== 'main' || info.initialblockdownload === true) throw new Error('Requires synchronized mainnet BYZE Core; refusing regtest/testnet/IBD.')
  const feeDetails = rpc(cli, 'validateaddress', policy.feeAddress)
  if (feeDetails?.isvalid !== true) throw new Error('Fee address cannot be validated on selected node')
  const feeScript = String(feeDetails.scriptPubKey || '')
  const tip = Number(info.blocks)
  if (!Number.isSafeInteger(tip) || tip < 1) throw new Error('Invalid chain height')
  const result = {
    schema:1, type:'byze-p2pool-mainnet-readonly-audit',
    scope:'Fee/script candidates only; DOES NOT certify build identity or exact PPLNS weights',
    checkedAt:new Date().toISOString(), chain:'main', chainTip:tip,
    from:options.from, toExclusive:options.to, maxBlocks:options.max,
    poolId:policy.poolId, feeAddress:policy.feeAddress, feeBasisPoints:policy.feeBasisPoints,
    scanned:0, incomplete:false, candidates:[], errors:[]
  }
  for (let height = tip; height >= 0 && result.scanned < options.max; height--) {
    const hash = rpc(cli, 'getblockhash', height)
    let record
    try { record = getCoinbase(cli, hash) }
    catch(e) { result.errors.push({ height, hash, error:e.message }); continue }
    const { block, tx } = record
    const time = Number(block.time)
    if (!Number.isFinite(time)) { result.errors.push({height,hash,error:'missing time'});continue }
    if (time < options.fromTs) break
    if (time >= options.toTs) continue
    result.scanned++
    const payouts = tx.vout.map(v => ({ address: v.scriptPubKey?.address ||
      (v.scriptPubKey?.addresses || [])[0] || null,
      script:String(v.scriptPubKey?.hex || ''), sats:toSats(v.value), n:v.n }))
    const total = payouts.reduce((sum,p) => sum + p.sats,0n)
    const feeOutputs = tx.vout.filter(v => scriptMatches(v, policy.feeAddress, feeScript))
    if (!feeOutputs.length) continue
    const paidFee = feeOutputs.reduce((sum,v) => sum + toSats(v.value),0n)
    const expectedFee = total * BigInt(policy.feeBasisPoints) / 10000n
    const diff = paidFee > expectedFee ? paidFee - expectedFee : expectedFee - paidFee
    result.candidates.push({height, hash, time:new Date(time*1000).toISOString(),
      confirmations:tip-height+1, coinbaseTxid:tx.txid,
      totalCoinbaseSats:String(total), paidFeeSats:String(paidFee),
      theoreticalFeeSats:String(expectedFee), feeDifferenceSats:String(diff),
      approximateFeeMatch:diff<=2n, outputCount:payouts.length,
      outputs:payouts.map(p=>({address:p.address,script:p.script,sats:String(p.sats),n:p.n}))})
  }
  if (result.scanned >= options.max) result.incomplete=true
  return result
}
function main() {
  const options = parseArgs(process.argv.slice(2))
  fs.accessSync(options.cli, fs.constants.X_OK)
  const result = scan(options.cli, options)
  const json = JSON.stringify(result,null,2)+'\n'
  if (options.output) {
    const dest = path.resolve(options.output)
    if (fs.existsSync(dest)) throw new Error('Refusing to overwrite evidence file: '+dest)
    fs.writeFileSync(dest,json,{flag:'wx',mode:0o600})
    console.log('Audit evidence saved: '+dest)
  } else process.stdout.write(json)
  console.error(`Scanned ${result.scanned} blocks; candidates ${result.candidates.length}; errors ${result.errors.length}. A candidate is not proof of PPLNS or build identity.`)
  if (result.errors.length || result.incomplete) process.exitCode=2
}
try { main() } catch(e) { console.error('BYZE_MAINNET_AUDIT_FAILED:',e.message);process.exitCode=1 }
