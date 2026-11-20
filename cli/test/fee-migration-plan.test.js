'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const {createPoolFeePolicy}=require('../src/mining/pool-fee-policy')
const {migrationPlan,verifyRpc}=require('../tools/plan-fee-migration')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const current=createPoolFeePolicy({poolId:'byze-main-p2pool-v1',feeBasisPoints:50,feeAddress:'byz1ptlyn7q58zyhht8lds0u58n6mf4vehx6ds8gkax0vmtc49az2w9eqgqsm5p'})
const candidate='byz1z'+'q'.repeat(58) // synthetic shape; must still be verified using validateaddress RPC
test('read-only fee migration plan changes policy hash but never config or wallet',()=>{
 const plan=migrationPlan(current,candidate)
 assert.equal(plan.splitsP2PDiscovery,true)
 assert.equal(plan.writesPerformed,false)
 assert.equal(plan.currentPolicyHash,current.policyHash)
 assert.notEqual(plan.proposedPolicyHash,current.policyHash)
 assert.equal(plan.feeBasisPoints,50)
 assert.equal(plan.proposedFeeAddress,candidate)
 assert.equal(current.feeAddress.startsWith('byz1p'),true)
})
test('fee plan rejects legacy, malformed and unchanged fee addresses',()=>{
 assert.throws(()=>migrationPlan(current,current.feeAddress))
 assert.throws(()=>migrationPlan(current,'byz1p'+'q'.repeat(58)))
 assert.throws(()=>migrationPlan(current,'byz1z'+'b'.repeat(58)))
 assert.throws(()=>migrationPlan(current,'byz1z'+'q'.repeat(57)))
})
test('fee planner verifies Core v0.3 and stateless script, not ownership',()=>{
 const file=path.join(os.tmpdir(),'fee-check-test-'+process.pid)
 fs.writeFileSync(file,'', {mode:0o700})
 try{
   const run=(cli,args)=>{
     if(args[0]==='getnetworkinfo')return '{"version":300}'
     if(args[0]==='validateaddress')return JSON.stringify({isvalid:true,scriptPubKey:'5220'+'22'.repeat(32)})
     throw Error('unexpected RPC')
   }
   assert.deepEqual(verifyRpc(file,candidate,{run}),{coreVersion:300,validStatelessAddress:true,spendabilityVerified:false})
   assert.throws(()=>verifyRpc(file,candidate,{run:(cli,args)=>args[0]==='getnetworkinfo'?'{"version":204}':'{}'}),/v0.3/)
   assert.throws(()=>verifyRpc(file,candidate,{run:(cli,args)=>args[0]==='getnetworkinfo'?'{"version":300}':'{"isvalid":false}'}),/valid witness-v2/)
 }finally{fs.rmSync(file,{force:true})}
})
