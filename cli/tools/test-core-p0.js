#!/usr/bin/env node
'use strict'

// Optional isolated RPC integration check. No mainnet connection or real funds.
// BYZE_CORE_BIN=/path/to/rc4/bin npm run test:core
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { PayoutAddressValidator } = require('../src/mining/payout-address')
const { transactionMetrics, blockWeight } = require('../src/mining/block-weight')
const { sanitizeGbtTemplate, hashMeetsTarget, targetFromCompactBits } = require('../src/mining/p2pool-randomx')
const run = promisify(execFile)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  if (!process.env.BYZE_CORE_BIN) throw new Error('Set BYZE_CORE_BIN to the directory containing verified Byze rc4 binaries.')
  const bin = path.resolve(process.env.BYZE_CORE_BIN)
  const suffix = process.platform === 'win32' ? '.exe' : ''
  for (const name of ['byzed','byze-cli']) fs.accessSync(path.join(bin,name+suffix),fs.constants.X_OK)
  const datadir = fs.mkdtempSync(path.join(os.tmpdir(),'byze-p0-regtest-'))
  const port = 20000 + Math.floor(Math.random()*30000)
  const args = ['-regtest',`-datadir=${datadir}`,`-rpcport=${port}`]
  const node = spawn(path.join(bin,'byzed'+suffix),[...args,'-daemon=0','-server=1','-listen=0','-connect=0','-dnsseed=0','-discover=0','-networkactive=0','-dbcache=64','-par=1','-printtoconsole=0'],{stdio:'ignore'})
  let startupError
  node.on('error',error=>{startupError=error})
  const exited = new Promise(resolve => node.once('exit',resolve))
  const rpc = async (method,params=[]) => {
    const result = await run(path.join(bin,'byze-cli'+suffix),[...args,method,...params.map(p=>typeof p==='string'?p:JSON.stringify(p))],{timeout:120_000,maxBuffer:16*1024*1024})
    const text=result.stdout.trim()
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }
  }
  let ready = false
  try {
    for (let i=0;i<180;i++) {
      if (startupError) throw startupError
      if (node.exitCode !== null) throw new Error(`Core exited during startup: ${node.exitCode}`)
      try { const info=await rpc('getblockchaininfo'); assert.equal(info.chain,'regtest'); ready=true; break } catch {}
      if (i%30===0) console.log('Waiting for isolated Core regtest startup...')
      await delay(1000)
    }
    if (!ready) throw new Error('Isolated Core RPC did not become available within the startup limit.')
    assert.equal(await rpc('getconnectioncount'),0)
    console.log('Core ready: regtest, zero network peers.')
    await rpc('createwallet',['p0-test'])
    const quantum=await rpc('getnewaddress')
    let validator=new PayoutAddressValidator(rpc)
    assert.equal((await validator.validate(quantum)).spendability,'wallet-quantum')
    const descriptors=await rpc('listdescriptors')
    const descriptor=descriptors.descriptors.find(d=>d.active&&!d.internal&&d.desc.startsWith('tr(')).desc
    const [plain]=await rpc('deriveaddresses',[descriptor,[0,0]])
    assert.equal((await rpc('validateaddress',[plain])).isvalid,true)
    assert.equal((await validator.validate(plain)).code,'miningPayoutUnspendable')
    assert.equal((await validator.validate('byz1invalidaddress0000')).ok,false)
    console.log('Wallet quantum address accepted; wallet plain Taproot and malformed address rejected.')
    const raw=await rpc('createrawtransaction',[[{txid:'11'.repeat(32),vout:0}],{[quantum]:1}])
    const decoded=await rpc('decoderawtransaction',[raw])
    assert.equal(transactionMetrics(raw).weight,decoded.weight)
    assert.equal(transactionMetrics(raw).txid,decoded.txid)
    assert.equal(sanitizeGbtTemplate(await rpc('getblocktemplate',[{rules:['segwit']}])).ok,true)
    console.log('Core transaction weight and block-template parsing agree.')
    const [mined]=await rpc('generatetoaddress',[1,quantum])
    const header=await rpc('getblockheader',[mined])
    const rawHash=Buffer.from(mined,'hex').reverse().toString('hex')
    assert.equal(hashMeetsTarget(rawHash,targetFromCompactBits(header.bits)),true)
    const rawBlock=await rpc('getblock',[mined,0])
    const decodedBlock=await rpc('getblock',[mined,1])
    assert.equal(blockWeight(rawBlock),decodedBlock.weight)
    console.log('Mined regtest block: Core PoW ordering and serialized block weight agree.')
    await rpc('unloadwallet',['p0-test'])
    validator=new PayoutAddressValidator(rpc)
    assert.equal((await validator.validate(plain)).spendability,'unknown')
    console.log('Without the wallet, external spendability remains explicitly unknown.')
    console.log('Core P0 integration checks passed.')
  } finally {
    if (ready) { try { await rpc('stop') } catch {} }
    if (node.exitCode === null) node.kill('SIGTERM')
    await Promise.race([exited,delay(5000)])
    if (node.exitCode === null) { node.kill('SIGKILL'); await exited }
    fs.rmSync(datadir,{recursive:true,force:true})
  }
}

main().catch(error=>{console.error(error.message);process.exitCode=1})
