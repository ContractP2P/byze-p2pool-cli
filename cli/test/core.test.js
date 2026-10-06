'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const { createPoolFeePolicy, loadPoolFeePolicy } = require('../src/mining/pool-fee-policy')
const { calculateDirectPayouts, buildCellCheckpoint, buildPoolShare } = require('../src/mining/p2pool-protocol')
const { PoolShareChain } = require('../src/mining/poolshare-chain')
const { presenceSigningPayload } = require('../src/mining/p2pool-membership')
const { satoshisToByze, coinsToSatoshis, sumPayoutFromVouts } = require('../src/reward-telemetry')

const feeAddress = 'byz1ptlyn7q58zyhht8lds0u58n6mf4vehx6ds8gkax0vmtc49az2w9eqgqsm5p'

test('pool policy is fixed at 0.5% and commits the fee address', () => {
  const p = createPoolFeePolicy({poolId:'byze-main-p2pool-v1',feeBasisPoints:50,feeAddress})
  assert.equal(p.ok, true)
  assert.equal(p.feeBasisPoints, 50)
  assert.equal(p.policyHash, 'fa349d33253d2949a7050913115575ede3c4b2f5b62bb2a3228ce73212f20e08')
  const other = createPoolFeePolicy({poolId:'byze-main-p2pool-v1',feeBasisPoints:50,feeAddress:'byz1otheraddress000000000000000000000000000000000000000000000000'})
  assert.equal(other.ok, true)
  assert.notEqual(other.policyHash, p.policyHash)
})

test('complete CLI falls back to the official fee address if local policy config is missing',()=>{
  const missing=path.join(require('os').tmpdir(),`missing-pool-policy-${process.pid}-${Date.now()}.json`)
  const p=loadPoolFeePolicy({filePath:missing,env:{}})
  assert.equal(p.ok,true)
  assert.equal(p.feeBasisPoints,50)
  assert.equal(p.feeAddress,feeAddress)
  assert.equal(p.policyHash,'fa349d33253d2949a7050913115575ede3c4b2f5b62bb2a3228ce73212f20e08')
})

test('direct payout conserves reward and takes exactly 0.5%', () => {
  const poolShares=[{kind:'pool-share',poolShareId:'ps:'+ '1'.repeat(64),work:'100',payoutWeights:{byz1alice000:'75',byz1bob00000:'25'}}]
  const r=calculateDirectPayouts({poolShares,rewardSatoshis:5_000_000_000n,maxOutputs:400,feeAddress,feeBasisPoints:50})
  assert.equal(r.ok,true)
  assert.equal(r.feeSatoshis,'25000000')
  assert.equal(r.minerSatoshis,'4975000000')
  assert.equal(r.outputs.reduce((s,x)=>s+BigInt(x.satoshis),0n),5_000_000_000n)
})

test('presence signing payload contains current fee consensus fields', () => {
  const p=presenceSigningPayload({peerKey:'1'.repeat(64),alias:'Eric',instanceId:'cfi1:00000000-0000-4000-8000-000000000000',contractId:'org.contract.byze-p2pool',version:'0.1.2',publisherKey:'2'.repeat(64),sourceHash:'3'.repeat(64),poolId:'byze-main-p2pool-v1',payoutAddress:'byz1eric0000',miningState:'MINING',updatedAt:1000,expiresAt:91000,seq:1,feePolicyHash:'4'.repeat(64),feeBasisPoints:50,feeAddress})
  assert.equal(p.feeBasisPoints,50)
  assert.equal(p.feeAddress,feeAddress)
  assert.equal(p.feePolicyHash,'4'.repeat(64))
})

