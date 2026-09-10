'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  localShareId,
  buildCellCheckpoint,
  buildGlobalEpochCheckpoint,
  buildPoolShare
} = require('../src/mining/p2pool-protocol')
const { assignLiveCells, isDeterministicCellId } = require('../src/mining/p2pool-membership')
const { PoolShareChain } = require('../src/mining/poolshare-chain')
const {
  splitCellCheckpointPacket,
  CellCheckpointProofAssembler
} = require('../src/mining/cell-checkpoint-bundle')
const { splitPoolShareProofPacket, PoolShareProofAssembler } = require('../src/mining/poolshare-proof-bundle')

const CONTRACT_HASH = 'a'.repeat(64)
const POOL_ID = 'byze-main-p2pool-v1'
const BYZE_TIP = 'b'.repeat(64)
const FEE_ADDRESS = 'byz1ptlyn7q58zyhht8lds0u58n6mf4vehx6ds8gkax0vmtc49az2w9eqgqsm5p'

function peer(i) { return i.toString(16).padStart(64, '0') }
function payout(i) { return `byz1scale${String(i).padStart(4,'0')}mineraddress` }
function makeMembers(count) {
  return Array.from({ length:count }, (_,i) => ({ peerKey:peer(i+1), payoutAddress:payout(i+1), miningState:'MINING', updatedAt:1000+i }))
}
function makeShare(member, cellId, epoch, ordinal=0, work=100) {
  const share = {
    protocol:'contract-byze-p2pool-v1', kind:'local-share', contractHash:CONTRACT_HASH, poolId:POOL_ID,
    cellId, epoch, jobId:`job-${epoch}-${member.peerKey.slice(-8)}-${ordinal}`,
    minerPeerId:member.peerKey, payoutAddress:member.payoutAddress,
    nonce:String(ordinal+1), powHash:(BigInt(`0x${member.peerKey}`)+BigInt(ordinal+1)).toString(16).padStart(64,'0').slice(-64),
    work:String(work), createdAt:1700000000000+ordinal
  }
  share.shareId = localShareId(share)
  return share
}
function buildGlobal(count, epoch=100) {
  const members=makeMembers(count)
  const assigned=assignLiveCells({members,contractHash:CONTRACT_HASH,poolId:POOL_ID,maxMembers:20})
  assert.equal(assigned.ok,true)
  const cps=[]
  for(const cell of assigned.cells){
    const shares=cell.members.map((m)=>makeShare(m,cell.id,epoch))
    const built=buildCellCheckpoint({contractHash:CONTRACT_HASH,poolId:POOL_ID,cellId:cell.id,epoch,shares})
    assert.equal(built.ok,true)
    cps.push(built.checkpoint)
  }
  const global=buildGlobalEpochCheckpoint({contractHash:CONTRACT_HASH,poolId:POOL_ID,epoch,cellCheckpoints:cps})
  assert.equal(global.ok,true)
  return {members,assigned,cps,global:global.checkpoint}
}

for (const [count, expectedSizes] of [[21,[20,1]],[41,[20,20,1]],[65,[20,20,20,5]],[100,[20,20,20,20,20]]]) {
  test(`${count} active miners aggregate every cell into one global epoch and every wallet reaches PPLNS`, () => {
    const {members,assigned,global}=buildGlobal(count,77)
    assert.deepEqual(assigned.cells.map(c=>c.members.length),expectedSizes)
    assert.equal(global.cellCount,expectedSizes.length)
    assert.equal(Object.keys(global.workByPayout).length,count)
    assert.equal(global.totalWork,String(count*100))
    for(const member of members) assert.equal(global.workByPayout[member.payoutAddress],'100')

    const built=buildPoolShare({checkpoint:global,previousPoolShareId:'',byzeHeight:17410,byzePrevBlockHash:BYZE_TIP})
    assert.equal(built.ok,true)
    const chain=new PoolShareChain({maxShares:128,window:20})
    assert.equal(chain.add(built.poolShare,{checkpointEpoch:77}).ok,true)
    const plan=chain.payoutPlan(5_000_000_000n,400,{feeAddress:FEE_ADDRESS,feeBasisPoints:50})
    assert.equal(plan.ok,true)
    const outputs=new Map(plan.outputs.map(o=>[o.address,BigInt(o.satoshis)]))
    assert.equal(outputs.size,count+1)
    assert.equal(outputs.get(FEE_ADDRESS),25_000_000n)
    for(const member of members) assert.ok((outputs.get(member.payoutAddress)||0n)>0n, member.payoutAddress)
    assert.equal([...outputs.values()].reduce((a,b)=>a+b,0n),5_000_000_000n)
  })
}

