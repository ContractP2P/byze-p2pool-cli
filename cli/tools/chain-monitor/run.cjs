#!/usr/bin/env node
'use strict'
// External, READ-ONLY chain observer. Never connects to miners, P2P or their wallets.
const fs=require('node:fs')
const path=require('node:path')
const {
  policy, tipHeight, blockMetadata, coinbaseTx, evaluateBlock, makeScanRange,
  summarize, stateFromScan
} = require('./core.cjs')
const {activityReport,blockReport}=require('./reports.cjs')
const {verifiedAttributions,eligibleBlock}=require('./block-proof.cjs')
const GITHUB_API='https://api.github.com'
const MARKER='<!-- byze-p2pool-chain-monitor-state-v1 -->'
const dryRun=process.env.MONITOR_DRY_RUN==='true'
const forceActivity=!dryRun && process.env.MONITOR_FORCE_ACTIVITY==='true'
const ownerRepo=process.env.GITHUB_REPOSITORY||''
const githubToken=process.env.GITHUB_TOKEN||''
const webhook=process.env.DISCORD_WEBHOOK_URL||''
const tipUrl=process.env.BYZE_TIP_URL||''
const blockTemplate=process.env.BYZE_BLOCK_URL_TEMPLATE||''
const txTemplate=process.env.BYZE_TX_URL_TEMPLATE||''
const origin='https://explorer.byze.org'
const valueMode=process.env.BYZE_VALUE_MODE||'byz'
const minConfirmations=Number(process.env.BYZE_CONFIRMATIONS||'6')
const scanMax=Number(process.env.BYZE_SCAN_MAX||'160')
const timeoutMs=12000
const activityPath=process.env.BYZE_ACTIVITY_FILE||''

