'use strict'
const policy = require('../../config/pool-policy.json')
const SATS = 100_000_000n

function unwrap(value) {
  for (let n = 0; n < 3; n++) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        (value.result !== undefined || value.data !== undefined)) value = value.result ?? value.data
    else break
  }
  return value
}
function int(value, name) {
  const x = Number(value)
  if (!Number.isSafeInteger(x) || x < 0) throw new Error(`Invalid ${name}`)
  return x
}
function tipHeight(json) {
  const j = unwrap(json)
  if (typeof j === 'number') return int(j, 'chain height')
  if (!j || typeof j !== 'object') throw new Error('Invalid tip JSON')
  if (j.chain && j.chain !== 'main' && j.chain !== 'mainnet') throw new Error(`Unexpected chain: ${j.chain}`)
  return int(j.blocks ?? j.height ?? j.blockHeight ?? j.block_height ?? j.chainHeight ?? j.chain_height ?? j.tip?.height, 'chain height')
}
function toSats(value, mode = 'byz') {
  if (mode === 'byz' && typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 100000000) throw new Error('Invalid numeric BYZ amount')
    const rounded = value.toFixed(8)
    if (Math.abs(value - Number(rounded)) > 1e-10) throw new Error('More than eight decimal places in numeric BYZ amount')
    return toSats(rounded, mode)
  }
  if (mode === 'sats') {
    const s = String(value)
    if (!/^\d+$/.test(s)) throw new Error('Invalid integer sats amount')
    return BigInt(s)
  }
  const s = String(value)
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(s)
  if (!m) throw new Error(`Invalid BYZ amount: ${s}`)
  return BigInt(m[1]) * SATS + BigInt((m[2] || '').padEnd(8,'0'))
}
function valueSats(v, mode) {
  const explicit = v.value_sats ?? v.valueSat ?? v.satoshis ?? v.valueSats
  if (explicit !== undefined) return toSats(explicit, 'sats')
  if (v.value === undefined && v.amount === undefined) throw new Error('Coinbase output missing value')
  return toSats(v.value ?? v.amount, mode)
}
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
function polymod(values) {
  let chk=1
  for (const v of values) {
    const top=chk >>> 25
    chk=((chk & 0x1ffffff) << 5) ^ v
    for (let i=0;i<5;i++) if ((top >>> i) & 1) chk ^= [0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3][i]
  }
  return chk >>> 0
}
function bitsToBytes(values) {
  let acc=0, bits=0; const out=[]
  for (const v of values) {
    if (v < 0 || v > 31) throw new Error('Invalid witness 5-bit value')
    acc=(acc<<5)|v; bits+=5
    while(bits>=8) {bits-=8;out.push((acc>>>bits)&255)}
  }
  if (bits >= 5 || ((acc << (8-bits)) & 255) !== 0) throw new Error('Invalid witness padding')
  return Buffer.from(out)
}
function addressScript(address) {
  const s=String(address)
  if (s !== s.toLowerCase() || !s.startsWith('byz1')) throw new Error('Fee address must be lowercase byz1 bech32(m)')
  const pos=s.lastIndexOf('1'), hrp=s.slice(0,pos), chars=s.slice(pos+1)
  if (hrp!=='byz' || chars.length < 7 || chars.length > 90) throw new Error('Invalid fee address')
  const d=[...chars].map(c=>CHARSET.indexOf(c))
  if (d.some(x=>x < 0)) throw new Error('Invalid fee address charset')
  const payload=d.slice(0,-6), ver=payload[0]
  if (ver > 16) throw new Error('Invalid witness version')
  const h=[...hrp].map(c=>c.charCodeAt(0))
  const check=polymod([...h.map(x=>x>>5),0,...h.map(x=>x&31),...d])
  if (check !== (ver===0 ? 1 : 0x2bc830a3)) throw new Error('Invalid bech32(m) checksum')
  const program=bitsToBytes(payload.slice(1))
  if (program.length<2 || program.length>40 || (ver===0 && ![20,32].includes(program.length))) throw new Error('Invalid witness program')
  return `${ver === 0 ? '00' : (0x50+ver).toString(16)}${program.length.toString(16).padStart(2,'0')}${program.toString('hex')}`
}
function coinbaseTx(json) {
  const tx=unwrap(json)
  if (!tx || !Array.isArray(tx.vout) || !tx.vout.length) throw new Error('Missing decoded coinbase vouts')
  if (!Array.isArray(tx.vin) || !tx.vin.some(x=>x && x.coinbase!==undefined)) throw new Error('First tx is not a decoded coinbase')
  if (!/^[0-9a-f]{64}$/i.test(tx.txid||tx.hash||'')) throw new Error('Invalid coinbase txid')
  return tx
}
function blockMetadata(json, height) {
  const b=unwrap(json)?.block ?? unwrap(json)
  if (!b || typeof b!=='object' || Array.isArray(b)) throw new Error('Invalid decoded block')
  const n=int(b.height ?? b.block_height, 'block height')
  if (height!==n) throw new Error(`Height mismatch ${height} != ${n}`)
  if (!/^[0-9a-f]{64}$/i.test(b.hash||b.blockhash||'')) throw new Error(`Invalid block hash at ${height}`)
  const txs=b.tx ?? b.transactions
  if (!Array.isArray(txs) || !txs.length) throw new Error(`No transactions in block ${height}`)
  const t=b.time ?? b.timestamp
  const time=typeof t==='number'?t:Math.floor(Date.parse(t)/1000)
  if (!Number.isSafeInteger(time) || time<=0) throw new Error(`Missing block time ${height}`)
  return { hash:(b.hash||b.blockhash).toLowerCase(), height, time, first:txs[0], confirmations:b.confirmations }
}
function evaluateBlock(meta, txJson, mode = 'byz') {
  const tx=coinbaseTx(txJson)
  const targetScript=addressScript(policy.feeAddress)
  let total=0n, fee=0n, outputCount=0, matches=0
  const outputs=[]
  for (const v of tx.vout) {
    const sats=valueSats(v,mode); total+=sats; outputCount++
    const spk=v.scriptPubKey||v.script_pub_key||{}
    const addr=spk.address || v.address
    const addresses=Array.isArray(spk.addresses)?spk.addresses:[]
    const script=(spk.hex||spk.script||v.scriptpubkey||'').toLowerCase()
    outputs.push({n:v.n??outputCount-1,address:addr||addresses[0]||null,script,sats:sats.toString()})
    if (addr===policy.feeAddress || addresses.includes(policy.feeAddress) || (script && script===targetScript)) {fee+=sats; matches++}
  }
  if (total<=0n) throw new Error('Empty coinbase amount')
  const expected=total*BigInt(policy.feeBasisPoints)/10000n
  const delta=fee>=expected?fee-expected:expected-fee
  return {
    height:meta.height,hash:meta.hash,time:meta.time,coinbaseTxid:tx.txid||tx.hash,
    outputCount,feeOutputCount:matches,totalSats:total.toString(),outputs,
    paidFeeSats:fee.toString(),expectedFeeSats:expected.toString(),
    differenceSats:delta.toString(),feeApproxMatch:matches>0 && delta<=2n,
    // A candidate is NOT proof of P2Pool origin or exact PPLNS payout correctness.
    candidate:matches>0
  }
}
function makeScanRange(tip, state, opts = {}) {
  const lookback=int(opts.lookback ?? 36,'lookback'), overlap=int(opts.overlap ?? 12,'overlap')
  const max=int(opts.maxBlocks ?? 160,'max scan blocks')
  if (lookback<1 || overlap<1 || max<lookback+1) throw new Error('Invalid scan limits')
  const start=state?.lastHeight===undefined ? Math.max(0,tip-lookback+1) : Math.max(0,state.lastHeight-overlap)
  if (start>tip) throw new Error('Chain tip rewound beyond scan overlap; operator review required')
  if (tip-start+1>max) throw new Error(`Scan gap ${tip-start+1} exceeds limit ${max}; operator review/backfill required`)
  return {start,end:tip,count:tip-start+1}
}
function formatByz(s) {
  const n=BigInt(s), head=n/SATS, tail=(n%SATS).toString().padStart(8,'0').replace(/0+$/,'')
  return `${head}${tail?'.'+tail:''}`
}
function summarize(result) {
  const checked=result.checked, matches=result.newCandidates
  const lines=[
    '**BYZE P2Pool · Blockchain observation (experimental)**',
    `Chain tip: **${checked.tip}** · Scan: ${checked.start}–${checked.tip} (${checked.blocks} blocks)`,
    `New fee-address coinbase candidates (≥${checked.minConfirmations} conf.): **${matches.length}**`,
    `Candidates with ~0.50% fee match: **${matches.filter(x=>x.feeApproxMatch).length}/${matches.length}**`
  ]
  for(const x of matches.slice(0,5)) lines.push(`• #${x.height} ${x.hash.slice(0,14)}… · fee ${formatByz(x.paidFeeSats)} BYZ · ${x.feeApproxMatch?'fee ≈ expected':'fee differs'}`)
  if(result.reorgs.length)lines.push(`⚠️ Chain replacements observed at heights: ${result.reorgs.slice(0,8).join(', ')}`)
  lines.push('**Limit:** fee-address match is only a candidate; not proof of P2Pool origin, correct PPLNS weights, wallet spendability, or a particular CLI build.')
  return lines.join('\n').slice(0,1900)
}
function stateFromScan(old, scan, candidates, minConfirmations, now) {
  const previous=old||{seen:[],blocks:{},lastReportAt:0}
  const known=new Set(previous.seen||[])
  const published=[]
  for(const c of candidates) {
    if(c.candidate && scan.tip-c.height+1 >= minConfirmations && !known.has(c.hash)) {
      published.push(c); known.add(c.hash)
    }
  }
  const blocks={...previous.blocks}
  const reorgs=[]
  for(const b of scan.blocks) {
    const prior=blocks[String(b.height)]
    if(prior && prior!==b.hash) reorgs.push(b.height)
    blocks[String(b.height)]=b.hash
  }
  for(const k of Object.keys(blocks)) if(Number(k)<scan.tip-144) delete blocks[k]
  // Limit issue JSON size while keeping ample confirmed candidate deduplication history.
  const seen=[...known].slice(-1200)
  return {state:{schema:1,lastHeight:scan.tip,blocks,seen,lastReportAt:Number(previous.lastReportAt||0)},newCandidates:published,reorgs}
}
module.exports={policy,tipHeight,toSats,addressScript,coinbaseTx,blockMetadata,evaluateBlock,makeScanRange,formatByz,summarize,stateFromScan}