test('PoolShareChain computes a bounded PPLNS window', () => {
  const chain=new PoolShareChain({window:20,maxShares:64})
  let prev=''
  for(let i=0;i<25;i++){
    const cp={protocol:'contract-byze-p2pool-v1',kind:'cell-checkpoint',checkpointId:'cp:'+crypto.createHash('sha256').update('cp'+i).digest('hex'),contractHash:'a'.repeat(64),poolId:'byze-main-p2pool-v1',cellId:'cell:1:0123456789abcdef',epoch:i,shareCount:1,shareRoot:'b'.repeat(64),totalWork:'10',workByMiner:{['c'.repeat(64)]:'10'},workByPayout:{byz1alice000:'10'}}
    const built=buildPoolShare({checkpoint:cp,previousPoolShareId:prev,byzeHeight:100+i,byzePrevBlockHash:'d'.repeat(64)})
    assert.equal(built.ok,true)
    const added=chain.add(built.poolShare,{local:true})
    assert.equal(added.ok,true)
    prev=built.poolShare.poolShareId
  }
  assert.equal(chain.bestWindow().length,20)
})

test('unchanged consensus modules remain byte-identical to Contract v0.15.80; P0 modules intentionally diverge', () => {
  const src=process.env.CONTRACT_SRC
  if(!src)return
  for(const name of ['p2pool-protocol.js','poolshare-proof-bundle.js','direct-coinbase.js','pool-fee-policy.js']){
    const a=fs.readFileSync(path.join(__dirname,'..','src','mining',name))
    const b=fs.readFileSync(path.join(src,'mining',name))
    assert.deepEqual(a,b,name)
  }
  for(const name of ['p2pool-randomx.js','poolshare-chain.js','p2pool-membership.js','byze-block-publisher.js']){
    const a=fs.readFileSync(path.join(__dirname,'..','src','mining',name))
    const b=fs.readFileSync(path.join(src,'mining',name))
    assert.notDeepEqual(a,b,`${name} must contain the secure-v2 P0 changes`)
  }
})

test('v0.1.4 formats BYZE rewards without floating point consensus math', () => {
  assert.equal(satoshisToByze(1_773_840_000n), '17.7384')
  assert.equal(satoshisToByze(50_000_000n), '0.5')
  assert.equal(coinsToSatoshis('17.73840000'), 1_773_840_000n)
  assert.equal(coinsToSatoshis(17.7384), 1_773_840_000n)
})

test('v0.1.4 detects a direct coinbase payout to the miner address', () => {
  const payoutAddress='byz1miner000000000000000000000000000000000000000000000000000000'
  const payoutScript='0014aabbccdd'
  const satoshis=sumPayoutFromVouts([
    {value:17.7384,scriptPubKey:{address:payoutAddress,hex:payoutScript}},
    {value:0.25,scriptPubKey:{address:'byz1other00000000000000000000000000000000000000000000000000000',hex:'0014eeee'}}
  ],payoutAddress,payoutScript)
  assert.equal(satoshis,1_773_840_000n)
})

