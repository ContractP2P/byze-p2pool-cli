'use strict'
// Operator review is mandatory: the local evidence is a claimed miner submission,
// not an independently authenticated PoW/signature history.
const fs=require('node:fs')
const path=require('node:path')
const crypto=require('node:crypto')
const {verifyPplnsEvidence}=require('./verify-payout-evidence.cjs')
const ROOT=path.resolve(__dirname,'../../..')
const MANIFEST=path.resolve(__dirname,'../../config/pool-block-attributions.json')
const EVIDENCE_PATH=/^cli\/evidence\/blocks\/[1-9][0-9]*-[0-9a-f]{64}\.json$/
const GITHUB_REVIEW=/^https:\/\/github\.com\/ContractP2P\/byze-p2pool-cli\/(issues|pull)\/[1-9][0-9]*$/
function verifiedAttributions(file=MANIFEST,root=ROOT){
  const x=JSON.parse(fs.readFileSync(file,'utf8'))
  if(!x||x.schema!==1||!Array.isArray(x.confirmedBlocks)||x.confirmedBlocks.length>100)
    throw Error('Invalid P2Pool attribution manifest')
  const seen=new Set(),approved=new Map()
  for(const row of x.confirmedBlocks){
    const proofFile=String(row.proofFile||'')
    if(!Number.isSafeInteger(row.height)||row.height<=0||
       !/^[0-9a-f]{64}$/.test(String(row.hash||''))||
       !/^[0-9a-f]{64}$/.test(String(row.coinbaseTxid||''))||
       !/^ps:[0-9a-f]{64}$/.test(String(row.pplnsTipId||''))||
       !GITHUB_REVIEW.test(String(row.evidenceUrl||''))||
       !EVIDENCE_PATH.test(proofFile)||
       !proofFile.endsWith(row.height+'-'+row.coinbaseTxid+'.json')||
       !/^[0-9a-f]{64}$/.test(String(row.proofSha256||''))||seen.has(row.hash))
      throw Error('Invalid/duplicate P2Pool attribution entry')
    const p=path.resolve(root,proofFile)
    const base=path.resolve(root,'cli/evidence/blocks')+path.sep
    if(!p.startsWith(base))throw Error('Evidence path escapes reviewed directory')
    seen.add(row.hash)
    approved.set(row.hash,{...row,proofPath:p})
  }
  return approved
}
function eligibleBlock(candidate,entry,confirmations){
  if(!(entry && candidate && entry.height===candidate.height &&
    entry.hash===candidate.hash && entry.coinbaseTxid===candidate.coinbaseTxid &&
    candidate.feeApproxMatch===true && Number.isSafeInteger(confirmations) &&
    confirmations>=6))return false
  // On-chain evidence is fetched by the caller again on every run.
  // Fail closed: do not allow a mutable link or a substituted proof bundle.
  try{
    const stat=fs.lstatSync(entry.proofPath)
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2_000_000||stat.size<100)return false
    const bytes=fs.readFileSync(entry.proofPath)
    if(crypto.createHash('sha256').update(bytes).digest('hex')!==entry.proofSha256)return false
    const evidence=JSON.parse(bytes.toString('utf8'))
    if(evidence.pplnsTipId!==entry.pplnsTipId)return false
    return verifyPplnsEvidence(evidence,candidate).ok
  }catch{return false}
}
module.exports={verifiedAttributions,eligibleBlock}
