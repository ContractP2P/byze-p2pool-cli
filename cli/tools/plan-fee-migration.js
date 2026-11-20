#!/usr/bin/env node
'use strict'

// Read-only planner: NEVER writes pool-policy.json or touches a wallet.
const fs = require('node:fs')
const path = require('node:path')
const {execFileSync} = require('node:child_process')
const {loadPoolFeePolicy,createPoolFeePolicy} = require('../src/mining/pool-fee-policy')
const {payoutScriptKind,MIN_CORE_VERSION} = require('../src/mining/byze-v03-compat')

const STATELESS_ADDRESS = /^byz1z[023456789acdefghjklmnpqrstuvwxyz]{58}$/

function migrationPlan(current,candidate) {
  if (!current?.ok || !current.feeAddress) throw new Error('Current fee policy is invalid')
  if (!STATELESS_ADDRESS.test(String(candidate||''))) {
    throw new Error('Candidate must be a lowercase byz1z witness-v2 address; also verify checksum with Byze Core RPC')
  }
  if (candidate === current.feeAddress) throw new Error('Candidate must differ from current address')
  const proposed = createPoolFeePolicy({poolId:current.poolId,feeBasisPoints:current.feeBasisPoints,feeAddress:candidate})
  if (!proposed.ok || proposed.policyHash === current.policyHash) throw new Error('Invalid proposed policy')
  return {
    currentFeeAddress:current.feeAddress,
    currentPolicyHash:current.policyHash,
    proposedFeeAddress:proposed.feeAddress,
    proposedPolicyHash:proposed.policyHash,
    feeBasisPoints:proposed.feeBasisPoints,
    splitsP2PDiscovery:true,
    writesPerformed:false,
    warning:'This is a new P2P discovery topic. All miners must switch together after pending PPLNS rewards and fee-wallet ownership are reviewed.'
  }
}

function verifyRpc(cli,candidate,{run=execFileSync}={}) {
  if (!path.isAbsolute(cli) || !fs.existsSync(cli)) throw Error('Use an absolute existing --byze-cli PATH')
  const rpc=(method,args=[])=>{
    const raw=run(cli,[method,...args],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']})
    return JSON.parse(String(raw))
  }
  const network=rpc('getnetworkinfo')
  if (!Number.isSafeInteger(Number(network?.version)) || Number(network.version)<MIN_CORE_VERSION) {
    throw Error('Byze Core v0.3.0 or later is required')
  }
  const valid=rpc('validateaddress',[candidate])
  if(valid?.isvalid!==true || payoutScriptKind(valid.scriptPubKey)!=='stateless') {
    throw Error('Candidate must be a valid witness-v2 stateless BYZE address according to Core RPC')
  }
  return {coreVersion:network.version,validStatelessAddress:true,spendabilityVerified:false}
}

function main(argv=process.argv.slice(2)) {
  let candidate='',cli='',policy=path.resolve(__dirname,'../config/pool-policy.json')
  for(let i=0;i<argv.length;i+=2) {
    if (!argv[i+1] || argv[i+1].startsWith('--')) throw Error('Usage: node tools/plan-fee-migration.js --candidate byz1z... [--byze-cli /absolute/path] [--policy /absolute/path]')
    const key=argv[i],val=argv[i+1]
    if(key==='--candidate')candidate=val
    else if(key==='--byze-cli')cli=val
    else if(key==='--policy')policy=path.resolve(val)
    else throw Error('Unknown option')
  }
  if(!candidate)throw Error('Pass --candidate with a wallet-owned stateless address')
  const current=loadPoolFeePolicy({filePath:policy})
  const plan=migrationPlan(current,candidate)
  plan.rpcVerification=cli?verifyRpc(cli,candidate):{validStatelessAddress:false,spendabilityVerified:false,reason:'Supply --byze-cli to validate with Core RPC'}
  process.stdout.write(JSON.stringify(plan,null,2)+'\n')
}
if(require.main===module)try{main()}catch(e){console.error('Fee migration preflight failed: '+e.message);process.exitCode=1}
module.exports={STATELESS_ADDRESS,migrationPlan,verifyRpc,main}
