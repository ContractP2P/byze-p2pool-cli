'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { hashMeetsTarget, sanitizeGbtTemplate, buildRandomxLocalShare, validateRandomxEnvelope, targetFromCompactBits, shareTargetFromNetworkTarget, RANDOMX_PROOF_MODE } = require('../src/mining/p2pool-randomx')
const { Supervisor } = require('../src/mining/native-bridge')
const { PayoutAddressValidator, TRANSIENT_PAYOUT_CODES } = require('../src/mining/payout-address')
const { transactionMetrics, blockWeight, coinbaseWeightBound, fitTemplateWeight, witnessCommitment, QUANTUM_TAIL_BYTES, MAX_BLOCK_WEIGHT } = require('../src/mining/block-weight')
const { publishQuantumBlock } = require('../src/mining/byze-block-publisher')
const { MinerApp, loadPolicy, sign, SECURITY_GENERATION } = require('../src/byze-p2pool')
const { presenceSigningPayload } = require('../src/mining/p2pool-membership')
const path = require('path')

const script = '5120' + '12'.repeat(32)
const address = 'byz1testaddress000000'
const outputs = n => Array.from({ length:n }, (_, i) => ({address:`byz1recipient${i}`,script,satoshis:'1'}))
const hash = b => crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest()
function compact(n) {
  if (n < 253) return Buffer.from([n])
  const b = Buffer.alloc(n <= 65535 ? 3 : 5)
  b[0] = n <= 65535 ? 253 : 254
  if (n <= 65535) b.writeUInt16LE(n, 1); else b.writeUInt32LE(n, 1)
  return b
}
function transaction({ outputScripts = [script], witness = false, scriptSig = '0101', nonce = 1 } = {}) {
  const version = Buffer.from('02000000', 'hex')
  const input = Buffer.concat([Buffer.from([1]), Buffer.alloc(32, nonce), Buffer.from('ffffffff', 'hex'), compact(scriptSig.length/2), Buffer.from(scriptSig,'hex'), Buffer.from('ffffffff','hex')])
  const vouts = Buffer.concat([compact(outputScripts.length), ...outputScripts.map(s => Buffer.concat([Buffer.alloc(8),compact(s.length/2),Buffer.from(s,'hex')]))])
  const locktime = Buffer.alloc(4)
  const stripped = Buffer.concat([version,input,vouts,locktime])
  const full = witness ? Buffer.concat([version,Buffer.from([0,1]),input,vouts,Buffer.from([1,32]),Buffer.alloc(32),locktime]) : stripped
  return { data:full.toString('hex'), stripped, full }
}
function template(txs = []) {
  return {version:1,previousblockhash:'11'.repeat(32),bits:'207fffff',curtime:1700000000,height:200,target:'7f'+'ff'.repeat(31),rules:['segwit'],coinbasevalue:5_000_000_000,weightlimit:MAX_BLOCK_WEIGHT,transactions:txs}
}
function gbtTx(options, fee = 1000, depends = []) {
  const tx = transaction(options)
  return {data:tx.data,...transactionMetrics(tx.data),fee,depends}
}
function block(txs, quantum = true) {
  const tail = quantum ? Buffer.concat([compact(2500),Buffer.alloc(2500),compact(7856),Buffer.alloc(7856),compact(100),Buffer.alloc(100)]) : Buffer.alloc(3)
  return Buffer.concat([Buffer.alloc(80),compact(txs.length),...txs.map(tx=>tx.full),tail]).toString('hex')
}