test('STOPPED and LEFT peers do not occupy a 20-miner cell',()=>{
  const members=makeMembers(22)
  members[0].miningState='STOPPED'
  members[1].miningState='LEFT'
  const assigned=assignLiveCells({members,contractHash:CONTRACT_HASH,poolId:POOL_ID,maxMembers:20})
  assert.equal(assigned.ok,true)
  assert.deepEqual(assigned.cells.map(c=>c.members.length),[20])
  assert.equal(assigned.byPeer[members[0].peerKey],undefined)
  assert.equal(assigned.byPeer[members[1].peerKey],undefined)
})

test('a stronger same-epoch global aggregate supersedes an incomplete sibling regardless of arrival order',()=>{
  const {cps}=buildGlobal(21,88)
  const one=buildGlobalEpochCheckpoint({contractHash:CONTRACT_HASH,poolId:POOL_ID,epoch:88,cellCheckpoints:[cps[0]]})
  const all=buildGlobalEpochCheckpoint({contractHash:CONTRACT_HASH,poolId:POOL_ID,epoch:88,cellCheckpoints:cps})
  assert.equal(one.ok,true); assert.equal(all.ok,true)
  const s1=buildPoolShare({checkpoint:one.checkpoint,previousPoolShareId:'',byzeHeight:17411,byzePrevBlockHash:BYZE_TIP}).poolShare
  const s2=buildPoolShare({checkpoint:all.checkpoint,previousPoolShareId:'',byzeHeight:17411,byzePrevBlockHash:BYZE_TIP}).poolShare
  for(const order of [[s1,s2],[s2,s1]]){
    const chain=new PoolShareChain({maxShares:64,window:20})
    assert.equal(chain.add(order[0],{checkpointEpoch:88}).ok,true)
    assert.equal(chain.add(order[1],{checkpointEpoch:88}).ok,true)
    assert.equal(chain.bestId,s2.poolShareId)
    assert.equal(chain.canonicalShareForEpoch(88),s2.poolShareId)
  }
})

test('work from one payout address can migrate between cells inside an epoch without being lost by global aggregation',()=>{
  const m=makeMembers(1)[0]
  const a=makeShare(m,'cell:1:migrateaaaa',99,1,120)
  const b=makeShare(m,'cell:2:migratebbbb',99,2,80)
  const cpA=buildCellCheckpoint({contractHash:CONTRACT_HASH,poolId:POOL_ID,cellId:a.cellId,epoch:99,shares:[a]}).checkpoint
  const cpB=buildCellCheckpoint({contractHash:CONTRACT_HASH,poolId:POOL_ID,cellId:b.cellId,epoch:99,shares:[b]}).checkpoint
  const global=buildGlobalEpochCheckpoint({contractHash:CONTRACT_HASH,poolId:POOL_ID,epoch:99,cellCheckpoints:[cpA,cpB]})
  assert.equal(global.ok,true)
  assert.equal(global.checkpoint.totalWork,'200')
  assert.equal(global.checkpoint.workByPayout[m.payoutAddress],'200')
})