test('v0.1.7 console UI is English-only, compact and hides internal payout estimate details', () => {
  const { launchPresentation, statusLine, rewardCelebration, MINING_SUCCESS_BANNER } = require('../src/console-ui')
  const intro=launchPresentation({version:'0.1.7',alias:'Mac01',peerKey:'abc...123',wallet:'byz1...s04',poolId:'byze-main-p2pool-v1',feeBasisPoints:50,feeAddress:'byz1fee...abc',threads:6,nodeChain:'main',nodeHeight:17155,topic:'b7a...d02'})
  assert.match(intro,/██████████████/)
  assert.match(intro,/CLI 0\.1\.7   Mac01/)
  assert.match(intro,/Peer       abc\.\.\.123 \(temporary\)/)
  assert.match(intro,/Pool       byze-main-p2pool-v1 \| fee 0\.50%/)
  assert.match(intro,/CPU        6 thread\(s\) RandomX/)
  assert.match(intro,/Node       main \| height 17155/)
  const line=statusLine({time:'21:58:10',localHashrate:'1.24 kH/s',minerCount:2,poolHashrate:'~3.31 kH/s',localShares:24,remoteAccepted:7,remotePending:2,remoteRejected:0,droppedStale:1,forkCount:1,reorgCount:2,sessionByze:'0'})
  assert.equal(line,'21:58:10 | RandomX 1.24 kH/s | Pool 2 miner(s) · ~3.31 kH/s | Shares 24 | Remote A/P/R 7/2/0 | Stale 1 | Forks 1 · Reorgs 2 | Session +0 BYZE')
  assert.doesNotMatch(line,/PPLNS 20\/20|Est\. next reward|Height #|Gain si bloc|mineur\(s\)/)
  assert.doesNotMatch(intro,/Fee wallet/)
  assert.ok(MINING_SUCCESS_BANNER.length > 6000)
  const win=rewardCelebration({amountByze:'17.7384',height:17170,sessionByze:'17.7384',alias:'Mac01'})
  assert.match(win,/17\.7384 BYZE/)
  assert.match(win,/BYZE block #17170/)
  assert.match(win,/Session earnings: 17\.7384 BYZE/)
  assert.doesNotMatch(win,/Bloc BYZE|Gains de la session/)
})

test('secure-v2 can reconstruct payout plan at the exact historical PPLNS tip',()=>{
  const chain=new PoolShareChain({window:20,maxShares:64})
  let prev='',tip1=''
  for(let i=0;i<3;i++){
    const share={kind:'pool-share',poolShareId:'ps:'+crypto.createHash('sha256').update('tip'+i).digest('hex'),previousPoolShareId:prev,checkpointId:'cp:'+crypto.createHash('sha256').update('cptip'+i).digest('hex'),contractHash:'a'.repeat(64),poolId:'byze-main-p2pool-v1',cellId:'cell:1:0123456789abcdef',byzeHeight:100+i,byzePrevBlockHash:'b'.repeat(64),work:'100',payoutWeights:{[i===0?'byz1alice000':'byz1bob00000']:'100'}}
    assert.equal(chain.add(share,{local:true}).ok,true);prev=share.poolShareId;if(i===0)tip1=prev
  }
  const policy={feeAddress,feeBasisPoints:50}
  const old=chain.payoutPlanAt(tip1,5_000_000_000n,400,policy)
  const now=chain.payoutPlan(5_000_000_000n,400,policy)
  assert.equal(old.ok,true);assert.equal(now.ok,true)
  assert.notDeepEqual(old.outputs,now.outputs)
  assert.equal(old.outputs.reduce((s,r)=>s+BigInt(r.satoshis),0n),5_000_000_000n)
})

test('secure-v2 selects the deterministic PPLNS tip strictly before the share epoch',()=>{
  const chain=new PoolShareChain({window:20,maxShares:64})
  let prev=''
  const ids=[]
  for(let epoch=10;epoch<=12;epoch++){
    const share={kind:'pool-share',poolShareId:'ps:'+crypto.createHash('sha256').update('epoch-tip-'+epoch).digest('hex'),previousPoolShareId:prev,checkpointId:'cp:'+crypto.createHash('sha256').update('epoch-cp-'+epoch).digest('hex'),contractHash:'a'.repeat(64),poolId:'byze-main-p2pool-v1',cellId:'cell:1:0123456789abcdef',byzeHeight:100+epoch,byzePrevBlockHash:'b'.repeat(64),work:'100',payoutWeights:{byz1alice000:'100'}}
    assert.equal(chain.add(share,{local:true,checkpointEpoch:epoch}).ok,true)
    prev=share.poolShareId;ids.push(share.poolShareId)
  }
  assert.equal(chain.tipBeforeEpoch(10),'')
  assert.equal(chain.tipBeforeEpoch(11),ids[0])
  assert.equal(chain.tipBeforeEpoch(12),ids[1])
  assert.equal(chain.tipBeforeEpoch(13),ids[2])
})