test('PoW compares the little-endian hash exactly once, including target boundaries', () => {
  const target = '00'.repeat(31) + '01'
  assert.equal(hashMeetsTarget('01' + '00'.repeat(31), target), true)
  assert.equal(hashMeetsTarget('02' + '00'.repeat(31), target), false)
  assert.equal(hashMeetsTarget('00'.repeat(31) + '01', target), false)
  assert.equal(hashMeetsTarget('00'.repeat(32), target), true)
  assert.equal(hashMeetsTarget('00'.repeat(32), '00'.repeat(32)), false)
  assert.equal(hashMeetsTarget('invalid', target), false)
  // Compare against a byte-wise uint256 comparison (same ordering as Core).
  for (let n = 0; n < 300; n++) {
    const raw = crypto.createHash('sha256').update(`hash${n}`).digest()
    const targetLE = crypto.createHash('sha256').update(`target${n}`).digest()
    let expected = true
    for (let i = 31; i >= 0; i--) { if (raw[i] !== targetLE[i]) { expected = raw[i] < targetLE[i]; break } }
    assert.equal(hashMeetsTarget(raw.toString('hex'), Buffer.from(targetLE).reverse().toString('hex')), expected)
  }
})

test('remote envelope and native bridge both reject the reversed-only share', async () => {
  const bits='1d00ffff', networkTarget=targetFromCompactBits(bits), shareTarget=shareTargetFromNetworkTarget(networkTarget,256)
  const powHash='00'.repeat(31)+'01'
  const header=Buffer.alloc(80); header.writeUInt32LE(parseInt(bits,16),72)
  const built=buildRandomxLocalShare({contractHash:'aa'.repeat(32),poolId:'pool-test',cellId:'cell-1',epoch:Math.floor(Date.now()/60000),minerPeerId:'bb'.repeat(32),payoutAddress:address,jobId:'rxj:'+'cc'.repeat(32),nonce:0,powHash,shareTarget})
  assert.equal(built.ok,true)
  const packet={proofMode:RANDOMX_PROOF_MODE,share:built.share,signature:'test',proof:{header80:header.toString('hex'),networkTarget,shareTarget,previousBlockHash:'11'.repeat(32),templateHash:'22'.repeat(32),height:200,difficultyMultiplier:256,blockCandidate:false,jobCommitmentHash:'33'.repeat(32),feePolicyHash:'44'.repeat(32),pplnsTipId:'',coinbaseValue:'5000000000',coinbaseNoWitnessHex:'00'.repeat(20),coinbaseMerkleBranch:[]}}
  assert.equal(validateRandomxEnvelope(packet).code,'miningRandomxTargetMiss')
  const supervisor=new Supervisor()
  supervisor.job={id:built.share.jobId,template:{target:networkTarget}}
  supervisor.verifier.verify=async()=>powHash
  supervisor.emitStatus=()=>{}
  let reply
  supervisor.send=r=>{reply=r}
  await supervisor.handleStratum({id:1,method:'mining.submit',params:['worker',header.toString('hex')+'00',built.share.jobId,'00'.repeat(20)]})
  assert.equal(reply.result,false)
  assert.equal(supervisor.accepted,0)
  assert.equal(supervisor.networkCandidates,0)
})

test('transaction and signed block weight match independent serialized sizes', () => {
  const tx = transaction({witness:true})
  const metrics = transactionMetrics(tx.data)
  assert.equal(metrics.weight, tx.stripped.length * 3 + tx.full.length)
  assert.equal(metrics.txid, hash(tx.stripped).reverse().toString('hex'))
  assert.equal(metrics.hash, hash(tx.full).reverse().toString('hex'))
  assert.equal(blockWeight(block([tx])), (80+1+QUANTUM_TAIL_BYTES)*4 + metrics.weight)
  assert.throws(() => transactionMetrics(tx.data.slice(0,-2)))
  assert.throws(() => transactionMetrics(tx.data+'00'))
  assert.throws(() => blockWeight(block([tx])+'00'))
})

test('coinbase budget covers 1 through 400 payees and CompactSize boundary', () => {
  for (const count of [1,20,100,251,252,253,400]) {
    const coinbase = transaction({outputScripts:[...outputs(count).map(o=>o.script),witnessCommitment([])],witness:true,scriptSig:'00'.repeat(100)})
    assert.equal(coinbaseWeightBound(outputs(count)), transactionMetrics(coinbase.data).weight)
  }
  assert.ok(coinbaseWeightBound(outputs(100)) > 8000)
})

