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
const {snapshotSubmission,saveSubmissionEvidence}=require('../../src/mining/block-evidence')
const {verifyPplnsEvidence}=require('./verify-payout-evidence.cjs')
const {verifiedAttributions,eligibleBlock}=require('./block-proof.cjs')

const A='byz1'+'q'.repeat(50)+'a'
const B='byz1'+'r'.repeat(50)+'b'
const CONTRACT='0ba509a74eb5f475ce41f152349fe49a7d19e4fbd6c14c1833632c61681a0b66'
const RELEASE='1c6eee109bc65008ccad476f80aa57ab5c04bd3ed678d3c447671e85952893ea'
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
      contractSourceHash:CONTRACT,releaseTag:'v0.2.5-rc3-rpc-recovery-test1',
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
