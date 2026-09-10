'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const crypto=require('crypto')
const {RANDOMX_PROOF_MODE,buildRandomxLocalShare,validateRandomxEnvelope,shareTargetFromNetworkTarget,targetFromCompactBits}=require('../src/mining/p2pool-randomx')
const {buildJobCommitment,coinbaseMerkleBranch,applyCoinbaseMerkleBranch,verifyCoinbaseBinding}=require('../src/mining/mining-job-commitment')
function sha256d(b){return crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest()}
function txid(label){return sha256d(Buffer.from(label)).reverse().toString('hex')}
function header(root,bits='1d00ffff'){const h=Buffer.alloc(80);h.writeUInt32LE(1,0);Buffer.from(root,'hex').copy(h,36);h.writeUInt32LE(Number.parseInt(bits,16),72);return h.toString('hex')}
function heightScriptHex(height){let n=BigInt(height),a=[];while(n){a.push(Number(n&255n));n>>=8n}if(a[a.length-1]&0x80)a.push(0);return Buffer.from([a.length,...a]).toString('hex')}
const witness='6a24aa21a9ed'+'11'.repeat(32)

test('P0 ATTACK: a share mined on 100% attacker coinbase is rejected before PPLNS credit',async()=>{
  const contractHash='aa'.repeat(32),poolId='byze-main-p2pool-v1',cellId='cell-1',peer='cc'.repeat(32),payout='byz1attackerwalletxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',feePolicyHash='dd'.repeat(32),templateHash='ee'.repeat(32),height=123456
  const bits='1d00ffff',networkTarget=targetFromCompactBits(bits),shareTarget=shareTargetFromNetworkTarget(networkTarget,256)
  const honestOutputs=[{address:payout,satoshis:'4975000000',script:'0014'+'22'.repeat(20)},{address:'byz1ptlyn7q58zyhht8lds0u58n6mf4vehx6ds8gkax0vmtc49az2w9eqgqsm5p',satoshis:'25000000',script:'0014'+'33'.repeat(20)}]
  const expected=buildJobCommitment({contractHash,poolId,cellId,templateHash,feePolicyHash,pplnsTipId:'',coinbaseValue:'5000000000',coinbaseOutputs:honestOutputs});assert.equal(expected.ok,true)
  const attackerHex='05'.repeat(80),attackerTxid=txid(attackerHex),branch=coinbaseMerkleBranch([]).branch,root=applyCoinbaseMerkleBranch(attackerTxid,branch),header80=header(root,bits)
  const built=buildRandomxLocalShare({contractHash,poolId,cellId,epoch:Math.floor(Date.now()/60000),minerPeerId:peer,payoutAddress:payout,jobId:'rxj:'+'11'.repeat(32),nonce:0,powHash:'00'.repeat(32),shareTarget});assert.equal(built.ok,true)
  const packet={proofMode:RANDOMX_PROOF_MODE,share:built.share,proof:{header80,networkTarget,shareTarget,previousBlockHash:'99'.repeat(32),templateHash,height,difficultyMultiplier:256,blockCandidate:true,jobCommitmentHash:expected.jobCommitmentHash,feePolicyHash,pplnsTipId:'',coinbaseValue:'5000000000',coinbaseNoWitnessHex:attackerHex,coinbaseMerkleBranch:branch},signature:'placeholder'}
  const structural=validateRandomxEnvelope(packet,{expectedPeerId:peer,expectedPayoutAddress:payout,expectedContractHash:contractHash,expectedPoolId:poolId,expectedCellId:cellId,now:Date.now()});assert.equal(structural.ok,true,structural.code)
  const attackerOutputs=[{satoshis:'5000000000',script:'0014'+'44'.repeat(20)}]
  const rpc=async()=>({txid:attackerTxid,vin:[{coinbase:heightScriptHex(height)}],vout:[...attackerOutputs.map(o=>({value:Number(BigInt(o.satoshis))/1e8,scriptPubKey:{hex:o.script}})),{value:0,scriptPubKey:{hex:witness}}]})
  const binding=await verifyCoinbaseBinding({rpc,header80,coinbaseNoWitnessHex:attackerHex,merkleBranch:branch,expectedCommitment:expected,expectedHeight:height})
  assert.equal(binding.ok,false,'attacker coinbase must never enter liveShares/PPLNS')
  assert.match(binding.code,/OutputCountMismatch|OutputMismatch/)
})