test('full template retains payees, drops a dependent suffix and recomputes reward/witness', () => {
  const txs = [gbtTx({nonce:1},100),gbtTx({nonce:2,witness:true},200,[1]),gbtTx({nonce:3},300,[2])]
  const raw = template(txs)
  const sanitized = sanitizeGbtTemplate(raw)
  assert.equal(sanitized.ok,true)
  const all = fitTemplateWeight(sanitized.template,outputs(400))
  const tight = {...sanitized.template,weightlimit:all.weightBound-txs[2].weight-txs[1].weight}
  const result = fitTemplateWeight(tight,outputs(400))
  assert.equal(result.removed,2)
  assert.equal(result.template.transactions.length,1)
  assert.equal(result.template.coinbasevalue,raw.coinbasevalue-500)
  assert.equal(result.template.default_witness_commitment,witnessCommitment([txs[0]]))
  assert.ok(result.weightBound <= tight.weightlimit)
  assert.equal(raw.transactions.length,3,'original template is not mutated')
  assert.throws(()=>fitTemplateWeight({...tight,weightlimit:1000},outputs(400)))
})

test('template rejects missing fees, incorrect weight and forward dependencies', () => {
  const tx = gbtTx({})
  for (const change of [{fee:undefined},{weight:1},{depends:[1]},{hash:'00'.repeat(32)}]) {
    assert.equal(sanitizeGbtTemplate(template([{...tx,...change}])).ok,false)
  }
})

test('near-full 4-million-WU template fits 400 recipients and the signed quantum tail', () => {
  const txs=[]
  let weight=0
  for (let i=0;i<5000;i++) {
    const tx=gbtTx({outputScripts:['00'.repeat(1940)],nonce:(i%254)+1},1000)
    if(weight+tx.weight>MAX_BLOCK_WEIGHT-8000)break
    txs.push(tx);weight+=tx.weight
  }
  const result=fitTemplateWeight(template(txs),outputs(400))
  assert.ok(result.removed>0)
  assert.equal(result.template.coinbasevalue,5_000_000_000-result.removed*1000)
  const coinbase=transaction({outputScripts:[...outputs(400).map(o=>o.script),result.template.default_witness_commitment],witness:true,scriptSig:'00'.repeat(100)})
  const serialized=block([coinbase,...result.template.transactions.map(tx=>({full:Buffer.from(tx.data,'hex')}))])
  assert.equal(blockWeight(serialized),result.weightBound)
  assert.ok(result.weightBound<=MAX_BLOCK_WEIGHT)
})

test('publisher rejects an overweight signed block before proposal or submission', async () => {
  const huge = transaction({outputScripts:['00'.repeat(1_000_000)]})
  const signed = block([huge])
  const calls = []
  const rpc = async method => {
    calls.push(method)
    if (method==='getblockchaininfo') return {chain:'main'}
    if (method==='getbestblockhash') return '11'.repeat(32)
    if (method==='signpoolblock') return {hex:signed,quantum_signed:true}
    throw new Error('unexpected RPC')
  }
  const result = await publishQuantumBlock({rpc,candidate:{blockHex:block([transaction()]),previousBlockHash:'11'.repeat(32)},allowSubmit:true})
  assert.equal(result.code,'miningBlockWeightExceeded')
  assert.ok(!calls.includes('submitblock'))
  assert.ok(!calls.includes('getblocktemplate'))
})

