'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const {MinerApp,CONTRACT_SOURCE_HASH,POOL_ID}=require('../src/byze-p2pool')
const {HistorySync}=require('../src/mining/history-sync')
const id=n=>'ps:'+n.toString(16).padStart(64,'0')
test('history ancestor takes priority over speculative inventory, preserving limits',()=>{
  const sent=[]
  const h=new HistorySync({now:()=>10000,known:()=>false,send:(peer,frame)=>{sent.push(frame.id);return true}})
  for(let n=1;n<=4;n++)assert.equal(h.request('peer',id(n)),true)
  assert.equal(h.request('peer',id(5),{priority:true}),true)
  assert.equal(h.pending.size,4)
  h.tick()
  assert.deepEqual(sent,[id(5)])
})
test('late joining peer gets bounded replay rather than repeated full history',()=>{
  const a=Object.create(MinerApp.prototype),sent=[]
  const epoch=Math.floor(Date.now()/60000)
  Object.assign(a,{peerKey:'self',localReplayByPeer:new Map(),liveShares:new Map(),
    live:()=>({epoch,cellId:'cell'}),remotePoolPeer:()=>true,
    transport:{peers:new Map([['remote',{}]]),connected:()=>true,send:(_,f)=>{sent.push(f.packet.share.shareId);return true}}})
  for(let n=0;n<100;n++){
    const shareId='ls:'+n.toString(16).padStart(64,'0')
    a.liveShares.set(shareId,{local:true,share:{shareId,epoch,contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID}})
  }
  for(let n=0;n<20;n++)a.rebroadcastRecentLocalShares()
  assert.equal(sent.length,20)
  assert.equal(new Set(sent).size,20)
})
test('multi-peer candidate requires current nonempty common tip and verified remote proof',()=>{
  const a=Object.create(MinerApp.prototype),now=Date.now(),epoch=Math.floor(now/60000)
  let tip=''
  Object.assign(a,{poolChain:{tipBeforeEpoch:()=>tip},peerPplnsProofs:new Map(),
    members:()=>[{local:true},{peerKey:'remote',miningState:'MINING',transportConnected:true}]})
  assert.equal(a.peerPplnsReady('',now),false)
  tip=id(1)
  assert.equal(a.peerPplnsReady(tip,now),false)
  a.peerPplnsProofs.set('remote',{tip:id(2),epoch,at:now})
  assert.equal(a.peerPplnsReady(tip,now),false)
  a.peerPplnsProofs.set('remote',{tip,epoch,at:now})
  assert.equal(a.peerPplnsReady(tip,now),true)
  assert.equal(a.peerPplnsReady(tip,now+61000),false)
})