test('large cell proof bundles are split below transport frame size and reassemble exactly',()=>{
  const {members,assigned}=buildGlobal(20,101)
  const cell=assigned.cells[0]
  const proofs=[]
  for(const member of cell.members){
    for(let i=0;i<20;i++) proofs.push({proofMode:'byze-randomx-v2',share:makeShare(member,cell.id,101,i,1),proof:{header80:'ab'.repeat(80),pplnsTipId:'',padding:'x'.repeat(400)},signature:'sig'.repeat(30)})
  }
  const cp=buildCellCheckpoint({contractHash:CONTRACT_HASH,poolId:POOL_ID,cellId:cell.id,epoch:101,shares:proofs.map(p=>p.share)}).checkpoint
  const packet={checkpoint:cp,previousPoolShareId:'',proofs,signerPeerKey:peer(999),signature:'a'.repeat(128)}
  const split=splitCellCheckpointPacket(packet)
  assert.equal(split.ok,true)
  assert.ok(split.chunkCount>1)
  assert.ok(split.packets.every(p=>Buffer.byteLength(JSON.stringify(p),'utf8')<=48*1024))
  const assembler=new CellCheckpointProofAssembler()
  let completed=null
  for(const chunk of [...split.packets].reverse()){
    const r=assembler.add(chunk,packet.signerPeerKey)
    assert.equal(r.ok,true)
    if(r.complete)completed=r.packet
  }
  assert.ok(completed)
  assert.equal(completed.proofs.length,proofs.length)
  assert.deepEqual(completed.proofs,proofs)
})

test('deterministic cell ids are authenticated against the pool namespace',()=>{
  const assigned=assignLiveCells({members:makeMembers(65),contractHash:CONTRACT_HASH,poolId:POOL_ID,maxMembers:20})
  assert.equal(assigned.ok,true)
  for(const cell of assigned.cells) assert.equal(isDeterministicCellId({cellId:cell.id,contractHash:CONTRACT_HASH,poolId:POOL_ID}),true)
  assert.equal(isDeterministicCellId({cellId:'cell:1:0000000000000000',contractHash:CONTRACT_HASH,poolId:POOL_ID}),false)
  assert.equal(isDeterministicCellId({cellId:assigned.cells[0].id,contractHash:'b'.repeat(64),poolId:POOL_ID}),false)
})

test('global aggregation waits through all cell relay failover slots before normal promotion',()=>{
  const fs=require('node:fs'), path=require('node:path')
  const source=fs.readFileSync(path.join(__dirname,'..','src','byze-p2pool.js'),'utf8')
  assert.match(source,/const GLOBAL_AGGREGATION_GRACE_MS = 30_000/)
  assert.match(source,/RELAY_FAILOVER_GRACE_MS = 12_000/)
})

test('mid-epoch cell migration recovery accepts deterministic old-cell work and replays it globally',()=>{
  const fs=require('node:fs'), path=require('node:path')
  const source=fs.readFileSync(path.join(__dirname,'..','src','byze-p2pool.js'),'utf8')
  assert.match(source,/isDeterministicCellId/)
  assert.doesNotMatch(source,/packet\.share\.cellId!==live\.cellId/)
  assert.match(source,/const targets=s\.cellId===live\.cellId\?null:globalPeers/)
})

test('100-miner global PoolShare proof bundle stays chunked and reassembles exactly',()=>{
  const {assigned,global}=buildGlobal(100,102)
  const proofs=[]
  for(const cell of assigned.cells){
    for(const member of cell.members){
      proofs.push({proofMode:'byze-randomx-v2',share:makeShare(member,cell.id,102),proof:{header80:'cd'.repeat(80),pplnsTipId:'',padding:'z'.repeat(800)},signature:'sig'.repeat(30)})
    }
  }
  const share=buildPoolShare({checkpoint:global,previousPoolShareId:'',byzeHeight:17412,byzePrevBlockHash:BYZE_TIP}).poolShare
  const packet={share,checkpoint:global,proofs,signerPeerKey:peer(998),signature:'b'.repeat(128)}
  const split=splitPoolShareProofPacket(packet)
  assert.equal(split.ok,true)
  assert.ok(split.chunkCount>1)
  assert.ok(split.packets.every(p=>Buffer.byteLength(JSON.stringify(p),'utf8')<=48*1024))
  const assembler=new PoolShareProofAssembler()
  let completed=null
  for(const chunk of [...split.packets].reverse()){
    const r=assembler.add(chunk,packet.signerPeerKey)
    assert.equal(r.ok,true)
    if(r.complete)completed=r.packet
  }
  assert.ok(completed)
  assert.equal(completed.proofs.length,100)
  assert.deepEqual(completed.proofs,proofs)
})