test('publisher accepts a correctly weighted signed block after Core proposal validation', async () => {
  const signed=block([transaction({witness:true})])
  const calls=[]
  const rpc=async method=>{
    calls.push(method)
    if(method==='getblockchaininfo')return {chain:'main'}
    if(method==='getbestblockhash')return '11'.repeat(32)
    if(method==='signpoolblock')return {hex:signed,quantum_signed:true}
    return null
  }
  const result=await publishQuantumBlock({rpc,candidate:{blockHex:signed},allowSubmit:true})
  assert.equal(result.ok,true)
  assert.deepEqual(calls.slice(-2),['getblocktemplate','submitblock'])
})

test('payout validator distinguishes invalid, known unspendable, known quantum and unknown', async () => {
  const cases = [
    [{isvalid:false},{},'miningPayoutAddressInvalid'],
    [{isvalid:true,scriptPubKey:script},{unspendable:true},'miningPayoutUnspendable'],
    [{isvalid:true,scriptPubKey:'0014'+'11'.repeat(20)},{},'miningPayoutScriptUnsupported'],
    [{isvalid:true,scriptPubKey:script},{solvable:true,desc:`quantum_program(${script.slice(4)})`},'wallet-quantum'],
    [{isvalid:true,scriptPubKey:script},{solvable:true,desc:'rawtr(something)'},'unknown']
  ]
  for (const [validated,info,expected] of cases) {
    const warnings=[]
    const validator = new PayoutAddressValidator(async m=>m==='validateaddress'?validated:info,{warn:m=>warnings.push(m)})
    const result = await validator.validate(address,{local:true})
    assert.equal(result.code||result.spendability,expected)
    assert.equal(warnings.length,expected==='unknown'?1:0)
  }
})

test('RPC outages fail closed; absent wallet only leaves spendability unknown', async () => {
  const offline = new PayoutAddressValidator(async()=>{throw new Error('offline')})
  assert.equal((await offline.validate(address)).code,'miningPayoutValidationUnavailable')
  const noWallet = new PayoutAddressValidator(async m=>{if(m==='validateaddress')return {isvalid:true,scriptPubKey:script};throw new Error('no wallet')})
  assert.equal((await noWallet.validate(address,{local:true})).spendability,'unknown')
  assert.equal((await noWallet.validate(address+' ')).ok,false)
})

test('address cache coalesces RPC calls, expires and observes wallet classification changes', async () => {
  let now=1, calls=0, unsafe=false
  const validator = new PayoutAddressValidator(async m=>{calls++;return m==='validateaddress'?{isvalid:true,scriptPubKey:script}:{unspendable:unsafe}},{now:()=>now,ttlMs:100})
  const results=await Promise.all([validator.validate(address,{local:true}),validator.validate(address,{local:true})])
  assert.ok(results.every(r=>r.ok))
  assert.equal(calls,2)
  unsafe=true; now=102
  assert.equal((await validator.validate(address,{local:true})).code,'miningPayoutUnspendable')
})

test('remote addresses are judged without the local wallet and never warn', async () => {
  const methods=[], warnings=[]
  const validator = new PayoutAddressValidator(async m=>{methods.push(m);return m==='validateaddress'?{isvalid:true,scriptPubKey:script}:{unspendable:true}},{warn:m=>warnings.push(m)})
  const remote=await validator.validate(address)
  assert.equal(remote.ok,true)
  assert.equal(remote.spendability,'not-checked')
  assert.deepEqual(methods,['validateaddress'])
  assert.equal(warnings.length,0)
  // The same address as the miner's own payout address still gets the wallet check.
  assert.equal((await validator.validate(address,{local:true})).code,'miningPayoutUnspendable')
  assert.equal((await validator.validate(address)).ok,true)
  const flagged = new PayoutAddressValidator(async()=>({isvalid:true,scriptPubKey:script,unspendable:true}))
  assert.equal((await flagged.validate(address)).code,'miningPayoutUnspendable')
})

