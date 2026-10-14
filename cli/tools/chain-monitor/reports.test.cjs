'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const crypto=require('node:crypto')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const core=require('./core.cjs')
const report=require('./reports.cjs')
const {verifiedAttributions,eligibleBlock}=require('./block-proof.cjs')
const obs=require('./observe-p2p.cjs')
const {presenceSigningPayload,canonical}=require('../../src/mining/p2pool-membership')
const ID=require('../../src/byze-p2pool.js')
const {createPoolFeePolicy}=require('../../src/mining/pool-fee-policy')

const fee=core.policy.feeAddress
const PAY_A='byz1'+'q'.repeat(50)+'a'
const PAY_B='byz1'+'r'.repeat(50)+'b'
const hash='a'.repeat(64),txid='b'.repeat(64)

function fixture() {
  return core.evaluateBlock({height:1234,hash,time:1792000000}, {
    vin:[{coinbase:'010203'}],txid,
    vout:[
      {value:'0.25',scriptPubKey:{address:fee}},
      {value:'25',scriptPubKey:{address:PAY_A}},
      {value:'24.75',scriptPubKey:{address:PAY_B}},
      {value:'0',scriptPubKey:{hex:'6a'}},
    ]})
}
test('block report masks wallet addresses, reconciles all outputs and fails closed on origin',()=>{
  const c=fixture()
  assert.equal(report.blockReport(c,{verified:false,confirmations:10}),null)
  assert.equal(report.blockReport(c,{verified:true,confirmations:3}),null)
  const msg=report.blockReport(c,{verified:true,confirmations:6})
  assert.ok(msg)
  assert.match(msg,/49\.75 BYZ/)
  assert.match(msg,/0\.25 BYZ/)
  assert.match(msg,/50 BYZ/)
  assert.match(msg,/50\.25%/)
  assert.match(msg,/49\.75%/)
  assert.ok(msg.includes(report.abbreviateWallet(PAY_A)))
  assert.ok(msg.includes(report.abbreviateWallet(PAY_B)))
  assert.ok(!msg.includes(PAY_A))
  assert.ok(!msg.includes(PAY_B))
  assert.ok(!msg.includes(fee))
  assert.ok(msg.length<2000)
  assert.equal(report.blockReport({...c,totalSats:'100000'}, {verified:true,confirmations:6}),null)
  assert.equal(report.abbreviateWallet('@everyone'),'unresolved')
})
test('activity report shows only locally timed observed miners and hashrate',()=>{
  const now=Date.parse('2026-10-14T20:00:00.000Z')
  const sample={schema:1,source:'hyperswarm-partial',observedAt:new Date(now).toISOString(),connectedPeers:3,validPresences:2,activeMiners:2,hashrateSamples:1,observedHashrateHps:2600}
  const msg=report.activityReport({activity:sample,now})
  assert.equal(msg,[
    '**BYZE P2Pool · Activity Report**',
    'Latest observation · <t:'+Math.floor(now/1000)+':t>',
    '',
    '**2** Active miners observed',
    '**~2.60 kH/s** Observed hashrate'
  ].join('\n'))
  assert.doesNotMatch(msg,/chain tip|peers reached|telemetry|partial|healthy|coverage|entire network|independently measured/i)
  const missing=report.activityReport({activity:null,now})
  assert.match(missing,/Latest observation · unavailable/)
  assert.match(missing,/\*\*unavailable\*\* Active miners observed/)
  assert.match(missing,/\*\*unavailable\*\* Observed hashrate/)
  const stale=report.activityReport({activity:sample,now:now+125000})
  assert.match(stale,/Latest observation · unavailable/)
  const noPresences={...sample,validPresences:0,activeMiners:0,hashrateSamples:0,observedHashrateHps:0}
  assert.match(report.activityReport({activity:noPresences,now}),/\*\*unavailable\*\* Active miners observed/)
  const noHashrate={...sample,hashrateSamples:0,observedHashrateHps:0}
  assert.match(report.activityReport({activity:noHashrate,now}),/\*\*unavailable\*\* Observed hashrate/)
  assert.equal(report.normalizeActivity({...sample,activeMiners:42},now),null)
  assert.equal(report.normalizeActivity({...sample,observedHashrateHps:Infinity},now),null)
})
test('only reviewed height/hash/coinbase identity admits publication',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'byze-proofs-')),file=path.join(dir,'proofs.json')
  try{
    const proof={height:1234,hash,coinbaseTxid:txid,pplnsTipId:'ps:'+'c'.repeat(64),evidenceUrl:'https://github.com/ContractP2P/byze-p2pool-cli/issues/3'}
    fs.writeFileSync(file,JSON.stringify({schema:1,confirmedBlocks:[proof]}))
    const approved=verifiedAttributions(file)
    assert.equal(eligibleBlock(fixture(),approved.get(hash),6),true)
    assert.equal(eligibleBlock(fixture(),approved.get(hash),5),false)
    assert.equal(eligibleBlock({...fixture(),coinbaseTxid:'c'.repeat(64)},approved.get(hash),6),false)
    fs.writeFileSync(file,JSON.stringify({schema:1,confirmedBlocks:[proof,proof]}))
    assert.throws(()=>verifiedAttributions(file),/duplicate/)
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
test('passive observer validates cryptographic presence, ignores stale and aggregates only active',()=>{
  const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519')
  const peerKey=publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex')
  const now=Date.now()
  const policy=createPoolFeePolicy(core.policy)
  const p=presenceSigningPayload({peerKey,alias:'Test',instanceId:'cfi1:00000000-0000-4000-8000-000000000000',
    contractId:ID.CONTRACT_ID,version:ID.CONTRACT_VERSION,sourceHash:ID.CONTRACT_SOURCE_HASH,
    securityGeneration:ID.SECURITY_GENERATION,publisherKey:ID.BUILTIN_PUBLISHER_KEY,
    poolId:ID.POOL_ID,payoutAddress:fee,miningState:'MINING',
    updatedAt:now,expiresAt:now+90000,seq:1,feePolicyHash:policy.policyHash,
    feeAddress:policy.feeAddress,feeBasisPoints:policy.feeBasisPoints})
  const signature=crypto.sign(null,Buffer.from(canonical(p)),privateKey).toString('base64')
  const announce={...p,signature,telemetry:{observedAt:now,hashrateHps:1123}}
  const valid=obs.verifyPresence(peerKey,announce,now)
  assert.equal(valid.hashrateHps,1123)
  assert.equal(valid.miningState,'MINING')
  assert.equal(obs.verifyPresence(peerKey,{...announce,alias:'Hacker'},now),null)
  assert.equal(obs.verifyPresence('f'.repeat(64),announce,now),null)
  const stale=obs.verifyPresence(peerKey,{...announce,telemetry:{observedAt:now-120000,hashrateHps:1123}},now)
  assert.equal(stale.hashrateHps,null)
  assert.deepEqual(obs.snapshot(new Map([[peerKey,valid]]),new Set([peerKey]),now).activeMiners,1)
})
