'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const crypto=require('crypto')
const {
  buildJobCommitment,coinbaseMerkleBranch,applyCoinbaseMerkleBranch,
  verifyCoinbaseBinding,headerMerkleRootInternalHex,decimalCoinsToSatoshis
}=require('../src/mining/mining-job-commitment')

function sha256d(buf){return crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest()}
function fakeTxidHex(label){return sha256d(Buffer.from(label)).reverse().toString('hex')}
function headerWithInternalRoot(rootInternalHex,height=123456){const h=Buffer.alloc(80);h.writeUInt32LE(1,0);Buffer.from(rootInternalHex,'hex').copy(h,36);h.writeUInt32LE(0x1d00ffff,72);return h.toString('hex')}
function heightScriptHex(height){
  let n=BigInt(height),bytes=[];while(n){bytes.push(Number(n&255n));n>>=8n}if(!bytes.length)bytes=[0];if(bytes[bytes.length-1]&0x80)bytes.push(0)
  return Buffer.from([bytes.length,...bytes,...Buffer.from('/byze-miner/test/')]).toString('hex')
}
const witness='6a24aa21a9ed'+'11'.repeat(32)
function decodedFor({txid,height=123456,outputs}){return {txid,vin:[{coinbase:heightScriptHex(height)}],vout:[...outputs.map(o=>({value:Number(BigInt(o.satoshis))/1e8,scriptPubKey:{hex:o.script}})),{value:0,scriptPubKey:{hex:witness}}]}}
function commitment(){return buildJobCommitment({contractHash:'aa'.repeat(32),poolId:'byze-main-p2pool-v1',cellId:'cell-1',templateHash:'bb'.repeat(32),feePolicyHash:'cc'.repeat(32),pplnsTipId:'ps:'+'dd'.repeat(32),coinbaseValue:'5000000000',coinbaseOutputs:[{address:'byz1minerHonest0000000000000000000000000000000000000000000000',satoshis:'4975000000',script:'0014'+'22'.repeat(20)},{address:'byz1ptlyn7q58zyhht8lds0u58n6mf4vehx6ds8gkax0vmtc49az2w9eqgqsm5p',satoshis:'25000000',script:'0014'+'33'.repeat(20)}]})}

test('job commitment fixes payout scripts, values, PPLNS tip and fee policy',()=>{const c=commitment();assert.equal(c.ok,true);assert.match(c.jobCommitmentHash,/^[0-9a-f]{64}$/);const changed=buildJobCommitment({...c,coinbaseOutputs:c.outputs.map((r,i)=>i?{...r,script:'0014'+'44'.repeat(20)}:r)});assert.equal(changed.ok,true);assert.notEqual(changed.jobCommitmentHash,c.jobCommitmentHash)})

test('coinbase Merkle branch reconstructs the same root as an independent full Merkle tree',()=>{
  const txid=fakeTxidHex('coinbase'),others=[fakeTxidHex('a'),fakeTxidHex('b'),fakeTxidHex('c')]
  const b=coinbaseMerkleBranch(others);assert.equal(b.ok,true)
  const root=applyCoinbaseMerkleBranch(txid,b.branch);assert.match(root,/^[0-9a-f]{64}$/)
  let level=[txid,...others].map(h=>Buffer.from(h,'hex').reverse())
  while(level.length>1){if(level.length%2)level.push(level[level.length-1]);const next=[];for(let i=0;i<level.length;i+=2)next.push(sha256d(Buffer.concat([level[i],level[i+1]])));level=next}
  assert.equal(root,level[0].toString('hex'))
  assert.equal(headerMerkleRootInternalHex(headerWithInternalRoot(root)),root)
})

test('verifyCoinbaseBinding accepts the exact PPLNS+fee coinbase',async()=>{const c=commitment();assert.equal(c.ok,true);const coinbaseHex='02'.repeat(80),txid=fakeTxidHex(coinbaseHex),others=[fakeTxidHex('a'),fakeTxidHex('b')],b=coinbaseMerkleBranch(others);const root=applyCoinbaseMerkleBranch(txid,b.branch);const rpc=async(m,p)=>{assert.equal(m,'decoderawtransaction');assert.equal(p[0],coinbaseHex);return decodedFor({txid,outputs:c.outputs})};const r=await verifyCoinbaseBinding({rpc,header80:headerWithInternalRoot(root),coinbaseNoWitnessHex:coinbaseHex,merkleBranch:b.branch,expectedCommitment:c,expectedHeight:123456});assert.equal(r.ok,true,JSON.stringify(r))})

test('verifyCoinbaseBinding rejects a 100% attacker coinbase even with valid PoW header binding',async()=>{const c=commitment();const coinbaseHex='03'.repeat(80),txid=fakeTxidHex(coinbaseHex),b=coinbaseMerkleBranch([]),root=applyCoinbaseMerkleBranch(txid,b.branch);const attacker=[{address:'byz1attackerwalletxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',satoshis:'5000000000',script:'0014'+'55'.repeat(20)}];const rpc=async()=>decodedFor({txid,outputs:attacker});const r=await verifyCoinbaseBinding({rpc,header80:headerWithInternalRoot(root),coinbaseNoWitnessHex:coinbaseHex,merkleBranch:b.branch,expectedCommitment:c,expectedHeight:123456});assert.equal(r.ok,false);assert.match(r.code,/OutputCountMismatch|OutputMismatch/)})

test('verifyCoinbaseBinding rejects a fake honest coinbase beside a header mined on another coinbase',async()=>{const c=commitment();const honestHex='04'.repeat(80),honestTxid=fakeTxidHex(honestHex),attackerTxid=fakeTxidHex('attacker-real'),b=coinbaseMerkleBranch([fakeTxidHex('tx1')]);const attackerRoot=applyCoinbaseMerkleBranch(attackerTxid,b.branch);const rpc=async()=>decodedFor({txid:honestTxid,outputs:c.outputs});const r=await verifyCoinbaseBinding({rpc,header80:headerWithInternalRoot(attackerRoot),coinbaseNoWitnessHex:honestHex,merkleBranch:b.branch,expectedCommitment:c,expectedHeight:123456});assert.equal(r.ok,false);assert.equal(r.code,'miningCoinbaseBindingMerkleMismatch')})

test('coinbase amount conversion remains satoshi-exact at 8 decimals',()=>{assert.equal(decimalCoinsToSatoshis('17.73840000'),1773840000n);assert.equal(decimalCoinsToSatoshis(0.25),25000000n)})
