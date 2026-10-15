'use strict'
// Independent read-only arithmetic check for a reviewed pool-share window.
// Chain provenance and underlying signed PoW packets must additionally be
// reviewed by a human; this module never attests those facts from a fee match.
const crypto=require('node:crypto')
const {calculateDirectPayouts,MINING_PROTOCOL,canonical}=require('../../src/mining/p2pool-protocol')
const {validatePoolShareShape}=require('../../src/mining/poolshare-chain')
const policy=require('../../config/pool-policy.json')
const HEX=/^[0-9a-f]{64}$/
const TIP=/^ps:[0-9a-f]{64}$/
const SHA_BY_PLATFORM=new Set([
  '872d07c2fb8b8b3cfc25a88209741aad6fabc3a95ae402a265b454e25cfd9fea',
  'b5e1f7d5f18a654f9080fc49d77a0b18c73eaf37237297db9e0751208e8d6ec9',
  '1c6eee109bc65008ccad476f80aa57ab5c04bd3ed678d3c447671e85952893ea'
])
function positive(v){try{const n=BigInt(String(v));return n>0n?n:null}catch{return null}}
function sameOutputSets(expected,actual){
  if(expected.length!==actual.length)return false
  const sort=x=>[...x].sort((a,b)=>a.script.localeCompare(b.script)||a.satoshis.localeCompare(b.satoshis))
  return JSON.stringify(sort(expected))===JSON.stringify(sort(actual))
}
function verifyPplnsEvidence(evidence,candidate){
  function no(reason){return {ok:false,reason}}
  if(!evidence||evidence.schema!==1||evidence.type!=='byze-p2pool-submitted-block-evidence'||
    evidence.status!=='submitted-not-confirmed')return no('not-a-submission-record')
  if(!candidate||evidence.height!==candidate.height||evidence.submittedCoinbaseTxid!==candidate.coinbaseTxid||
    !HEX.test(String(candidate.hash||'')))return no('onchain-identity-mismatch')
  if(evidence.poolId!==policy.poolId||evidence.feeAddress!==policy.feeAddress||
    evidence.feeBasisPoints!==policy.feeBasisPoints)return no('pool-policy-mismatch')
  if(evidence.build?.releaseTag!=='v0.2.5-rc3-rpc-recovery-test1'||
    !SHA_BY_PLATFORM.has(String(evidence.build?.releaseArchiveSha256||''))||
    evidence.build?.contractSourceHash!=='0ba509a74eb5f475ce41f152349fe49a7d19e4fbd6c14c1833632c61681a0b66'||
    evidence.build?.securityGeneration!=='coinbase-binding-v2-global-epoch-v6')
    return no('release-provenance-not-recorded')
  const tip=String(evidence.pplnsTipId||'')
  const shares=evidence.poolShares
  if(!TIP.test(tip)||!Array.isArray(shares)||!shares.length||shares.length>20||
    shares[0]?.poolShareId!==tip)return no('missing-pplns-window')
  const seen=new Set()
  for(let i=0;i<shares.length;i++){
    const s=shares[i]
    if(!validatePoolShareShape(s).ok||s.poolId!==policy.poolId||seen.has(s.poolShareId)||
      (i>0&&shares[i-1].previousPoolShareId!==s.poolShareId))
      return no('invalid-pplns-share-or-lineage')
    const b={protocol:s.protocol,kind:s.kind,contractHash:s.contractHash,poolId:s.poolId,
      cellId:s.cellId,checkpointId:s.checkpointId,previousPoolShareId:s.previousPoolShareId,
      byzeHeight:s.byzeHeight,byzePrevBlockHash:s.byzePrevBlockHash,
      work:s.work,payoutWeights:s.payoutWeights}
    const id='ps:'+crypto.createHash('sha256').update(
      Buffer.from(MINING_PROTOCOL+'\0pool-share\0'+canonical(b))).digest('hex')
    if(id!==s.poolShareId)return no('pool-share-id-mismatch')
    seen.add(s.poolShareId)
  }
  const reward=positive(evidence.coinbaseValueSats)
  if(!reward||reward!==positive(candidate.totalSats))return no('coinbase-total-mismatch')
  const plan=calculateDirectPayouts({poolShares:shares,rewardSatoshis:reward.toString(),
    maxOutputs:400,feeAddress:policy.feeAddress,feeBasisPoints:policy.feeBasisPoints})
  if(!plan.ok)return no('pplns-plan-'+plan.code)
  if(!Array.isArray(evidence.payoutOutputs)||evidence.payoutOutputs.length!==plan.outputs.length)
    return no('committed-plan-output-count')
  for(let i=0;i<plan.outputs.length;i++){
    const x=plan.outputs[i], y=evidence.payoutOutputs[i]
    if(x.address!==y?.address||x.satoshis!==String(y?.satoshis)||
      !/^[0-9a-f]{4,20000}$/.test(String(y.script||'')))
      return no('payout-calculation-differs')
  }
  const actual=(Array.isArray(candidate.outputs)?candidate.outputs:[])
    .filter(o=>positive(o.sats)!==null)
    .map(o=>({script:String(o.script||'').toLowerCase(),satoshis:String(o.sats)}))
  const expected=evidence.payoutOutputs.map(o=>({script:o.script,satoshis:String(o.satoshis)}))
  if(!sameOutputSets(expected,actual))return no('onchain-outputs-differ')
  const calculatedFee=(reward*BigInt(policy.feeBasisPoints))/10000n
  if(BigInt(plan.feeSatoshis)!==calculatedFee||
    String(candidate.paidFeeSats)!==calculatedFee.toString()||
    String(candidate.expectedFeeSats)!==calculatedFee.toString())
    return no('pool-fee-differs')
  return {ok:true,pplnsTipId:tip,recipientCount:plan.outputs.length,
    feeSats:calculatedFee.toString(),coinbaseTxid:evidence.submittedCoinbaseTxid,
    blockHash:candidate.hash,level:'pplns-arithmetic-and-onchain-outputs'}
}
module.exports={verifyPplnsEvidence}
