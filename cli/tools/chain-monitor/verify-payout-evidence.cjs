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
const TRUSTED_RELEASES=Object.freeze({
  'v0.2.5-rc3-evidence-test1':{version:'0.2.5-rc3',sha256:new Set([
    '48d408447dd5ab2e3c0a13e8fe5f1e832d920a41cd19fb64e20b690bafb8e9be',
    '883c8159b9d9e4cea7039aae103792b907e79eb2233de591af9b8b091c6279a7',
    '4be720b76f5066edae2d8e84837efa2cd66349003f8a636335beeb83f614138b'
  ])},
  'v0.2.5-rc4-community.1':{version:'0.2.5-rc4-community.1',sha256:new Set([
    '22ad3f666e4e487c848dbc6133ee1aa91fea0fd8e299944fa9b04e77c6d86986',
    'f86ee84a54d818b16098b68996473a61f22c7d8481f2b9d02251ffbb7a625b47',
    '6881453c8e3b5f726920affa65fd6ba6127bbce6bfc67d9daf9ef39ec72802ef'
  ])},
  'v0.2.5-rc4-community.2':{version:'0.2.5-rc4-community.2',sha256:new Set([
    'f6c508bde9793aa7128985366afaa9f03de9a8bf6b13ec3df4cf086c5204ffce',
    'a51326d40de13e6bb1246a8470066b676f6140f79c7725cb393d4d5028021391',
    'ee398f908b4e587bb027803d53326cdb11a77ec60cea958e911c152e342d684d'
  ])}
})
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
  const releaseTag=String(evidence.build?.releaseTag||'')
  const trusted=Object.hasOwn(TRUSTED_RELEASES,releaseTag)?TRUSTED_RELEASES[releaseTag]:null
  if(!trusted||evidence.build?.cliVersion!==trusted.version||
    !trusted.sha256.has(String(evidence.build?.releaseArchiveSha256||''))||
    evidence.build?.contractSourceHash!=='0ba509a74eb5f475ce41f152349fe49a7d19e4fbd6c14c1833632c61681a0b66'||
    evidence.build?.securityGeneration!=='coinbase-binding-v2-global-epoch-v6')
    return no('release-provenance-not-recorded')
  // Bootstrap payments are NOT PPLNS. They may be independently reviewed
  // for single-miner coinbase amounts, but never credited as share-window proof.
  const mode=String(evidence.payoutMode||'pplns')
  if(evidence.proofStatus==='incomplete')return no('incomplete-local-capture')
  if(mode==='bootstrap'){
    if(evidence.proofStatus!=='bootstrap-payout-checked'||
      evidence.pplnsTipId!==''||!Array.isArray(evidence.poolShares)||
      evidence.poolShares.length!==0||!Array.isArray(evidence.signedPoolSharePackets)||
      evidence.signedPoolSharePackets.length!==0||evidence.missingProofPackets!==0)
      return no('bootstrap-must-not-claim-pplns')
    const reward=positive(evidence.coinbaseValueSats)
    if(!reward||reward!==positive(candidate.totalSats))return no('coinbase-total-mismatch')
    const rows=evidence.payoutOutputs
    if(!Array.isArray(rows)||rows.length!==2)return no('bootstrap-requires-one-miner-and-fee')
    const fee=rows.filter(x=>x.address===policy.feeAddress)
    const miners=rows.filter(x=>x.address!==policy.feeAddress)
    const expectedFee=reward*BigInt(policy.feeBasisPoints)/10000n
    if(fee.length!==1||miners.length!==1||
      !positive(miners[0].satoshis)||String(fee[0].satoshis)!==expectedFee.toString()||
      String(miners[0].satoshis)!==(reward-expectedFee).toString()||
      !/^byz1[a-z0-9]{18,100}$/.test(miners[0].address))
      return no('bootstrap-payment-arithmetic-mismatch')
    if(rows.some(x=>!/^[0-9a-f]{4,20000}$/.test(String(x.script||''))))
      return no('invalid-committed-scripts')
    const expected=rows.map(x=>({script:x.script,satoshis:String(x.satoshis)}))
    const actual=(Array.isArray(candidate.outputs)?candidate.outputs:[])
      .filter(o=>positive(o.sats)!==null)
      .map(o=>({script:String(o.script||'').toLowerCase(),satoshis:String(o.sats)}))
    if(!sameOutputSets(expected,actual))return no('onchain-outputs-differ')
    if(String(candidate.paidFeeSats)!==expectedFee.toString()||
      String(candidate.expectedFeeSats)!==expectedFee.toString())
      return no('pool-fee-differs')
    return {ok:true,payoutMode:'bootstrap',recipientCount:1,
      feeSats:expectedFee.toString(),coinbaseTxid:evidence.submittedCoinbaseTxid,
      blockHash:candidate.hash,level:'bootstrap-arithmetic-and-onchain-outputs'}
  }
  if(mode!=='pplns')return no('unknown-payout-mode')
  if(evidence.proofStatus&&!['pplns-window-recomputed','pplns-packets-missing'].includes(evidence.proofStatus))
    return no('invalid-pplns-proof-status')
  const tip=String(evidence.pplnsTipId||'')
  const shares=evidence.poolShares
  if(!TIP.test(tip)||!Array.isArray(shares)||!shares.length||shares.length>20||
    shares[0]?.poolShareId!==tip)return no('missing-pplns-window')
  // PPLNS attribution is never public when source signed packets are absent.
  // Presence and share linkage are checked here; PoW/signature provenance still
  // needs an independent operator review, not just arithmetic checks.
  if(evidence.missingProofPackets!==0 ||
     !Array.isArray(evidence.signedPoolSharePackets) ||
     evidence.signedPoolSharePackets.length!==shares.length ||
     evidence.signedPoolSharePackets.some((p,i)=>!p?.share||
       p.share.poolShareId!==shares[i].poolShareId||
       typeof p.signature!=='string'||!p.signature))
    return no('signed-pplns-source-packets-missing')
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
  return {ok:true,payoutMode:'pplns',pplnsTipId:tip,recipientCount:plan.outputs.length,
    feeSats:calculatedFee.toString(),coinbaseTxid:evidence.submittedCoinbaseTxid,
    blockHash:candidate.hash,level:'pplns-arithmetic-and-onchain-outputs'}
}
module.exports={verifyPplnsEvidence}
