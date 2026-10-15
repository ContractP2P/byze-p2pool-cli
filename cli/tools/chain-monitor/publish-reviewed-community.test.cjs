'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const {validatedManifestRows}=require('./publish-reviewed-community.cjs')

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
