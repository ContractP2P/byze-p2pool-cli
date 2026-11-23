'use strict'

// Regression for #2 / #3: exercise the real deferred queue and retry loop.
// This is a deterministic unit test, NOT a live byzed outage soak test.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { MinerApp, loadPolicy } = require('../src/byze-p2pool')

const TRANSIENT = ['miningPayoutValidationUnavailable', 'miningPayoutValidationBusy']
const PEER = 'ab'.repeat(32)

function harness() {
  const policy = loadPolicy(path.join(__dirname, '../config/pool-policy.json'))
  const app = new MinerApp({
    alias: 'retry-test', wallet: 'byz1testaddress000000', threads: 1,
    policy, byze: { call: async () => { throw new Error('offline') } }, noSubmit: true
  })
  // Only the result of full validation is simulated; queueing/retries are real.
  const outcomes = []
  const attempts = { local: 0, pool: 0 }
  let online = false
  app.validationGate.run = async (_peer, fn) => fn()
  app.acceptLocalShare = async () => {
    attempts.local++
    return online ? { ok: true, duplicate: false } : { ok: false, code: TRANSIENT[0] }
  }
  app.acceptPoolShare = async () => {
    attempts.pool++
    return online ? { ok: true, duplicate: false } : { ok: false, code: TRANSIENT[1] }
  }
  app.recordRemoteOutcome = (kind, packet, outcome) => outcomes.push({ kind, id: packet.share.shareId || packet.share.poolShareId, outcome })
  return { app, attempts, outcomes, restore: () => { online = true } }
}

test('deferred local and pool shares survive transient RPC failures and recover exactly once', async () => {
  const { app, attempts, outcomes, restore } = harness()
  const local = { share: { shareId: 'ls:' + '11'.repeat(32) } }
  const pool = { share: { poolShareId: 'ps:' + '22'.repeat(32) } }
  assert.equal(app.deferContext('local', PEER, local), true)
  assert.equal(app.deferContext('pool', PEER, pool), true)
  // Trigger retries without waiting for wall-clock timers.
  for (const map of [app.deferredLocalShares, app.deferredPoolShares])
    for (const rec of map.values()) rec.retryAt = 0
  await app.retryDeferredContext()
  assert.equal(app.deferredLocalShares.size, 1)
  assert.equal(app.deferredPoolShares.size, 1)
  assert.deepEqual(outcomes, [])
  assert.deepEqual(attempts, { local: 1, pool: 1 })

  restore()
  for (const map of [app.deferredLocalShares, app.deferredPoolShares])
    for (const rec of map.values()) rec.retryAt = 0
  await app.retryDeferredContext()
  assert.equal(app.deferredLocalShares.size, 0)
  assert.equal(app.deferredPoolShares.size, 0)
  assert.deepEqual(outcomes.map(x => [x.kind, x.outcome]).sort(), [['local', 'accepted'], ['pool', 'accepted']])
  await app.retryDeferredContext()
  assert.deepEqual(attempts, { local: 2, pool: 2 }, 'drained shares must not be retried')
  assert.equal(outcomes.length, 2, 'no double-accounting')
})

test('expired deferred shares are dropped rather than accepted after recovery', async () => {
  const { app, attempts, outcomes, restore } = harness()
  const packet = { share: { shareId: 'ls:' + '33'.repeat(32) } }
  assert.equal(app.deferContext('local', PEER, packet), true)
  const rec = app.deferredLocalShares.get(packet.share.shareId)
  rec.retryAt = 0
  rec.firstSeen = Date.now() - 121_000
  restore()
  await app.retryDeferredContext()
  assert.equal(app.deferredLocalShares.size, 0)
  assert.equal(attempts.local, 0)
  assert.deepEqual(outcomes, [])
  assert.equal(app.pplnsHistoryIncomplete,true,'expired unknown history must hold submission')
})

test('outage pauses native mining and advertises PAUSED; fresh job resumes once', async () => {
  const { app } = harness()
  const announcements = []
  app.running = true
  app.peerKey = PEER
  app.transport = { broadcast: msg => { announcements.push(msg.announcement); return true } }
  app.nodeMiningReady = true
  app.workerState.hashrate = 1400
  app.currentJob = { id:'rxj:'+'1'.repeat(64) }
  let pauses = 0, restarts = 0
  app.supervisor.pauseMining = () => { pauses++ }
  app.supervisor.setJob = () => { restarts++ }

  app.pauseForNodeFailure(new Error('getblocktemplate: Could not connect to the server'))
  assert.equal(pauses, 1)
  assert.equal(app.nodeMiningReady, false)
  assert.equal(app.currentJob, null)
  assert.equal(app.workerState.hashrate, 0)
  assert.equal(app.members()[0].miningState, 'PAUSED')
  assert.equal(app.selfPresence().telemetry.hashrateHps, 0)
  assert.equal(announcements.at(-1).miningState, 'PAUSED')

  app.pauseForNodeFailure(new Error('getblocktemplate: error code: -28 Loading block index'))
  assert.equal(pauses, 1, 'repeat failures should not restart pause or spam announcements')
  assert.equal(announcements.length, 1)
  app.activateMiningJob({id:'rxj:'+'2'.repeat(64),templateHash:'3'.repeat(64)})
  assert.equal(restarts, 1)
  assert.equal(app.nodeMiningReady, true)
  assert.equal(app.nodePauseReason, '')
  assert.equal(app.members()[0].miningState, 'MINING')
  assert.equal(announcements.at(-1).miningState, 'MINING')
  assert.equal(announcements.length, 2)
})

