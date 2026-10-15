'use strict'
// Local-only, best-effort evidence of a successful submitblock RPC.
// A submission is NOT a confirmed block. No wallet keys, network upload or Discord webhook.
const crypto=require('node:crypto')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const { calculateDirectPayouts }=require('./p2pool-protocol')
const { validatePoolShareShape }=require('./poolshare-chain')

const HEX64=/^[0-9a-f]{64}$/
const TIP=/^ps:[0-9a-f]{64}$/
function positive(value){try{const n=BigInt(String(value));return n>0n?n:null}catch{return null}}
function snapshotSubmission({raw,ctx,coinbaseTxid,poolChain,poolPackets=null,policy,identity={}}){
  if(!HEX64.test(String(coinbaseTxid||''))||!ctx?.commitment?.ok||!ctx.plan?.ok)throw Error('A verified coinbase commitment is required')
  const height=Number(raw?.height)
  if(!Number.isSafeInteger(height)||height<1)throw Error('Invalid submitted height')
  const tip=String(ctx.commitment.pplnsTipId||'')
  if(!TIP.test(tip))throw Error('Cannot certify a PPLNS window without a committed pool-share tip')
  const window=poolChain?.windowFrom(tip,20)||[]
  if(!window.length||window[0].poolShareId!==tip||window.length>20)throw Error('Committed PPLNS window unavailable')
  const seen=new Set()
  for(let i=0;i<window.length;i++){
    const s=window[i]
    if(!validatePoolShareShape(s).ok||seen.has(s.poolShareId)||
      (i>0&&window[i-1].previousPoolShareId!==s.poolShareId))throw Error('Invalid PPLNS chain/window')
    seen.add(s.poolShareId)
  }
  const reward=positive(ctx.commitment.coinbaseValue)
  if(!reward)throw Error('Invalid coinbase reward')
  const calculated=calculateDirectPayouts({poolShares:window,rewardSatoshis:reward.toString(),
    maxOutputs:400,feeAddress:policy.feeAddress,feeBasisPoints:policy.feeBasisPoints})
  if(!calculated.ok||calculated.outputs.length!==ctx.plan.outputs.length)throw Error('PPLNS payout recomputation failed')
  const actual=new Map(ctx.plan.outputs.map(x=>[x.address,String(x.satoshis)]))
  for(const row of calculated.outputs)if(actual.get(row.address)!==row.satoshis)throw Error('PPLNS plan differs from committed coinbase')
  const outputs=ctx.commitment.outputs.map(x=>({address:x.address,satoshis:String(x.satoshis),script:x.script}))
  if(outputs.length!==calculated.outputs.length)throw Error('Committed outputs mismatch')
  // Preserve the signed P2P packets for the reviewer's separate cryptographic audit.
  // Some peers may have pruned old packets; never claim that an absent proof is valid.
  const packets=window.map(s=>poolPackets?.get(s.poolShareId)||null)
  const missingProofPackets=packets.filter(x=>x===null).length
  const document={
    schema:1,type:'byze-p2pool-submitted-block-evidence',status:'submitted-not-confirmed',
    recordedAt:new Date().toISOString(),
    poolId:String(policy.poolId),feeAddress:policy.feeAddress,feeBasisPoints:policy.feeBasisPoints,
    height,submittedCoinbaseTxid:coinbaseTxid,
    previousBlockHash:String(raw.previousBlockHash||'').toLowerCase(),
    randomxPowHash:String(raw.powHash||'').toLowerCase(),
    jobId:String(raw.jobId||''),jobCommitmentHash:ctx.commitment.jobCommitmentHash,
    pplnsTipId:tip,coinbaseValueSats:reward.toString(),
    payoutOutputs:outputs,poolShares:window.map(s=>JSON.parse(JSON.stringify(s))),
    signedPoolSharePackets:packets.map(p=>p?JSON.parse(JSON.stringify(p)):null),
    missingProofPackets,
    build:{cliVersion:String(identity.cliVersion||''),securityGeneration:String(identity.securityGeneration||''),
      contractSourceHash:String(identity.contractSourceHash||''),releaseTag:String(identity.releaseTag||''),
      releaseArchiveSha256:String(identity.releaseArchiveSha256||'')}
  }
  // Signed P2P share proofs and public block attribution remain separate review requirements.
  return document
}
function saveSubmissionEvidence(document,{directory=process.env.BYZE_P2POOL_EVIDENCE_DIR||
  path.join(os.homedir(),'.local','state','byze-p2pool','block-evidence')}={}){
  // Windows ACL semantics differ from POSIX mode bits and are not yet audited.
  if(process.platform==='win32')throw Error('Private evidence capture is supported only on macOS and Linux')
  const dir=path.resolve(directory)
  fs.mkdirSync(dir,{recursive:true,mode:0o700})
  const st=fs.lstatSync(dir)
  if(st.isSymbolicLink()||!st.isDirectory()||(st.mode&0o077))throw Error('Evidence directory must be a private, non-symlink directory (0700)')
  const body=JSON.stringify(document,null,2)+'\n'
  if(Buffer.byteLength(body)>8_000_000)throw Error('Evidence exceeds 8 MB; preserve original signed proof packets separately')
  const digest=crypto.createHash('sha256').update(body).digest('hex')
  const filename='submitted-'+document.height+'-'+document.submittedCoinbaseTxid+'-'+digest.slice(0,12)+'.json'
  const dest=path.join(dir,filename)
  const fd=fs.openSync(dest,'wx',0o600)
  try{fs.writeFileSync(fd,body);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  return {path:dest,sha256:digest}
}
module.exports={snapshotSubmission,saveSubmissionEvidence}
