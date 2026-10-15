'use strict'
// Private, local-only record of an accepted submitblock RPC. Never an assertion
// of network confirmation, miner identity, or independently checked PPLNS PoW.
const crypto=require('node:crypto')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {calculateDirectPayouts}=require('./p2pool-protocol')
const {validatePoolShareShape}=require('./poolshare-chain')

const HEX64=/^[0-9a-f]{64}$/
const TIP=/^ps:[0-9a-f]{64}$/
function positive(value){try{const n=BigInt(String(value));return n>0n?n:null}catch{return null}}
function baseSubmission({raw,ctx,coinbaseTxid,policy,identity={}}){
  const commit=ctx?.commitment||{}
  const tip=String(commit.pplnsTipId||'')
  return {
    schema:1,type:'byze-p2pool-submitted-block-evidence',status:'submitted-not-confirmed',
    recordedAt:new Date().toISOString(),
    // An empty tip is a *bootstrap payout*, never a PPLNS payout.
    payoutMode:tip?'pplns':'bootstrap',proofStatus:'incomplete',
    poolId:String(policy?.poolId||''),feeAddress:String(policy?.feeAddress||''),
    feeBasisPoints:Number(policy?.feeBasisPoints||0),
    height:Number(raw?.height),submittedCoinbaseTxid:String(coinbaseTxid||'').toLowerCase(),
    previousBlockHash:String(raw?.previousBlockHash||'').toLowerCase(),
    randomxPowHash:String(raw?.powHash||'').toLowerCase(),
    jobId:String(raw?.jobId||''),jobCommitmentHash:String(commit.jobCommitmentHash||''),
    pplnsTipId:tip,coinbaseValueSats:String(commit.coinbaseValue||''),
    payoutOutputs:(Array.isArray(commit.outputs)?commit.outputs:[]).map(x=>({
      address:String(x.address||''),satoshis:String(x.satoshis||''),script:String(x.script||'').toLowerCase()})),
    poolShares:[],signedPoolSharePackets:[],missingProofPackets:0,
    build:{cliVersion:String(identity.cliVersion||''),securityGeneration:String(identity.securityGeneration||''),
      contractSourceHash:String(identity.contractSourceHash||''),releaseTag:String(identity.releaseTag||''),
      releaseArchiveSha256:String(identity.releaseArchiveSha256||'')}
  }
}
function validatePlanOutputs(doc,ctx){
  if(!ctx?.plan?.ok || !Array.isArray(ctx.plan.outputs)||
    doc.payoutOutputs.length!==ctx.plan.outputs.length)throw Error('Committed outputs mismatch')
  for(let i=0;i<doc.payoutOutputs.length;i++){
    const a=doc.payoutOutputs[i],b=ctx.plan.outputs[i]
    if(a.address!==b.address||a.satoshis!==String(b.satoshis)||
       a.script!==String(b.script||'').toLowerCase())throw Error('Committed payout differs from mining plan')
  }
}
function snapshotSubmission(args){
  const {ctx,coinbaseTxid,poolChain,poolPackets=null,policy}=args
  const doc=baseSubmission(args)
  if(!HEX64.test(doc.submittedCoinbaseTxid)||!ctx?.commitment?.ok||!ctx.plan?.ok)
    throw Error('A verified coinbase commitment is required')
  if(!Number.isSafeInteger(doc.height)||doc.height<1)throw Error('Invalid submitted height')
  const reward=positive(doc.coinbaseValueSats)
  if(!reward)throw Error('Invalid coinbase reward')
  validatePlanOutputs(doc,ctx)
  const tip=doc.pplnsTipId
  if(!tip){
    // During pool start-up, the original coinbase pays one recipient directly.
    // Verify that plan without inventing an artificial PoolShare / PPLNS window.
    const fee=doc.payoutOutputs.filter(x=>x.address===policy.feeAddress)
    const miners=doc.payoutOutputs.filter(x=>x.address!==policy.feeAddress)
    const expectedFee=reward*BigInt(policy.feeBasisPoints)/10000n
    if(fee.length!==1||miners.length!==1||!positive(miners[0].satoshis)||
       BigInt(fee[0].satoshis)!==expectedFee||
       BigInt(miners[0].satoshis)!==reward-expectedFee)
      throw Error('Bootstrap payout does not match exact pool fee and miner reward')
    doc.proofStatus='bootstrap-payout-checked'
    return doc
  }
  if(!TIP.test(tip))throw Error('Invalid committed PPLNS tip')
  const window=poolChain?.windowFrom(tip,20)||[]
  if(!window.length||window[0].poolShareId!==tip||window.length>20)
    throw Error('Committed PPLNS window unavailable')
  const seen=new Set()
  for(let i=0;i<window.length;i++){
    const s=window[i]
    if(!validatePoolShareShape(s).ok||seen.has(s.poolShareId)||
      (i>0&&window[i-1].previousPoolShareId!==s.poolShareId))
      throw Error('Invalid PPLNS chain/window')
    seen.add(s.poolShareId)
  }
  const computed=calculateDirectPayouts({poolShares:window,rewardSatoshis:reward.toString(),
    maxOutputs:400,feeAddress:policy.feeAddress,feeBasisPoints:policy.feeBasisPoints})
  if(!computed.ok||computed.outputs.length!==doc.payoutOutputs.length)
    throw Error('PPLNS payout recomputation failed')
  const actual=new Map(doc.payoutOutputs.map(x=>[x.address,x.satoshis]))
  if(actual.size!==doc.payoutOutputs.length)throw Error('Duplicate payout address')
  for(const row of computed.outputs)
    if(actual.get(row.address)!==row.satoshis)throw Error('PPLNS plan differs from committed coinbase')
  const packets=window.map(s=>poolPackets?.get(s.poolShareId)||null)
  doc.poolShares=window.map(s=>JSON.parse(JSON.stringify(s)))
  doc.signedPoolSharePackets=packets.map(p=>p?JSON.parse(JSON.stringify(p)):null)
  doc.missingProofPackets=packets.filter(p=>p===null).length
  doc.proofStatus=doc.missingProofPackets?'pplns-packets-missing':'pplns-window-recomputed'
  return doc
}
// Always preserve an *incomplete* record if complete capture failed after a
// successful submission; this record MUST NOT pass the public verifier.
function snapshotSubmissionRecovery(args,error){
  const doc=baseSubmission(args)
  doc.proofStatus='incomplete'
  doc.captureError=String(error?.message||error||'unknown').replace(/[\r\n]/g,' ').slice(0,160)
  return doc
}
function saveSubmissionEvidence(document,{directory=process.env.BYZE_P2POOL_EVIDENCE_DIR||
  path.join(os.homedir(),'.local','state','byze-p2pool','block-evidence')}={}){
  if(process.platform==='win32')throw Error('Private evidence capture is supported only on macOS and Linux')
  const dir=path.resolve(directory)
  fs.mkdirSync(dir,{recursive:true,mode:0o700})
  const st=fs.lstatSync(dir)
  if(st.isSymbolicLink()||!st.isDirectory()||(st.mode&0o077))
    throw Error('Evidence directory must be a private, non-symlink directory (0700)')
  const body=JSON.stringify(document,null,2)+'\n'
  if(Buffer.byteLength(body)>8_000_000)
    throw Error('Evidence exceeds 8 MB; preserve original signed proof packets separately')
  const digest=crypto.createHash('sha256').update(body).digest('hex')
  const txid=HEX64.test(document.submittedCoinbaseTxid)?document.submittedCoinbaseTxid:'unknown-txid'
  const filename='submitted-'+Number(document.height)+'-'+txid+'-'+digest.slice(0,12)+'.json'
  const dest=path.join(dir,filename)
  const fd=fs.openSync(dest,'wx',0o600)
  try{fs.writeFileSync(fd,body);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  return {path:dest,sha256:digest}
}
module.exports={snapshotSubmission,snapshotSubmissionRecovery,saveSubmissionEvidence}
