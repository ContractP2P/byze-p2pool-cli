'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  FORK_HEIGHT, FORK_MARKER, checkPayoutScript, checkCoreVersion,
  checkTemplateCompatibility, checkCandidateCompatibility, headerVersion
} = require('../src/mining/byze-v03-compat')
const { PayoutAddressValidator } = require('../src/mining/payout-address')
const { coinbaseWeightBound } = require('../src/mining/block-weight')
const { publishQuantumBlock } = require('../src/mining/byze-block-publisher')
const { inspectNode, candidates } = require('../src/node-discovery')

const legacy = '5120' + '11'.repeat(32)
const stateless = '5220' + '22'.repeat(32)
const newAddress = 'byz1zteststatelessrecipient000000000000000000000'
const prev = '11'.repeat(32)
function blockHex(version) {
  const header = Buffer.alloc(80)
  header.writeUInt32LE(version >>> 0,0)
  // Only the version/header is inspected in fail-closed early rejection paths.
  return header.toString('hex') + '00'.repeat(40)
}

test('payout rules preserve legacy v1 and allow witness-v2 exactly at activation', () => {
  assert.equal(checkPayoutScript(legacy,1).ok,true)
  assert.equal(checkPayoutScript(legacy,FORK_HEIGHT).ok,true)
  assert.equal(checkPayoutScript(stateless,FORK_HEIGHT-1).code,'miningStatelessPayoutNotActive')
  assert.equal(checkPayoutScript(stateless,FORK_HEIGHT).ok,true)
  assert.equal(checkPayoutScript('0014'+'22'.repeat(20),FORK_HEIGHT).code,'miningPayoutScriptUnsupported')
  const v1=[{script:legacy}],v2=[{script:stateless}]
  assert.equal(coinbaseWeightBound(v1,FORK_HEIGHT-1),coinbaseWeightBound(v1,FORK_HEIGHT))
  assert.throws(()=>coinbaseWeightBound(v2,FORK_HEIGHT-1),/miningStatelessPayoutNotActive/)
  assert.equal(coinbaseWeightBound(v2,FORK_HEIGHT),coinbaseWeightBound(v1,FORK_HEIGHT))
})

test('template and header enforce Core v0.3 and version bit 4 at block 28000', () => {
  assert.equal(checkCoreVersion({version:204},FORK_HEIGHT-1).ok,true)
  assert.equal(checkCoreVersion({version:204},FORK_HEIGHT).code,'miningByzeCoreV03Required')
  assert.equal(checkTemplateCompatibility({height:FORK_HEIGHT-1,version:0x20000000},null).ok,true)
  assert.equal(checkTemplateCompatibility({height:FORK_HEIGHT,version:0x20000010},{version:300}).ok,true)
  assert.equal(checkTemplateCompatibility({height:FORK_HEIGHT,version:0x20000000},{version:300}).code,'miningForkMarkerMissing')
  assert.equal(checkTemplateCompatibility({height:FORK_HEIGHT,version:0x20000010},{version:204}).code,'miningByzeCoreV03Required')
  assert.equal(FORK_MARKER,16)
  assert.equal(headerVersion(blockHex(0x20000010)),0x20000010)
  assert.equal(checkCandidateCompatibility(blockHex(0x20000010),FORK_HEIGHT,0x20000010,{version:300}).ok,true)
  assert.equal(checkCandidateCompatibility(blockHex(0x20000000),FORK_HEIGHT,0x20000000,{version:300}).code,'miningForkMarkerMissing')
  assert.equal(checkCandidateCompatibility(blockHex(0x20000010),FORK_HEIGHT,0x20000000,{version:300}).code,'miningBlockTemplateVersionMismatch')
})

test('stateless address validator checks activation and RPC Core version, while old addresses remain valid', async () => {
  let blocks = FORK_HEIGHT-2, version=300
  const rpc = async method => {
    if (method==='validateaddress') return {isvalid:true,scriptPubKey:stateless}
    if (method==='getblockchaininfo') return {chain:'main',blocks,headers:blocks,initialblockdownload:false}
    if (method==='getnetworkinfo') return {version}
    throw Error('unexpected RPC')
  }
  const check = new PayoutAddressValidator(rpc)
  assert.equal((await check.validate(newAddress)).code,'miningStatelessPayoutNotActive')
  blocks = FORK_HEIGHT-1; version=204
  check.cache.clear()
  assert.equal((await check.validate(newAddress)).code,'miningByzeCoreV03Required')
  version=300
  check.cache.clear()
  assert.equal((await check.validate(newAddress)).ok,true)
  assert.equal((await check.validate(newAddress)).scriptPubKey,stateless)
  const oldCheck = new PayoutAddressValidator(async()=>({isvalid:true,scriptPubKey:legacy}))
  assert.equal((await oldCheck.validate('byz1plegacyaddress000000')).ok,true)
})

test('node discovery refuses outdated Core once the next block is 28000',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'p2pool-fork-gate-'))
  try {
    const cli=path.join(dir,'byze-cli')
    fs.writeFileSync(cli,'#!/bin/sh\nexit 0\n',{mode:0o700})
    let version=204
    const call=async (_file,method)=>{
      if(method==='getblockchaininfo')return {chain:'main',initialblockdownload:false,blocks:FORK_HEIGHT-1,headers:FORK_HEIGHT-1}
      if(method==='getnetworkinfo')return {version}
      throw Error('unexpected RPC')
    }
    const denied=await inspectNode({explicit:cli,call})
    assert.equal(denied.status,'not-ready')
    assert.equal(denied.observations[0].code,'miningByzeCoreV03Required')
    version=300
    assert.equal((await inspectNode({explicit:cli,call})).status,'ready')
    const paths=candidates({home:dir,pathValue:'',env:{PATH:''}})
    const exe = process.platform === 'win32' ? 'byze-cli.exe' : 'byze-cli'
    assert.ok(paths.some(row=>row.path.endsWith(path.join('ldev','byze-v0.3.0',exe))))
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
})

test('publisher fails closed on a missing fork bit or old Core, before block signing',async()=>{
  const calls=[]
  let version=300
  const rpc=async method=>{
    calls.push(method)
    if(method==='getblockchaininfo')return {chain:'main',blocks:FORK_HEIGHT-1}
    if(method==='getbestblockhash')return prev
    if(method==='getnetworkinfo')return {version}
    throw Error('should not sign or submit')
  }
  const raw=blockHex(0x20000000)
  const candidate={blockHex:raw,height:FORK_HEIGHT,previousBlockHash:prev,expectedVersion:0x20000000}
  assert.equal((await publishQuantumBlock({rpc,candidate,allowSubmit:true})).code,'miningForkMarkerMissing')
  assert.ok(!calls.includes('signpoolblock'))
  version=204
  candidate.blockHex=blockHex(0x20000010);candidate.expectedVersion=0x20000010
  assert.equal((await publishQuantumBlock({rpc,candidate,allowSubmit:true})).code,'miningByzeCoreV03Required')
  assert.ok(!calls.includes('signpoolblock'))
})
