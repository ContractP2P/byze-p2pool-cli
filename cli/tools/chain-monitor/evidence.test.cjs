'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const crypto=require('node:crypto')
const policy=require('../../config/pool-policy.json')
const {buildPoolShare,calculateDirectPayouts}=require('../../src/mining/p2pool-protocol')
const {buildJobCommitment}=require('../../src/mining/mining-job-commitment')
const {snapshotSubmission,snapshotSubmissionRecovery,saveSubmissionEvidence}=require('../../src/mining/block-evidence')
const {verifyPplnsEvidence}=require('./verify-payout-evidence.cjs')
const {verifiedAttributions,eligibleBlock}=require('./block-proof.cjs')

const A='byz1'+'q'.repeat(50)+'a'
const B='byz1'+'r'.repeat(50)+'b'
const CONTRACT='0ba509a74eb5f475ce41f152349fe49a7d19e4fbd6c14c1833632c61681a0b66'
const RELEASE='4be720b76f5066edae2d8e84837efa2cd66349003f8a636335beeb83f614138b'
function fixture(){
  const checkpoint={kind:'cell-checkpoint',checkpointId:'cp:'+'c'.repeat(64),
    contractHash:CONTRACT,poolId:policy.poolId,cellId:'cell:test',
    totalWork:'3',workByPayout:{[A]:'2',[B]:'1'}}
  const share=buildPoolShare({checkpoint,byzeHeight:111,byzePrevBlockHash:'f'.repeat(64)}).poolShare
  assert.ok(share)
  const reward='5000000000'
  const plan=calculateDirectPayouts({poolShares:[share],rewardSatoshis:reward,
    maxOutputs:400,feeAddress:policy.feeAddress,feeBasisPoints:policy.feeBasisPoints})
  assert.equal(plan.ok,true)
  const outputs=plan.outputs.map(r=>({address:r.address,satoshis:r.satoshis,
    script:'0014'+crypto.createHash('sha256').update(r.address).digest('hex').slice(0,40)}))
  const commitment=buildJobCommitment({contractHash:CONTRACT,poolId:policy.poolId,
    cellId:'cell:test',templateHash:'b'.repeat(64),feePolicyHash:'d'.repeat(64),
    pplnsTipId:share.poolShareId,coinbaseOutputs:outputs,coinbaseValue:reward})
  assert.equal(commitment.ok,true)
  const doc=snapshotSubmission({raw:{height:2345,previousBlockHash:'f'.repeat(64),powHash:'e'.repeat(64),jobId:'test-job'},
    ctx:{commitment,plan:{ok:true,outputs}},coinbaseTxid:'b'.repeat(64),
    poolChain:{windowFrom:()=>[share]},policy,
    identity:{cliVersion:'0.2.5-rc3',securityGeneration:'coinbase-binding-v2-global-epoch-v6',
      contractSourceHash:CONTRACT,releaseTag:'v0.2.5-rc3-evidence-test1',
      releaseArchiveSha256:RELEASE}})
  const candidate={height:doc.height,hash:'a'.repeat(64),coinbaseTxid:doc.submittedCoinbaseTxid,
    feeApproxMatch:true,totalSats:reward,paidFeeSats:plan.feeSatoshis,
    expectedFeeSats:plan.feeSatoshis,outputs:outputs.map((x,i)=>({address:x.address,script:x.script,sats:x.satoshis,n:i}))}
  return {doc,candidate}
}
test('local evidence stays private; reviewed SHA-pinned chain matches full PPLNS amounts', {skip:process.platform==='win32'},()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'byze-evidence-test-'))
  try{
    const {doc,candidate}=fixture()
    const localDir=path.join(home,'private')
    const local=saveSubmissionEvidence(doc,{directory:localDir})
    assert.equal(fs.statSync(localDir).mode&0o077,0)
    assert.equal(fs.statSync(local.path).mode&0o077,0)
    assert.equal(verifyPplnsEvidence(doc,candidate).ok,true)
    const rel='cli/evidence/blocks/'+doc.height+'-'+doc.submittedCoinbaseTxid+'.json'
    const dest=path.join(home,rel);fs.mkdirSync(path.dirname(dest),{recursive:true})
    fs.copyFileSync(local.path,dest)
    const row={height:doc.height,hash:candidate.hash,coinbaseTxid:candidate.coinbaseTxid,
      pplnsTipId:doc.pplnsTipId,evidenceUrl:'https://github.com/ContractP2P/byze-p2pool-cli/pull/123',
      proofFile:rel,proofSha256:local.sha256}
    const manifest=path.join(home,'attributions.json')
    fs.writeFileSync(manifest,JSON.stringify({schema:1,confirmedBlocks:[row]}))
    const records=verifiedAttributions(manifest,home)
    assert.equal(eligibleBlock(candidate,records.get(candidate.hash),5),false)
    assert.equal(eligibleBlock(candidate,records.get(candidate.hash),6),true)
    assert.equal(eligibleBlock({...candidate,coinbaseTxid:'c'.repeat(64)},records.get(candidate.hash),6),false)
    const swapped={...doc,build:{...doc.build,releaseArchiveSha256:'0'.repeat(64)}}
    fs.writeFileSync(dest,JSON.stringify(swapped))
    assert.equal(eligibleBlock(candidate,records.get(candidate.hash),6),false,'tampering must fail')
  }finally{fs.rmSync(home,{recursive:true,force:true})}
})
test('rejects altered PPLNS work, recipient scripts, fees and missing provenance',()=>{
  const {doc,candidate}=fixture()
  assert.equal(verifyPplnsEvidence(doc,candidate).ok,true)
  const edit=x=>JSON.parse(JSON.stringify(x))
  let bad=edit(doc);bad.poolShares[0].payoutWeights[A]='7'
  assert.equal(verifyPplnsEvidence(bad,candidate).ok,false)
  bad=edit(doc);bad.poolShares[0].poolShareId='ps:'+'0'.repeat(64);bad.pplnsTipId=bad.poolShares[0].poolShareId
  assert.equal(verifyPplnsEvidence(bad,candidate).ok,false)
  bad=edit(doc);bad.build.releaseTag='unknown'
  assert.equal(verifyPplnsEvidence(bad,candidate).ok,false)
  bad=edit(candidate);bad.outputs[0].script='0014'+'e'.repeat(40)
  assert.equal(verifyPplnsEvidence(doc,bad).ok,false)
  bad=edit(candidate);bad.paidFeeSats='1'
  assert.equal(verifyPplnsEvidence(doc,bad).ok,false)
})

