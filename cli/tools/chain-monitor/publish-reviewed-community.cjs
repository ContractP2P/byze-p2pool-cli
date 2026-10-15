#!/usr/bin/env node
'use strict'
// Privacy-limited operator-reviewed PPLNS publication.
// Original signed P2P proofs stay private; never claim public signature replay.
const fs=require('node:fs')
const path=require('node:path')
const crypto=require('node:crypto')
const {policy,tipHeight,blockMetadata,coinbaseTx,evaluateBlock,formatByz}=require('./core.cjs')
const {calculateDirectPayouts,MINING_PROTOCOL,canonical}=require('../../src/mining/p2pool-protocol')
const {validatePoolShareShape}=require('../../src/mining/poolshare-chain')
const {abbreviateWallet}=require('./reports.cjs')
const ROOT=path.resolve(__dirname,'../../..')
const REPO='ContractP2P/byze-p2pool-cli'
const MARKER='<!-- byze-p2pool-chain-monitor-state-v1 -->'
const SHA=/^[0-9a-f]{64}$/,TIP=/^ps:[0-9a-f]{64}$/
const REVIEW_URL=/^https:\/\/github\.com\/ContractP2P\/byze-p2pool-cli\/(?:issues|pull)\/[1-9][0-9]*$/
const validReviewUrl=value=>REVIEW_URL.test(String(value||''))
const EXPLORER='https://explorer.byze.org'
const TOKEN=process.env.GITHUB_TOKEN||'',WEBHOOK=process.env.DISCORD_WEBHOOK_URL||''
const DRY=process.env.COMMUNITY_DRY_RUN==='true'
const ok=(test,message)=>{if(!test)throw Error(message)}
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
function explorerUrl(template,id=''){
  ok(template.includes('{id}')||id==='','Invalid block URL template')
  const u=new URL(template.replace('{id}',encodeURIComponent(String(id))))
  ok(u.origin===EXPLORER&&!u.username&&!u.password,'Untrusted explorer URL')
  return u.href
}
async function fetchJson(url,{method='GET',body,auth=false}={}){
  const controller=new AbortController(),t=setTimeout(()=>controller.abort(),12000)
  try{
    const response=await fetch(url,{method,redirect:'error',signal:controller.signal,
      headers:{Accept:'application/json','User-Agent':'BYZE-Reviewed-P2Pool/1.0',
        ...(auth?{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'}:{}),
        ...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})})
    ok(response.ok,'HTTP '+response.status+' '+new URL(url).pathname)
    const text=await response.text()
    ok(text.length<=2000000,'Oversized JSON response')
    return text?JSON.parse(text):null
  }finally{clearTimeout(t)}
}
function gh(p,method='GET',body){
  ok(TOKEN,'GitHub token required')
  return fetchJson('https://api.github.com'+p,{method,body,auth:true})
}
function evidence(row){
  ok(Number.isSafeInteger(row.height)&&row.height>0&&SHA.test(row.hash)&&
    SHA.test(row.coinbaseTxid)&&SHA.test(row.proofSha256)&&
    SHA.test(row.sourceEvidenceSha256),'Invalid block attribution')
  ok(validReviewUrl(row.reviewUrl),'Review URL must identify this block audit')
  const relative='cli/evidence/blocks/'+row.height+'-'+row.coinbaseTxid+'.json'
  ok(row.proofFile===relative,'Invalid public evidence path')
  const pathname=path.join(ROOT,relative)
  ok(pathname.startsWith(path.join(ROOT,'cli/evidence/blocks')+path.sep),'Path traversal')
  const stat=fs.lstatSync(pathname)
  ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>=100&&stat.size<250000,'Unsafe proof file')
  const bytes=fs.readFileSync(pathname)
  ok(hash(bytes)===row.proofSha256,'Public proof SHA-256 mismatch')
  const e=JSON.parse(bytes)
  ok(e.schema===2&&e.type==='byze-p2pool-operator-reviewed-public-pplns-attestation'&&
    e.status==='privately-reviewed-origin'&&e.reviewUrl===row.reviewUrl&&
    e.sourceEvidenceSha256===row.sourceEvidenceSha256,'Missing operator-review binding')
  ok(e.height===row.height&&e.hash===row.hash&&
    e.submittedCoinbaseTxid===row.coinbaseTxid,'Wrong block identity')
  ok(e.payoutMode==='pplns'&&e.proofStatus==='pplns-window-recomputed'&&
    e.poolId===policy.poolId&&e.feeAddress===policy.feeAddress&&
    e.feeBasisPoints===50,'Incorrect P2Pool policy')
  ok(e.build?.releaseTag==='v0.2.5-rc4-community.2'&&
    e.build?.cliVersion==='0.2.5-rc4-community.2'&&
    e.build?.releaseArchiveSha256==='f6c508bde9793aa7128985366afaa9f03de9a8bf6b13ec3df4cf086c5204ffce'&&
    e.build?.contractSourceHash==='0ba509a74eb5f475ce41f152349fe49a7d19e4fbd6c14c1833632c61681a0b66'&&
    e.build?.securityGeneration==='coinbase-binding-v2-global-epoch-v6','Unknown community release')
  // Older Community Test 2 attestations documented one combined 112-header
  // verification across blocks 21127/21128. New blocks must record their own
  // positive RandomX verification count, bounded by the local source proofs.
  const legacyCombinedAudit=(e.height===21127||e.height===21128)&&
    e.audit?.randomxUniqueHashesCombined===112
  const uniqueHashes=e.audit?.randomxUniqueHashesChecked
  ok(e.audit?.onChainOutputsMatchedAtOperatorReview===true&&
    e.audit?.randomxHashMismatches===0&&
    Number.isSafeInteger(e.audit?.localProofsChecked)&&e.audit.localProofsChecked>0&&
    (legacyCombinedAudit||(Number.isSafeInteger(uniqueHashes)&&uniqueHashes>0&&
      uniqueHashes<=e.audit.localProofsChecked))&&
    e.audit?.witnessV1Spendability==='not-verified','Unreviewed private source')
  ok(!('signedPoolSharePackets' in e),'Private signed packets cannot be public')
  const shares=e.poolShares
  ok(Array.isArray(shares)&&shares.length>0&&shares.length<=20&&
    e.audit.signedPacketsChecked===shares.length&&TIP.test(e.pplnsTipId)&&
    shares[0].poolShareId===e.pplnsTipId,'Invalid PPLNS review window')
  const seen=new Set()
  for(let i=0;i<shares.length;i++){
    const s=shares[i]
    ok(validatePoolShareShape(s).ok&&s.poolId===policy.poolId&&
      !seen.has(s.poolShareId)&&
      (!i||shares[i-1].previousPoolShareId===s.poolShareId),'Invalid PPLNS lineage')
    const fields={protocol:s.protocol,kind:s.kind,contractHash:s.contractHash,
      poolId:s.poolId,cellId:s.cellId,checkpointId:s.checkpointId,
      previousPoolShareId:s.previousPoolShareId,byzeHeight:s.byzeHeight,
      byzePrevBlockHash:s.byzePrevBlockHash,work:s.work,payoutWeights:s.payoutWeights}
    ok(s.poolShareId==='ps:'+hash(Buffer.from(MINING_PROTOCOL+'\0pool-share\0'+canonical(fields))),'PoolShare hash mismatch')
    seen.add(s.poolShareId)
  }
  const calculated=calculateDirectPayouts({poolShares:shares,rewardSatoshis:e.coinbaseValueSats,
    feeAddress:policy.feeAddress,feeBasisPoints:50,maxOutputs:400})
  ok(calculated.ok&&calculated.feeSatoshis==='25000000'&&
    calculated.outputs.length===e.payoutOutputs.length,'Incorrect PPLNS payout plan')
  for(let i=0;i<calculated.outputs.length;i++){
    const x=calculated.outputs[i],y=e.payoutOutputs[i]
    ok(x.address===y.address&&x.satoshis===y.satoshis&&
      /^[0-9a-f]{4,20000}$/.test(y.script),'Committed payout differs from PPLNS plan')
  }
  return e
}
function sorted(rows){
  return rows.map(o=>({script:String(o.script).toLowerCase(),sats:String(o.sats??o.satoshis)}))
    .sort((a,b)=>a.script.localeCompare(b.script)||a.sats.localeCompare(b.sats))
}
async function checkChain(e,tip){
  ok(tip-e.height+1>=6,'Fewer than six block confirmations')
  const blockTemplate=process.env.BYZE_BLOCK_URL_TEMPLATE||EXPLORER+'/api/block/{id}'
  const block=blockMetadata(await fetchJson(explorerUrl(blockTemplate,e.height)),e.height)
  ok(block.hash===e.hash,'Reorg / canonical block mismatch')
  let tx=block.first
  if(typeof tx==='string'||!tx?.vout){
    const id=typeof tx==='string'?tx:tx?.txid||tx?.hash
    ok(SHA.test(id),'Coinbase ID unavailable')
    ok(process.env.BYZE_TX_URL_TEMPLATE?.includes('{id}'),'Decoded transaction endpoint unavailable')
    tx=await fetchJson(explorerUrl(process.env.BYZE_TX_URL_TEMPLATE,id))
  }
  coinbaseTx(tx)
  const c=evaluateBlock(block,tx,process.env.BYZE_VALUE_MODE||'byz')
  ok(c.hash===e.hash&&c.coinbaseTxid===e.submittedCoinbaseTxid&&
    c.feeApproxMatch&&c.totalSats===e.coinbaseValueSats&&
    c.paidFeeSats==='25000000'&&c.expectedFeeSats==='25000000',
    'Coinbase identity or 0.5% fee mismatch')
  ok(JSON.stringify(sorted(c.outputs.filter(x=>BigInt(x.sats)>0n)))===
    JSON.stringify(sorted(e.payoutOutputs)),'Coinbase outputs/scripts mismatch')
  return c
}
function message(e,confirmations){
  const miners=e.payoutOutputs.filter(x=>x.address!==policy.feeAddress)
  return [
    '**BYZE P2Pool · PPLNS block #'+e.height+' — operator-reviewed**',
    'Confirmations: **'+confirmations+'** · Paid miner wallets: **'+miners.length+'**',
    'Coinbase: **50 BYZE** · Miner payouts: **49.75 BYZE** · Pool fee: **0.25 BYZE (0.50%)**',
    ...miners.map(x=>'• '+abbreviateWallet(x.address)+' · '+formatByz(x.satoshis)+' BYZE'),
    'Chain evidence: https://explorer.byze.org/api/block/'+e.height,
    'Operator review: '+e.reviewUrl,
    'Live on-chain amounts/scripts verified. Signed P2P/RandomX source was reviewed privately, not publicly replayed. Wallet spendability has NOT been established.'
  ].join('\n')
}
async function loadState(){
  const issue=await gh('/repos/'+REPO+'/issues/24')
  ok(issue.title==='BYZE P2Pool chain-monitor state (automated)'&&
    issue.body?.startsWith(MARKER),'Missing shared deduplication state')
  const state=JSON.parse(issue.body.slice(MARKER.length).trim())
  ok(state.schema===1&&Array.isArray(state.publishedBlocks),'Invalid shared deduplication state')
  return state
}
async function post(content){
  const u=new URL(WEBHOOK)
  ok(u.protocol==='https:'&&['discord.com','discordapp.com'].includes(u.hostname)&&
    /^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/.test(u.pathname),'Invalid Discord webhook')
  const ctrl=new AbortController(),t=setTimeout(()=>ctrl.abort(),12000)
  try{
    const r=await fetch(WEBHOOK,{method:'POST',redirect:'error',signal:ctrl.signal,
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({content,allowed_mentions:{parse:[]}})})
    ok(r.ok,'Discord HTTP '+r.status)
  }finally{clearTimeout(t)}
}
function validatedManifestRows(manifest){
  ok(manifest?.schema===1&&Array.isArray(manifest.reviewedBlocks)&&
    manifest.reviewedBlocks.length>=1&&manifest.reviewedBlocks.length<=100,'Invalid reviewed block manifest size')
  return manifest.reviewedBlocks
}
async function main(){
  const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'cli/config/operator-reviewed-blocks.json'),'utf8'))
  const reviewedRows=validatedManifestRows(manifest)
  const unique=new Set()
  const entries=reviewedRows.map(row=>{
    ok(!unique.has(row.hash),'Duplicate reviewed block')
    unique.add(row.hash)
    return evidence(row)
  })
  ok(DRY||(TOKEN&&WEBHOOK),'Live publishing requires GitHub token and Discord webhook')
  const tip=tipHeight(await fetchJson(explorerUrl(process.env.BYZE_TIP_URL||EXPLORER+'/api/status')))
  const state=await loadState()
  for(const e of entries){
    // An already-published report must never prevent a newly reviewed block
    // from posting if the older block later reorgs or ages out of the explorer.
    if(state.publishedBlocks.includes(e.hash)){
      console.log('ALREADY_POSTED',e.height,e.hash)
      continue
    }
    const confirmations=tip-e.height+1
    if(confirmations<6){
      console.log('PENDING_CONFIRMATIONS',e.height,Math.max(0,confirmations))
      continue
    }
    await checkChain(e,tip)
    const report=message(e,confirmations)
    if(DRY){
      console.log('DRY_RUN_VERIFIED',e.height,report)
      continue
    }
    await post(report)
    state.publishedBlocks=[...new Set([...state.publishedBlocks,e.hash])].slice(-1200)
    await gh('/repos/'+REPO+'/issues/24','PATCH',{body:MARKER+'\n'+JSON.stringify(state)})
    console.log('DISCORD_POSTED',e.height,e.hash)
  }
}
if(require.main===module){
  main().catch(e=>{console.error('REVIEWED_PPLNS_PUBLISH_FAILED',e.message);process.exitCode=1})
}
module.exports={validatedManifestRows,validReviewUrl}
