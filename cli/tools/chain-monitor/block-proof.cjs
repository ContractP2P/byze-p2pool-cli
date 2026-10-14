'use strict'
// Only independently reviewed block attestations permit a "P2Pool mined this block" Discord claim.
// Config is version-controlled; mere fee-address matching is not an attribution.
const fs=require('node:fs')
const path=require('node:path')
function verifiedAttributions(file=path.resolve(__dirname,'../../config/pool-block-attributions.json')) {
  const x=JSON.parse(fs.readFileSync(file,'utf8'))
  if(!x || x.schema!==1 || !Array.isArray(x.confirmedBlocks) || x.confirmedBlocks.length>500)throw Error('Invalid P2Pool attribution manifest')
  const seen=new Set(),approved=new Map()
  for(const row of x.confirmedBlocks) {
    if(!Number.isSafeInteger(row.height)||row.height<=0 ||
       !/^[0-9a-f]{64}$/.test(String(row.hash||'')) ||
       !/^[0-9a-f]{64}$/.test(String(row.coinbaseTxid||'')) ||
       !/^ps:[0-9a-f]{64}$/.test(String(row.pplnsTipId||'')) ||
       typeof row.evidenceUrl!=='string' || !/^https:\/\/github\.com\/ContractP2P\/byze-p2pool-cli\/(issues|pull)\/[1-9][0-9]*$/.test(row.evidenceUrl) ||
       seen.has(row.hash))throw Error('Invalid/duplicate P2Pool attribution entry')
    seen.add(row.hash)
    approved.set(row.hash,row)
  }
  return approved
}
function eligibleBlock(candidate,entry,confirmations) {
  return !!(entry && candidate && entry.height===candidate.height &&
    entry.hash===candidate.hash && entry.coinbaseTxid===candidate.coinbaseTxid &&
    candidate.feeApproxMatch===true && Number.isSafeInteger(confirmations) && confirmations>=6)
}
module.exports={verifiedAttributions,eligibleBlock}