test('community release validates version, immutable archive fingerprint and exact PPLNS payments',()=>{
  const {doc,candidate}=fixture()
  const community=JSON.parse(JSON.stringify(doc))
  community.build.releaseTag='v0.2.5-rc4-community.1'
  community.build.cliVersion='0.2.5-rc4-community.1'
  community.build.releaseArchiveSha256='6881453c8e3b5f726920affa65fd6ba6127bbce6bfc67d9daf9ef39ec72802ef'
  assert.equal(verifyPplnsEvidence(community,candidate).ok,true)
  community.build.cliVersion='0.2.5-rc3'
  assert.equal(verifyPplnsEvidence(community,candidate).ok,false,'tag and internal version must match')
  community.build.cliVersion='0.2.5-rc4-community.1'
  community.build.releaseArchiveSha256='4be720b76f5066edae2d8e84837efa2cd66349003f8a636335beeb83f614138b'
  assert.equal(verifyPplnsEvidence(community,candidate).ok,false,'archive SHA and tag must match')
})

test('a single miner can capture and independently review a real bootstrap payout without inventing a PPLNS window', {skip:process.platform==='win32'},()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'byze-bootstrap-evidence-'))
  try{
    const reward='5000000000',fee='25000000',miner='4975000000',txid='c'.repeat(64)
    const outputs=[{address:policy.feeAddress,satoshis:fee,script:'0014'+'a'.repeat(40)},
      {address:A,satoshis:miner,script:'0014'+'b'.repeat(40)}]
    const commitment=buildJobCommitment({contractHash:CONTRACT,poolId:policy.poolId,
      cellId:'cell:bootstrap',templateHash:'d'.repeat(64),feePolicyHash:'e'.repeat(64),
      pplnsTipId:'',coinbaseOutputs:outputs,coinbaseValue:reward})
    assert.equal(commitment.ok,true)
    const capture={raw:{height:2346,previousBlockHash:'f'.repeat(64),powHash:'e'.repeat(64),jobId:'bootstrap'},
      ctx:{commitment,plan:{ok:true,outputs}},coinbaseTxid:txid,policy,
      poolChain:{windowFrom:()=>{throw Error('Bootstrap must not ask for an imaginary PoolShare')}},
      identity:{cliVersion:'0.2.5-rc4-community.1',securityGeneration:'coinbase-binding-v2-global-epoch-v6',
        contractSourceHash:CONTRACT,releaseTag:'v0.2.5-rc4-community.1',
        releaseArchiveSha256:'6881453c8e3b5f726920affa65fd6ba6127bbce6bfc67d9daf9ef39ec72802ef'}}
    const doc=snapshotSubmission(capture)
    assert.equal(doc.payoutMode,'bootstrap')
    assert.equal(doc.proofStatus,'bootstrap-payout-checked')
    assert.equal(doc.pplnsTipId,'')
    assert.deepEqual(doc.poolShares,[])
    assert.deepEqual(doc.signedPoolSharePackets,[])
    const candidate={height:2346,hash:'a'.repeat(64),coinbaseTxid:txid,
      feeApproxMatch:true,totalSats:reward,paidFeeSats:fee,expectedFeeSats:fee,
      outputs:outputs.map((x,i)=>({n:i,address:x.address,sats:x.satoshis,script:x.script}))}
    assert.equal(verifyPplnsEvidence(doc,candidate).payoutMode,'bootstrap')
    const saved=saveSubmissionEvidence(doc,{directory:path.join(home,'private')})
    const rel='cli/evidence/blocks/2346-'+txid+'.json'
    const dest=path.join(home,rel)
    fs.mkdirSync(path.dirname(dest),{recursive:true})
    fs.copyFileSync(saved.path,dest)
    const entry={height:2346,hash:candidate.hash,coinbaseTxid:txid,payoutMode:'bootstrap',pplnsTipId:'',
      evidenceUrl:'https://github.com/ContractP2P/byze-p2pool-cli/pull/123',
      proofFile:rel,proofSha256:saved.sha256}
    const manifest=path.join(home,'attributions.json')
    fs.writeFileSync(manifest,JSON.stringify({schema:1,confirmedBlocks:[entry]}))
    const reviewed=verifiedAttributions(manifest,home)
    assert.equal(eligibleBlock(candidate,reviewed.get(candidate.hash),5),false)
    assert.equal(eligibleBlock(candidate,reviewed.get(candidate.hash),6),true)
    assert.equal(eligibleBlock({...candidate,paidFeeSats:'1'},reviewed.get(candidate.hash),6),false)
    assert.equal(eligibleBlock({...candidate,outputs:[{...candidate.outputs[0],sats:'25000001'},candidate.outputs[1]]},reviewed.get(candidate.hash),6),false)
    const invalidDoc={...doc,payoutMode:'pplns'}
    assert.equal(verifyPplnsEvidence(invalidDoc,candidate).ok,false)
    const recovered=snapshotSubmissionRecovery(capture,Error('PPLNS window absent'))
    assert.equal(recovered.proofStatus,'incomplete')
    assert.equal(verifyPplnsEvidence(recovered,candidate).ok,false)
    assert.ok(saveSubmissionEvidence(recovered,{directory:path.join(home,'private')}).path)
    fs.writeFileSync(dest,JSON.stringify(recovered))
    assert.equal(eligibleBlock(candidate,reviewed.get(candidate.hash),6),false)
  }finally{fs.rmSync(home,{recursive:true,force:true})}
})
