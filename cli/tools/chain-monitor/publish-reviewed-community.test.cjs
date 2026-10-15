'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const {validatedManifestRows,validReviewUrl,validRandomxAudit}=require('./publish-reviewed-community.cjs')

test('accepts later reviewed PPLNS blocks without changing publisher code',()=>{
  for(const n of [1,2,3,10,100]){
    const rows=Array.from({length:n},(_,i)=>({height:21000+i}))
    assert.equal(validatedManifestRows({schema:1,reviewedBlocks:rows}),rows)
  }
})
test('rejects malformed, empty and oversized review manifests',()=>{
  for(const doc of [null,{}, {schema:2,reviewedBlocks:[{}]},
    {schema:1,reviewedBlocks:[]}, {schema:1,reviewedBlocks:'invalid'},
    {schema:1,reviewedBlocks:Array.from({length:101},()=>({}))}]){
    assert.throws(()=>validatedManifestRows(doc),/Invalid reviewed block manifest size/)
  }
})

test('every new reviewed block may link to its own GitHub issue or PR',()=>{
  for(const uri of [
    'https://github.com/ContractP2P/byze-p2pool-cli/issues/44',
    'https://github.com/ContractP2P/byze-p2pool-cli/issues/48',
    'https://github.com/ContractP2P/byze-p2pool-cli/pull/46'
  ])assert.equal(validReviewUrl(uri),true)
  for(const uri of [
    'https://github.com/ContractP2P/byze-p2pool-cli/issues/0',
    'https://github.com/ContractP2P/byze-p2pool-cli/issues/44?x=y',
    'https://github.com.evil.test/ContractP2P/byze-p2pool-cli/issues/44',
    'http://github.com/ContractP2P/byze-p2pool-cli/issues/44',
    'https://github.com/unknown/byze-p2pool-cli/issues/44'
  ])assert.equal(validReviewUrl(uri),false)
})
test('new blocks require a per-block native RandomX review count',()=>{
  assert.equal(validRandomxAudit(21153,{localProofsChecked:36,randomxUniqueHashesChecked:35,randomxHashMismatches:0}),true)
  assert.equal(validRandomxAudit(21153,{localProofsChecked:36,randomxUniqueHashesCombined:112,randomxHashMismatches:0}),false)
  assert.equal(validRandomxAudit(21153,{localProofsChecked:36,randomxUniqueHashesChecked:37,randomxHashMismatches:0}),false)
  assert.equal(validRandomxAudit(21153,{localProofsChecked:36,randomxUniqueHashesChecked:35,randomxHashMismatches:1}),false)
  assert.equal(validRandomxAudit(21128,{localProofsChecked:112,randomxUniqueHashesCombined:112,randomxHashMismatches:0}),true)
})