test('outage poll is serialized, never invokes argument-free GBT, and remains paused', async () => {
  const { app } = harness()
  let calls = []
  app.supervisor.pauseMining = () => {}
  app.byze.call = async (method, params=[]) => {
    calls.push({method,params})
    if(method==='getblockchaininfo')
      return {chain:'main',initialblockdownload:false,blocks:21113,headers:21113}
    throw new Error('error code: -28 Loading block index')
  }
  await assert.rejects(app.refreshJob(),/Loading block index/)
  assert.equal(app.nodeMiningReady,false)
  assert.deepEqual(calls.map(x=>x.method),['getblockchaininfo','getblocktemplate'])
  assert.deepEqual(calls[1].params,[{rules:['segwit']}])
  assert.equal(app.shortNodeIssue(new Error('error code: -28 Loading block index')),'node-initializing')
  assert.equal(app.shortNodeIssue(new Error('Could not connect to the server')),'rpc-unreachable')

  let unblock
  calls = []
  app.byze.call=async method=>{
    calls.push(method)
    await new Promise(resolve=>{ unblock=resolve })
    throw new Error('temporarily offline')
  }
  const pending=app.refreshJob()
  const overlapping=app.refreshJob(true)
  assert.equal(calls.length,1,'overlapping job refreshes must share the same RPC request')
  unblock()
  await assert.rejects(pending,/temporarily offline/)
  await assert.rejects(overlapping,/temporarily offline/)
  assert.equal(calls.length,1)
})

test('native supervisor halts miner, rejects late verified shares, and restarts on a fresh job',async()=>{
  const {Supervisor}=require('../src/mining/native-bridge')
  const sup=new Supervisor()
  const job={
    id:'rxj:'+'a'.repeat(64),templateHash:'b'.repeat(64),
    jobCommitmentHash:'c'.repeat(64),feePolicyHash:'d'.repeat(64),
    template:{target:'f'.repeat(64),previousblockhash:'e'.repeat(64),height:21114}
  }
  sup.job=job
  let killed=0
  sup.miner={kill:()=>{killed++},pid:12345}
  sup.hashrate=1300
  let finishVerify
  sup.verifier.verify=()=>new Promise(resolve=>{finishVerify=resolve})
  const share=sup.handleStratum({id:7,method:'mining.submit',
    params:['worker','aa'.repeat(80),job.id,'bb'.repeat(80)]})
  await Promise.resolve()
  assert.equal(typeof finishVerify,'function')
  sup.pauseMining()
  assert.equal(killed,1)
  assert.equal(sup.job,null)
  assert.equal(sup.miningPaused,true)
  assert.equal(sup.status().hashrate,0)
  assert.equal(sup.status().running,false)
  finishVerify('00'.repeat(32))
  await share
  assert.equal(sup.accepted,0,'old in-flight share must never be credited')

  let spawned=0
  sup.startMiner=function(){ spawned++; this.miner={pid:12346,kill:()=>{}} }
  sup.sendJob=()=>true
  sup.setJob(job)
  assert.equal(spawned,1)
  assert.equal(sup.miningPaused,false)
  assert.equal(sup.status().running,true)
  assert.equal(sup.job.id,job.id)
})

test('forced PPLNS refresh is not discarded while an RPC poll is in flight',async()=>{
  const {app}=harness()
  app.running=true
  app.supervisor.pauseMining=()=>{}
  let unblock, calls=0
  app.byze.call=async method=>{
    assert.equal(method,'getblockchaininfo')
    calls++
    if(calls===1) await new Promise(resolve=>{unblock=resolve})
    throw new Error('RPC not ready')
  }
  const first=app.refreshJob()
  const forced=app.refreshJob(true)
  assert.equal(calls,1)
  unblock()
  await assert.rejects(first,/RPC not ready/)
  await assert.rejects(forced,/RPC not ready/)
  await new Promise(resolve=>setImmediate(resolve))
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(calls,2,'queued forced refresh must run after the first poll')
  assert.equal(app.jobRefreshForcePending,false)
  app.running=false
})