function requireExplorerUrl(url) {
  const u=new URL(url)
  if (u.origin!==origin || u.username || u.password) throw new Error(`Only ${origin} HTTPS read URLs are allowed`)
  return u.href
}
function templateUrl(template, value) {
  if (!template.includes('{id}')) throw new Error('URL template must contain {id}')
  return requireExplorerUrl(template.replace('{id}',encodeURIComponent(String(value))))
}
async function jsonFetch(url, {method='GET',body=null,token='',headers={}}={}) {
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs)
  try {
    const response=await fetch(url,{
      method,signal:controller.signal,redirect:'error',
      headers:{'Accept':'application/json','User-Agent':'BYZE-P2Pool-Chain-Observer/1.0',...(token?{'Authorization':`Bearer ${token}`}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},
      ...(body?{body:JSON.stringify(body)}:{})
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} at ${new URL(url).pathname}`)
    if (Number(response.headers.get('content-length')||0)>2_000_000) throw new Error('Too much JSON data')
    const text=await response.text()
    if(text.length>2_000_000) throw new Error('JSON response exceeds size limit')
    try{return JSON.parse(text)}catch {throw new Error(`Invalid JSON at ${new URL(url).pathname}`)}
  } finally {clearTimeout(timer)}
}
async function github(path, method='GET', body) {
  if(!githubToken || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ownerRepo))throw new Error('GitHub token/repo missing')
  return jsonFetch(GITHUB_API+path, {method,body,token:githubToken,headers:{'X-GitHub-Api-Version':'2022-11-28'}})
}
async function loadState() {
  if (!githubToken || !ownerRepo) return {issue:null,state:null}
  const [owner,repo]=ownerRepo.split('/')
  const issues=await github(`/repos/${owner}/${repo}/issues?state=open&per_page=100`)
  const issue=issues.find(x=>!x.pull_request && x.title==='BYZE P2Pool chain-monitor state (automated)' && x.body?.startsWith(MARKER))
  if (!issue) return {issue:null,state:null}
  const raw=issue.body.slice(MARKER.length).trim()
  const state=JSON.parse(raw)
  if(state.schema!==1 || !Array.isArray(state.seen) || typeof state.blocks!=='object' || state.lastHeight<0) throw new Error('Invalid saved state (fail closed)')
  return {issue,state}
}
async function persist(issue, state) {
  const [owner,repo]=ownerRepo.split('/')
  const serialized=`${MARKER}\n${JSON.stringify(state)}`
  if(issue) await github(`/repos/${owner}/${repo}/issues/${issue.number}`,'PATCH',{body:serialized})
  else await github(`/repos/${owner}/${repo}/issues`,'POST',{title:'BYZE P2Pool chain-monitor state (automated)',body:serialized})
}
async function sendDiscord(content) {
  const u=new URL(webhook)
  if(u.protocol!=='https:' || !['discord.com','discordapp.com'].includes(u.hostname) || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/.test(u.pathname)) throw new Error('Invalid Discord webhook host/path')
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs)
  try{
    const r=await fetch(webhook,{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({content,allowed_mentions:{parse:[]}})})
    if(!r.ok)throw new Error(`Discord webhook HTTP ${r.status}`)
  } finally {clearTimeout(timer)}
}
async function main() {
  if (!tipUrl || !blockTemplate) throw new Error('Unconfigured explorer endpoints: set BYZE_TIP_URL and BYZE_BLOCK_URL_TEMPLATE repository variables after validating live JSON schemas.')
  if (!['byz','sats'].includes(valueMode)) throw new Error('BYZE_VALUE_MODE must be byz or sats')
  if(!Number.isSafeInteger(minConfirmations)||minConfirmations<2||minConfirmations>50)throw new Error('Invalid confirmations threshold')
  if(!dryRun && (!githubToken||!ownerRepo||!webhook))throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY and DISCORD_WEBHOOK_URL required for enabled runs')
  const [tipJson,loaded]=await Promise.all([jsonFetch(requireExplorerUrl(tipUrl)),loadState()])
  const tip=tipHeight(tipJson)
  const range=makeScanRange(tip,loaded.state,{lookback:36,overlap:12,maxBlocks:scanMax})
  const blocks=[],candidates=[]
  const reviewed=verifiedAttributions()
  const alreadyPosted=new Set(loaded.state?.publishedBlocks||[])
  for (let height=range.start; height<=range.end; height++) {
    const json=await jsonFetch(templateUrl(blockTemplate,height))
    const meta=blockMetadata(json,height)
    let tx=meta.first
    if(typeof tx==='string' || !tx?.vout){
      const txid=typeof tx==='string'?tx:tx?.txid||tx?.hash
      if(!/^[0-9a-f]{64}$/i.test(txid||''))throw new Error(`Missing decoded coinbase txid at ${height}`)
      if(!txTemplate)throw new Error('BYZE_TX_URL_TEMPLATE required: block API does not include decoded coinbase transactions')
      tx=await jsonFetch(templateUrl(txTemplate,txid))
    }
    // Verification fails closed on bad decoding or malformed vouts, even for non-candidate blocks.
    coinbaseTx(tx)
    const checked=evaluateBlock(meta,tx,valueMode)
    if (checked.candidate) candidates.push(checked)
    blocks.push({height,hash:meta.hash})
  }
  // Reviewed attribution can arrive long after the 12-block overlap window.
  // Re-fetch up to 20 previously unreported attested blocks per run.
  for(const proof of [...reviewed.values()].filter(x=>x.height<range.start &&
      !alreadyPosted.has(x.hash) && tip-x.height+1>=minConfirmations).slice(0,20)) {
    const json=await jsonFetch(templateUrl(blockTemplate,proof.height))
    const meta=blockMetadata(json,proof.height)
    if(meta.hash!==proof.hash)continue // reorg: old attribution is no longer canonical
    let tx=meta.first
    if(typeof tx==='string'||!tx?.vout){
      const txid=typeof tx==='string'?tx:tx?.txid||tx?.hash
      if(!/^[0-9a-f]{64}$/i.test(txid||'')||!txTemplate)
        throw Error('Missing decoded reviewed coinbase at '+proof.height)
      tx=await jsonFetch(templateUrl(txTemplate,txid))
    }
    coinbaseTx(tx)
    const checked=evaluateBlock(meta,tx,valueMode)
    if(checked.candidate)candidates.push(checked)
  }
  const {state,newCandidates,reorgs}=stateFromScan(loaded.state,{tip,blocks},candidates,minConfirmations,Date.now())
  const digest={checked:{tip,start:range.start,blocks:blocks.length,minConfirmations},newCandidates,reorgs}
  const technicalReport=summarize(digest) // Retained in Actions evidence; never sent as public pool attribution.
  const previouslyPosted=alreadyPosted
  const blockMessages=[]
  for(const candidate of candidates) {
    const confirmations=tip-candidate.height+1
    const attribution=reviewed.get(candidate.hash)
    if(previouslyPosted.has(candidate.hash) ||
       !eligibleBlock(candidate,attribution,confirmations))continue
    const message=blockReport(candidate,{verified:true,confirmations,evidenceUrl:attribution.evidenceUrl})
    if(!message)throw Error('Reviewed block has incomplete or invalid payout outputs at '+candidate.height)
    blockMessages.push({hash:candidate.hash,height:candidate.height,message})
  }
  let activity=null
  if(activityPath && fs.existsSync(activityPath)) {
    try {activity=JSON.parse(fs.readFileSync(activityPath,'utf8'))}
    catch {console.error('P2Pool snapshot malformed; activity metrics will be marked unavailable')}
  }
  const activityDue=forceActivity || Math.floor(Date.now()/3600000)>Math.floor(Number(loaded.state?.lastActivityAt||0)/3600000)
  const activityMessage=activityReport({activity})
  const evidence={schema:2,source:origin,observedAt:new Date().toISOString(),
    scope:'Blockchain fee candidates are unverified; P2Pool block reports require reviewed attribution',
    feeAddress:policy.feeAddress,feeBasisPoints:policy.feeBasisPoints,tip,range,
    candidates,reorgs,newCandidates:newCandidates.map(x=>x.hash),reviewedBlocks:blockMessages.map(x=>x.hash),
    activity,technicalReport,activityReport:activityMessage,
    blockReports:blockMessages.map(x=>x.message)}
  if(process.env.BYZE_EVIDENCE_FILE){
    const target=path.resolve(process.env.BYZE_EVIDENCE_FILE)
    fs.mkdirSync(path.dirname(target),{recursive:true})
    fs.writeFileSync(target,JSON.stringify(evidence,null,2)+'\n',{flag:'w',mode:0o600})
  }
  console.log(JSON.stringify({dryRun,tip,range,
    feeCandidateCount:candidates.length,unverifiedCandidates:newCandidates.length,
    reviewedBlocksReady:blockMessages.length,reorgs,activityDue,
    activityPublishable:activityMessage!==null,
    activityReport:activityMessage,blockReports:blockMessages.map(x=>x.message)},null,2))
  if(dryRun)return
  // Fail closed: no payout report for a mere fee-address candidate.
  for(const row of blockMessages) {
    await sendDiscord(row.message)
    previouslyPosted.add(row.hash)
  }
  state.publishedBlocks=[...previouslyPosted].slice(-1200)
  if(activityDue && activityMessage) {
    await sendDiscord(activityMessage)
    state.lastActivityAt=Date.now()
  } else {
    // An empty/unavailable sample must not create Discord noise or consume the
    // hourly activity slot. A later run may post if a miner becomes visible.
    state.lastActivityAt=Number(loaded.state?.lastActivityAt||0)
  }
  state.lastReportAt=Number(loaded.state?.lastReportAt||0) // legacy field; no old candidate digest to Discord
  await persist(loaded.issue,state)
}
main().catch(e=>{console.error('BYZE_CHAIN_MONITOR_FAILED:',e.message);process.exitCode=1})
