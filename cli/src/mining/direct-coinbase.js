'use strict'
const crypto = require('crypto')
const MAX_DIRECT_OUTPUTS = 400
function canonical(v){ if(v===null||typeof v!=='object')return JSON.stringify(v); if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`; return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` }
function sha256(v){return crypto.createHash('sha256').update(v).digest('hex')}
function normalizePlan(outputs,rewardSatoshis,maxOutputs=MAX_DIRECT_OUTPUTS){
  if(!Array.isArray(outputs)||!outputs.length||outputs.length>maxOutputs)return {ok:false,code:'miningDirectCoinbaseOutputsInvalid'}
  let sum=0n; const rows=[]; const seen=new Set()
  for(const row of outputs){const address=String(row?.address||'').trim(); let sat; try{sat=BigInt(String(row?.satoshis))}catch{return {ok:false,code:'miningDirectCoinbaseValueInvalid'}}
    if(!/^[A-Za-z0-9:._-]{8,160}$/.test(address)||sat<=0n||seen.has(address))return {ok:false,code:'miningDirectCoinbaseOutputInvalid'}
    seen.add(address); sum+=sat; rows.push({address,satoshis:sat.toString()}) }
  let reward; try{reward=BigInt(String(rewardSatoshis))}catch{return {ok:false,code:'miningDirectCoinbaseRewardInvalid'}}
  if(sum!==reward)return {ok:false,code:'miningDirectCoinbaseConservation'}
  rows.sort((a,b)=>a.address.localeCompare(b.address))
  const commitment=sha256(Buffer.from(`contract-byze-p2pool-v1\0direct-coinbase\0${canonical(rows)}`))
  return {ok:true,outputs:rows,rewardSatoshis:reward.toString(),commitment}
}
async function resolveScripts(plan, resolver){
  if(!plan?.ok||typeof resolver!=='function')return {ok:false,code:'miningDirectCoinbasePlanInvalid'}
  const outputs=[]
  for(const row of plan.outputs){const result=await resolver(row.address); const script=String(result?.scriptPubKey||result?.script||'').toLowerCase(); if(!/^[0-9a-f]{4,10000}$/.test(script)||script.length%2)return {ok:false,code:'miningDirectCoinbaseScriptInvalid',address:row.address}; outputs.push({...row,script})}
  return {ok:true,outputs,commitment:plan.commitment,rewardSatoshis:plan.rewardSatoshis}
}
module.exports={MAX_DIRECT_OUTPUTS,normalizePlan,resolveScripts}