test('a payout plan reports an RPC outage as transient, not as an invalid script', async () => {
  assert.ok(TRANSIENT_PAYOUT_CODES.has('miningPayoutValidationUnavailable'))
  assert.ok(TRANSIENT_PAYOUT_CODES.has('miningPayoutValidationBusy'))
  let online=false
  const a=app(async m=>{if(!online)throw new Error('offline');return m==='validateaddress'?{isvalid:true,scriptPubKey:script}:{}})
  assert.equal((await a.buildDirectPlan('5000000000',{tipId:'',payoutAddress:address})).code,'miningPayoutValidationUnavailable')
  a.payoutValidator.cache.clear();online=true
  assert.equal((await a.buildDirectPlan('5000000000',{tipId:'',payoutAddress:address})).ok,true)
})

function app(rpc) {
  const policy=loadPolicy(path.join(__dirname,'../config/pool-policy.json'))
  const a=new MinerApp({alias:'test',wallet:address,threads:1,policy,byze:{call:rpc},noSubmit:true})
  a.peerKey=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),a.seed]),format:'der',type:'pkcs8'}).export({format:'der',type:'spki'}).subarray(-32).toString('hex')
  a.syncPoolHistory=()=>{}
  a.payoutValidator.warn=()=>{}
  return a
}

test('presence checks node validation before membership and refuses old generation', async () => {
  let valid=false
  const a=app(async m=>m==='validateaddress'?{isvalid:valid,scriptPubKey:script}:{})
  const presence=a.selfPresence()
  assert.equal((await a.acceptPresence(a.peerKey,presence)).ok,false)
  assert.equal(a.remotePresence.size,0)
  a.payoutValidator.cache.clear();valid=true
  assert.equal((await a.acceptPresence(a.peerKey,presence)).ok,true)
  assert.equal(a.remotePresence.size,1)
  const legacy={...presence,securityGeneration:'coinbase-binding-v2-global-epoch-v4',seq:presence.seq+1}
  legacy.signature=sign(a.seed,presenceSigningPayload(legacy))
  assert.equal((await a.acceptPresence(a.peerKey,legacy)).code,'miningProtocolUpgradeRequired')
  assert.equal(presence.securityGeneration,SECURITY_GENERATION)
  const compatibility=require('../COMPATIBILITY.json')
  assert.equal(compatibility.securityGeneration,SECURITY_GENERATION)
  assert.equal(compatibility.discoveryTopic,a.discoveryTopic())
})

test('share recipient is checked even when absent from the historical payout plan', async () => {
  const a=app(async()=>({isvalid:false}))
  let built=false
  a.expectedCommitmentForProof=async()=>{built=true;return {ok:true}}
  const result=await a.verifyShareCoinbaseBinding({payload:{payoutAddress:address},proof:{}})
  assert.equal(result.code,'miningPayoutAddressInvalid')
  assert.equal(built,false)
})

test('refreshJob adjusts template and rebuilds payout amounts before handing job to miner', async () => {
  const txs=[gbtTx({outputScripts:['00'.repeat(30_000)],nonce:1},1000),gbtTx({outputScripts:['00'.repeat(30_000)],nonce:2},2000,[1])]
  const raw=template(txs)
  raw.weightlimit=200_000
  const a=app(async m=>{if(m==='getblocktemplate')return raw;if(m==='validateaddress')return {isvalid:true,scriptPubKey:script};return {}})
  a.live=()=>({cellId:'cell:1:1234567890abcdef',epoch:1})
  let job
  a.supervisor.setJob=j=>{job=j}
  assert.equal(await a.refreshJob(true),true)
  assert.equal(job.template.transactions.length,1)
  assert.equal(job.template.coinbasevalue,raw.coinbasevalue-2000)
  assert.equal(job.template.coinbaseoutputs.reduce((sum,o)=>sum+BigInt(o.value),0n),BigInt(raw.coinbasevalue-2000))
  assert.equal(job.template.default_witness_commitment,witnessCommitment([txs[0]]))
  assert.ok(a.jobContexts.has(job.id))
})
