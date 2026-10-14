'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const m=require('./core.cjs')
const HASH='a'.repeat(64), TX='b'.repeat(64)
const fee=m.policy.feeAddress
const coinbase=(value='0.25',address=fee)=>({txid:TX,vin:[{coinbase:'010203'}],vout:[{value,scriptPubKey:{address}},{value:'49.75',scriptPubKey:{address:'byz1qother'}}]})
test('fee script is a validated Byze segwit v1 script',()=>{
  const x=m.addressScript(fee)
  assert.match(x,/^5120[0-9a-f]{64}$/)
  assert.throws(()=>m.addressScript(fee.slice(0,-1)+'q'),/checksum/)
})
test('strict decimal values have exact satoshi precision',()=>{
  assert.equal(m.toSats('0.00000001'),1n)
  assert.equal(m.toSats('50'),5000000000n)
  assert.equal(m.toSats(1e-8),1n)
  assert.throws(()=>m.toSats(1.123456789),/eight decimal/)
  assert.throws(()=>m.toSats('1.123456789'))
  assert.throws(()=>m.toSats('1e+2'))
  assert.equal(m.toSats('5000','sats'),5000n)
})
test('tip and block wrappers are strict',()=>{
  assert.equal(m.tipHeight({result:{chain:'main',blocks:200}}),200)
  assert.throws(()=>m.tipHeight({chain:'regtest',height:200}),/Unexpected chain/)
  const x=m.blockMetadata({result:{height:100,hash:HASH,time:1792000000,tx:[coinbase()]}},100)
  assert.equal(x.hash,HASH)
  assert.throws(()=>m.blockMetadata({height:101,hash:HASH,time:1792000000,tx:[coinbase()]},100),/Height mismatch/)
})
test('coinbase candidate and expected 0.5% fee',()=>{
  const x=m.evaluateBlock({height:100,hash:HASH,time:1792000000},coinbase())
  assert.equal(x.candidate,true)
  assert.equal(x.feeApproxMatch,true)
  assert.equal(x.paidFeeSats,'25000000')
  assert.equal(x.expectedFeeSats,'25000000')
  const nope=m.evaluateBlock({height:100,hash:HASH,time:1792000000},coinbase('0.25','byz1qother'))
  assert.equal(nope.candidate,false)
  assert.equal(nope.feeApproxMatch,false)
})
test('invalid coinbases and missing outputs never claim a result',()=>{
  assert.throws(()=>m.coinbaseTx({txid:TX,vin:[{}],vout:[{value:50}]}),/not a decoded coinbase/)
  assert.throws(()=>m.evaluateBlock({height:1,hash:HASH}, {...coinbase(),vout:[{scriptPubKey:{address:fee}}]}),/missing value/)
})
test('cursor overlap, gap protection and delayed confirmation',()=>{
  assert.deepEqual(m.makeScanRange(100,null,{lookback:5,overlap:3,maxBlocks:20}),{start:96,end:100,count:5})
  assert.deepEqual(m.makeScanRange(110,{lastHeight:107},{lookback:5,overlap:3,maxBlocks:20}),{start:104,end:110,count:7})
  assert.throws(()=>m.makeScanRange(200,{lastHeight:100},{lookback:5,overlap:3,maxBlocks:20}),/exceeds limit/)
  const cand={hash:HASH,height:98,candidate:true,feeApproxMatch:true}
  let a=m.stateFromScan(null,{tip:100,blocks:[{height:98,hash:HASH}]},[cand],6,0)
  assert.equal(a.newCandidates.length,0)
  a=m.stateFromScan(a.state,{tip:105,blocks:[{height:98,hash:HASH}]},[cand],6,0)
  assert.equal(a.newCandidates.length,1)
  const b=m.stateFromScan(a.state,{tip:106,blocks:[{height:98,hash:HASH}]},[cand],6,0)
  assert.equal(b.newCandidates.length,0)
})
test('detects replacements of previously observed heights',()=>{
  const previous={lastHeight:100,blocks:{100:HASH},seen:[],lastReportAt:0}
  const got=m.stateFromScan(previous,{tip:101,blocks:[{height:100,hash:'b'.repeat(64)}]},[],6,0)
  assert.deepEqual(got.reorgs,[100])
})
