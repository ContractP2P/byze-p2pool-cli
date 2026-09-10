'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const {PoolShareChain}=require('../src/mining/poolshare-chain')
const H='a'.repeat(64),TIP='b'.repeat(64),POOL='byze-main-p2pool-v1',CELL='cell:1:forktest'
function share(hex,prev='',work=10,height=100,cphex='c'){
 return {kind:'pool-share',poolShareId:'ps:'+hex.repeat(64).slice(0,64),previousPoolShareId:prev,checkpointId:'cp:'+cphex.repeat(64).slice(0,64),contractHash:H,poolId:POOL,cellId:CELL,byzeHeight:height,byzePrevBlockHash:TIP,work:String(work),payoutWeights:{byz1alice000:String(work)}}
}
test('v0.2.2 accepts sibling forks and chooses greatest cumulative work',()=>{
 const c=new PoolShareChain({maxShares:64,window:20})
 const root=share('9','',10,100,'1');assert.equal(c.add(root,{checkpointEpoch:1}).ok,true)
 const a=share('8',root.poolShareId,10,101,'2');assert.equal(c.add(a,{checkpointEpoch:2}).ok,true)
 const b=share('7',root.poolShareId,30,101,'3');const r=c.add(b,{checkpointEpoch:2})
 assert.equal(r.ok,true);assert.equal(r.reorg,true);assert.equal(c.bestId,b.poolShareId);assert.equal(c.snapshot().forkCount,1)
})
test('v0.2.2 tie-breaks equal-work tips by lowest PoolShareId',()=>{
 const c=new PoolShareChain({maxShares:64,window:20});const root=share('9','',10,100,'1');c.add(root,{checkpointEpoch:1})
 const high=share('f',root.poolShareId,20,101,'2');c.add(high,{checkpointEpoch:2})
 const low=share('0',root.poolShareId,20,101,'3');const r=c.add(low,{checkpointEpoch:2})
 assert.equal(r.reorg,true);assert.equal(c.bestId,low.poolShareId)
})
test('v0.2.2 does not stack two PoolShares from the same epoch',()=>{
 const c=new PoolShareChain({maxShares:64,window:20});const root=share('1','',10,100,'1');c.add(root,{checkpointEpoch:5})
 const r=c.add(share('2',root.poolShareId,10,101,'2'),{checkpointEpoch:5})
 assert.equal(r.ok,false);assert.equal(r.code,'miningPoolShareEpochRegression')
})
test('v0.2.2 keeps missing-parent shares orphaned until authenticated history arrives',()=>{
 const c=new PoolShareChain({maxShares:64,window:20});const missing='ps:'+'e'.repeat(64)
 const r=c.add(share('1',missing,10,100,'1'),{checkpointEpoch:2})
 assert.equal(r.ok,true);assert.equal(r.orphan,true);assert.equal(c.bestId,'')
})

test('partitioned peers converge to the same canonical tip regardless of arrival order',()=>{
  const root=share('a','',10,100,'1')
  const a1=share('b',root.poolShareId,10,101,'2')
  const a2=share('c',a1.poolShareId,10,102,'3')
  const b1=share('d',root.poolShareId,15,101,'4')
  const b2=share('e',b1.poolShareId,20,102,'5')
  const c1=new PoolShareChain({window:20,maxShares:64})
  const c2=new PoolShareChain({window:20,maxShares:64})
  for(const [x,e] of [[root,0],[a1,1],[a2,2],[b1,1],[b2,2]]) assert.equal(c1.add(x,{checkpointEpoch:e}).ok,true)
  for(const [x,e] of [[root,0],[b1,1],[b2,2],[a1,1],[a2,2]]) assert.equal(c2.add(x,{checkpointEpoch:e}).ok,true)
  assert.equal(c1.bestId,b2.poolShareId)
  assert.equal(c2.bestId,b2.poolShareId)
  assert.equal(c1.snapshot().cumulativeWork,c2.snapshot().cumulativeWork)
})
test('v0.2.2 binds PoolShare proofs to branch parent and classifies stale live shares separately',()=>{
 const main=fs.readFileSync(path.join(__dirname,'..','src','byze-p2pool.js'),'utf8')
 const ui=fs.readFileSync(path.join(__dirname,'..','src','console-ui.js'),'utf8')
 assert.match(main,/expectedPplnsTipId:String\(previousPoolShareId\|\|''\)/)
 assert.match(main,/pplns-tip-branch-mismatch/)
 assert.match(main,/pplns-tip-stale-fork/)
 assert.match(main,/deferredLocalShares\.size\|\|this\.deferredPoolShares\.size/)
 assert.match(main,/this\.refreshJob\(true\)/)
 assert.match(main,/coinbase-binding-v2-global-epoch-v4/)
 assert.match(ui,/Remote A\/P\/R/)
 assert.match(ui,/Forks/)
 assert.match(ui,/Reorgs/)
})
