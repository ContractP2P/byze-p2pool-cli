'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('crypto'),path=require('path')
const {proofAnchor,poolAnchor,ChainContextValidator}=require('../src/mining/chain-context')
const {HistorySync,MAX_HISTORY_AGE_MS}=require('../src/mining/history-sync')
const {MinerApp,loadPolicy,sign,CONTRACT_SOURCE_HASH,POOL_ID}=require('../src/byze-p2pool')
const {buildRandomxLocalShare,validateRandomxEnvelope,proofEnvelopeSigningPayload,targetFromCompactBits,shareTargetFromNetworkTarget,randomxCheckpoint}=require('../src/mining/p2pool-randomx')
const {buildPoolShare}=require('../src/mining/p2pool-protocol')
const {ValidationGate}=require('../src/security-hardening')
const H='12'.repeat(32),B='34'.repeat(32)
function proof(height=101,prev=H){const h=Buffer.alloc(80);Buffer.from(prev,'hex').reverse().copy(h,4);h.writeUInt32LE(0x207fffff,72);return {height,previousBlockHash:prev,header80:h.toString('hex')}}
function app(){return new MinerApp({alias:'test',wallet:'byz1test000000',threads:1,policy:loadPolicy(path.join(__dirname,'../config/pool-policy.json')),byze:{call:async()=>{throw Error('unexpected RPC')}},noSubmit:true})}
function fixture(at=Date.now()){
 const a=app(),seed=crypto.randomBytes(32)
 const peer=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'}).export({format:'der',type:'spki'}).subarray(-32).toString('hex')
 const networkTarget=targetFromCompactBits('207fffff'),shareTarget=shareTargetFromNetworkTarget(networkTarget)
 const share=buildRandomxLocalShare({contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID,cellId:'cell:1:test',epoch:Math.floor(at/60000),minerPeerId:peer,payoutAddress:'byz1test000000',jobId:'rxj:'+'cc'.repeat(32),nonce:0,powHash:'00'.repeat(32),createdAt:at,shareTarget}).share
 const pp={proofMode:'byze-randomx-v2',share,proof:{...proof(),networkTarget,shareTarget,templateHash:'22'.repeat(32),difficultyMultiplier:256,blockCandidate:true,jobCommitmentHash:'33'.repeat(32),feePolicyHash:a.policy.policyHash,pplnsTipId:'',coinbaseValue:'5000000000',coinbaseNoWitnessHex:'00'.repeat(20),coinbaseMerkleBranch:[]}}
 pp.signature=sign(seed,proofEnvelopeSigningPayload(pp))
 const checkpoint=randomxCheckpoint({contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID,cellId:share.cellId,epoch:share.epoch,shares:[share]}).checkpoint
 const pool=buildPoolShare({checkpoint,byzeHeight:101,byzePrevBlockHash:H}).poolShare
 const packet={share:pool,checkpoint,proofs:[pp],signerPeerKey:peer,signature:sign(seed,a.poolShareSigningPayload(pool))}
 return {a,seed,peer,pp,packet}
}
test('header binding rejects mismatched parent and invalid height; anchor is deterministic',()=>{
 assert.equal(proofAnchor({...proof(),previousBlockHash:B}),null)
 assert.equal(proofAnchor(proof(1.5)),null)
 const rows=[{proof:proof(100,B)},{proof:proof()}]
 assert.deepEqual(poolAnchor(rows),poolAnchor([...rows].reverse()))
 assert.equal(poolAnchor([{proof:proof(100,B)},{proof:proof(100,H)}]),null)
 assert.equal(poolAnchor([{proof:proof(90,B)},{proof:proof()}]),null)
})
test('node view invalidates cached context after a reorg and bounds live lag',async()=>{
 let best=H
 const v=new ChainContextValidator(async(m,p)=>m==='getblockchaininfo'?{blocks:100,bestblockhash:best}:m==='getblockhash'?H:{bits:'207fffff'})
 assert.equal((await v.validate(proof(),{height:101,previousblockhash:H,bits:'207fffff'})).ok,true)
 best=B;v.snapshot.at=0
 assert.equal((await v.validate(proof(),{height:101,previousblockhash:H,bits:'207fffff'})).code,'previous-block-mismatch')
 assert.equal((await v.validate(proof(90),{})).code,'consensus-height-out-of-range')
 assert.equal((await v.validate(proof(90),{},{historical:true})).ok,true)
 assert.equal((await v.validate(proof(102),{},{historical:true})).ok,false)
})
test('aggregate freshness uses wall clock; historical allowance remains finite',async()=>{
 const now=Date.now(),{a,pp,packet}=fixture(now-600000)
 assert.equal(validateRandomxEnvelope(pp,{now,aggregate:true}).ok,false)
 assert.equal(validateRandomxEnvelope(pp,{now,aggregate:true,maxAgeMs:MAX_HISTORY_AGE_MS}).ok,true)
 assert.equal(validateRandomxEnvelope(pp,{now:now+MAX_HISTORY_AGE_MS,aggregate:true,maxAgeMs:MAX_HISTORY_AGE_MS}).ok,false)
 let expensive=0;a.validateConsensusContext=async()=>{expensive++;return {ok:true}}
 assert.equal((await a.verifyCellProof(pp,{contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID,cellId:pp.share.cellId,epoch:pp.share.epoch,previousPoolShareId:''})).ok,false)
 assert.equal(expensive,0)
 assert.equal(a.precheckRelay(packet,packet.checkpoint,packet.proofs,packet.signerPeerKey,'').ok,false)
})
test('unauthorized relay is rejected before chain RPC, coinbase or RandomX work',async()=>{
 const {a,packet}=fixture(),other=fixture()
 packet.signerPeerKey=other.peer;packet.signature=sign(other.seed,a.poolShareSigningPayload(packet.share))
 a.remotePoolPeer=()=>true
 let expensive=0;a.verifyPoolProofBundle=async()=>{expensive++;return {ok:false}}
 const result=await a.acceptPoolShare(other.peer,packet)
 assert.equal(result.code,'relay-unauthorized');assert.equal(expensive,0)
})
test('aggregate metadata must match proven anchor and deterministic share id',async()=>{
 const {a,packet}=fixture()
 a.verifyCellProof=async pp=>({ok:true,payload:pp.share})
 assert.equal((await a.verifyPoolProofBundle(packet)).ok,true)
 const wrong=structuredClone(packet);wrong.share.byzeHeight++
 assert.equal((await a.verifyPoolProofBundle(wrong)).code,'poolshare-anchor-mismatch')
 const forged=structuredClone(packet);forged.share.poolShareId='ps:'+'ff'.repeat(32)
 assert.equal((await a.verifyPoolProofBundle(forged)).code,'poolshare-id-mismatch')
})
test('history synchronizes multiple pages with bounded responses and no unsolicited authority',async()=>{
 const {packet}=fixture(),id=packet.share.poolShareId
 packet.proofs=Array.from({length:100},(_,i)=>({...packet.proofs[0],padding:'x'.repeat(2000),ordinal:i}))
 let now=1000,requests=[],responses=[],received=[]
 const client=new HistorySync({now:()=>now,send:(p,f)=>{requests.push(f);return true},getPacket:()=>null,known:()=>false,receive:async(p,f)=>received.push(f)})
 const server=new HistorySync({now:()=>now,send:(p,f)=>{responses.push(f);return true},getPacket:()=>packet,known:()=>false,receive:async()=>{}})
 assert.equal(client.isRequested('peer',id),false)
 assert.equal(await client.accept('peer',{id,cursor:0,packet}),false)
 client.request('peer',id)
 for(let i=0;i<20&&!received.length;i++){
  client.tick();const req=requests.shift();assert.ok(req)
  assert.equal(server.serve('peer',req),true)
  assert.equal(server.serve('peer',req),false)
  const page=responses.shift();assert.ok(Buffer.byteLength(JSON.stringify(page))<50*1024)
  assert.equal(await client.accept('wrong-peer',page),false)
  assert.equal(await client.accept('peer',page),true);now+=650
 }
 assert.equal(received.length,1);assert.equal(received[0].proofs.length,100)
 assert.equal(client.isRequested('peer',id),true)
 now+=300001;assert.equal(client.isRequested('peer',id),false)
})
test('history request queues and retries are bounded',()=>{
 let now=1000,sends=0
 const h=new HistorySync({now:()=>now,send:()=>{sends++;return true},known:()=>false,getPacket:()=>null,receive:async()=>{}})
 for(let n=0;n<100;n++)h.request('peer','ps:'+n.toString(16).padStart(64,'0'))
 assert.equal(h.pending.size,4)
 for(let n=0;n<100;n++){h.tick();now+=5001}
 assert.equal(h.pending.size,0);assert.equal(sends,16)
})
test('queued validation exceptions settle callers and release concurrency',async()=>{
 const gate=new ValidationGate({maxGlobal:1,maxPerPeer:1});let release
 const first=gate.run('peer',()=>new Promise(r=>{release=r}))
 const second=gate.run('peer',async()=>{throw Error('failed')})
 release({ok:true});await first
 assert.equal((await second).code,'peer-validation-failed');assert.equal(gate.active,0)
})
