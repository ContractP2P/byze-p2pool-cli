'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const { assertMainnetReady, PeerRateLimiter, ValidationGate }=require('../src/security-hardening')

test('public pool fails closed outside synchronized mainnet',()=>{
  assert.equal(assertMainnetReady({chain:'main',blocks:100,headers:100,initialblockdownload:false}).ok,true)
  assert.equal(assertMainnetReady({chain:'regtest',blocks:100,headers:100,initialblockdownload:false}).code,'byze-mainnet-required')
  assert.equal(assertMainnetReady({chain:'main',blocks:100,headers:100,initialblockdownload:true}).code,'byze-node-not-synchronized')
  assert.equal(assertMainnetReady({chain:'main',blocks:95,headers:100,initialblockdownload:false}).code,'byze-node-behind-headers')
})

test('per-peer limiter throttles and temporarily blocks abusive peers',()=>{
  const lim=new PeerRateLimiter({windowMs:10_000,maxFrames:1,maxBytes:100,maxExpensive:1,strikesToBlock:3,blockMs:60_000})
  const peer='a'.repeat(64)
  assert.equal(lim.allow(peer,{bytes:10,type:'hello'},0).ok,true)
  assert.equal(lim.allow(peer,{bytes:10,type:'hello'},1).code,'peer-rate-limited')
  assert.equal(lim.allow(peer,{bytes:10,type:'hello'},2).code,'peer-rate-limited')
  const blocked=lim.allow(peer,{bytes:10,type:'hello'},3)
  assert.equal(blocked.code,'peer-rate-limit-blocked')
  assert.equal(lim.isBlocked(peer,4),true)
  assert.equal(lim.isBlocked(peer,60_004),false)
})

test('expensive validation concurrency is bounded globally and per peer',async()=>{
  const gate=new ValidationGate({maxGlobal:2,maxPerPeer:1,maxQueued:2,maxQueuedPerPeer:1})
  let releaseA,releaseB
  const waitA=new Promise(r=>{releaseA=r}), waitB=new Promise(r=>{releaseB=r})
  const p1=gate.run('a',async()=>{await waitA;return {ok:true,id:1}})
  const p2=gate.run('b',async()=>{await waitB;return {ok:true,id:2}})
  const queued=gate.run('a',async()=>({ok:true,id:3}))
  const rejected=await gate.run('a',async()=>({ok:true,id:4}))
  assert.equal(rejected.code,'peer-validation-overloaded')
  releaseA(); releaseB()
  assert.equal((await p1).ok,true); assert.equal((await p2).ok,true); assert.equal((await queued).id,3)
})
