'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const {MinerApp}=require('../src/byze-p2pool')
const {HistorySync}=require('../src/mining/history-sync')
const id='ps:'+ 'a'.repeat(64)
const local='ls:'+ 'b'.repeat(64)

test('offline history request does not starve reachable peer',()=>{
  const sent=[]
  const h=new HistorySync({now:()=>10000,known:()=>false,send:(peer)=>{sent.push(peer);return peer==='online'}})
  h.request('offline',id)
  h.request('online',id)
  h.tick()
  assert.deepEqual(sent,['offline','online'])
})

function app(){
  const a=Object.create(MinerApp.prototype)
  Object.assign(a,{failedDeferredProofs:new Map(),pplnsHistoryIncomplete:false,deferredRecoveryOverflow:false,
    poolChain:{byId:new Map(),canonicalShareForEpoch:()=>id},poolPackets:new Map(),
    transport:{peers:new Map()},remotePoolPeer:()=>false})
  return a
}
test('expired local share remains blocked until included in a validated canonical checkpoint',async()=>{
  const a=app()
  a.rememberDeferredFailure('local',local,{packet:{share:{epoch:1,shareId:local}},peerKey:'offline'})
  await a.recoverDeferredFailures(Date.now()+20000)
  assert.equal(a.pplnsHistoryIncomplete,true)
  a.poolPackets.set(id,{proofs:[{share:{shareId:local}}]})
  await a.recoverDeferredFailures(Date.now()+40000)
  assert.equal(a.pplnsHistoryIncomplete,false)
})
test('pool proof recovery requires attached chain node and preserves overflow hold',async()=>{
  const a=app()
  a.rememberDeferredFailure('pool',id,{packet:{share:{poolShareId:id}},peerKey:'offline'})
  await a.recoverDeferredFailures(Date.now()+20000)
  assert.equal(a.pplnsHistoryIncomplete,true)
  a.poolChain.byId.set(id,{})
  a.deferredRecoveryOverflow=true
  await a.recoverDeferredFailures(Date.now()+40000)
  assert.equal(a.pplnsHistoryIncomplete,true)
})