test('deferred local and PoolShare retries keep original receipt timestamps',async()=>{
  const {app}=harness()
  const receipt=Date.now()-35_000
  const local={share:{shareId:'ls:'+'44'.repeat(32),epoch:1234}}
  const pool={share:{poolShareId:'ps:'+'55'.repeat(32)},checkpoint:{epoch:1235}}

  assert.equal(app.deferContext('local',PEER,local,{receivedAt:receipt,code:'pplns-context-unknown'}),true)
  assert.equal(app.deferContext('pool',PEER,pool,{receivedAt:receipt,code:'consensus-context-unknown'}),true)

  // Replays of a pending packet must not reset its original validation clock.
  assert.equal(app.deferContext('local',PEER,local,{receivedAt:Date.now()}),true)
  assert.equal(app.deferredLocalShares.get(local.share.shareId).receivedAt,receipt)
  assert.equal(app.deferredLocalShares.get(local.share.shareId).reason,'pplns-context-unknown')
  assert.equal(app.deferredPoolShares.get(pool.share.poolShareId).receivedAt,receipt)

  const observed=[]
  app.acceptLocalShare=async (_peer,_packet,options)=>{observed.push(['local',options.receivedAt]);return {ok:true,duplicate:false}}
  app.acceptPoolShare=async (_peer,_packet,options)=>{observed.push(['pool',options.receivedAt]);return {ok:true,duplicate:false}}
  for(const records of [app.deferredLocalShares,app.deferredPoolShares])
    for(const rec of records.values())rec.retryAt=0
  await app.retryDeferredContext()
  assert.deepEqual(observed.sort(),[['local',receipt],['pool',receipt]])
  assert.equal(app.deferredLocalShares.size,0)
  assert.equal(app.deferredPoolShares.size,0)
})

test('only deferred proofs of the closing epoch block its checkpoints',()=>{
  const {app}=harness()
  const local={share:{shareId:'ls:'+'66'.repeat(32),epoch:100}}
  const pool={share:{poolShareId:'ps:'+'77'.repeat(32)},checkpoint:{epoch:101}}
  assert.equal(app.deferContext('local',PEER,local),true)
  assert.equal(app.deferContext('pool',PEER,pool),true)
  assert.equal(app.hasDeferredForEpoch(100),true)
  assert.equal(app.hasDeferredForEpoch(101),true)
  assert.equal(app.hasDeferredForEpoch(102),false,
    'old unresolved shares must not prevent all later epoch checkpoints')
  assert.equal(app.hasDeferredForEpoch(-1),true)
})

test('a valid share can age across two epochs while awaiting PPLNS context',()=>{
  const {RANDOMX_PROOF_MODE,buildRandomxLocalShare,validateRandomxEnvelope,
    targetFromCompactBits,shareTargetFromNetworkTarget}=require('../src/mining/p2pool-randomx')
  const receivedAt=1000*60_000+20_000
  const networkTarget=targetFromCompactBits('1d00ffff')
  const shareTarget=shareTargetFromNetworkTarget(networkTarget,256)
  const built=buildRandomxLocalShare({
    contractHash:'aa'.repeat(32),poolId:'byze-main-p2pool-v1',cellId:'cell-1',
    epoch:1000,minerPeerId:PEER,payoutAddress:'byz1ptestaddress12345678',
    jobId:'rxj:'+'bb'.repeat(32),nonce:0,powHash:'00'.repeat(32),
    createdAt:receivedAt,shareTarget
  })
  assert.equal(built.ok,true,built.code)
  const header=Buffer.alloc(80)
  header.writeUInt32LE(Number.parseInt('1d00ffff',16),72)
  const packet={proofMode:RANDOMX_PROOF_MODE,share:built.share,signature:'pending',proof:{
    header80:header.toString('hex'),networkTarget,shareTarget,
    previousBlockHash:'cc'.repeat(32),templateHash:'dd'.repeat(32),height:25056,
    difficultyMultiplier:256,blockCandidate:true,jobCommitmentHash:'ee'.repeat(32),
    feePolicyHash:'ff'.repeat(32),pplnsTipId:'',coinbaseValue:'5000000000',
    coinbaseNoWitnessHex:'11'.repeat(20),coinbaseMerkleBranch:[]
  }}
  const initial=validateRandomxEnvelope(packet,{now:receivedAt+1000,epochMs:60_000})
  assert.equal(initial.ok,true,initial.code)
  const retryNow=receivedAt+121_000
  const expiredEpoch=validateRandomxEnvelope(packet,{now:retryNow,epochMs:60_000})
  assert.equal(expiredEpoch.code,'miningRandomxShareEpochInvalid')
  // The real signature, coinbase binding, chain context and PPLNS fork checks
  // still run in acceptLocalShare; only its temporal reference is retained.
  const anchored=validateRandomxEnvelope(packet,{now:receivedAt+1000,epochMs:60_000})
  assert.equal(anchored.ok,true,anchored.code)
})

test('candidate submission fails closed after an unresolved deferred proof is lost',async()=>{
  const {app}=harness()
  app.nodeMiningReady=true
  app.submitBlocks=true
  app.pplnsHistoryIncomplete=true
  let rpcCalls=0
  app.byze.call=async()=>{rpcCalls++;throw Error('unexpected RPC')}
  await app.publishCandidate({blockCandidate:true})
  assert.equal(rpcCalls,0,'candidate must be held before RPC proposal/submission')
})
