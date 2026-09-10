'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('fs')
const path=require('path')
const { integrityFailure, PINNED_SOURCE_COMMIT }=require('../tools/ensure-native')

test('v0.2.5-rc1 public launcher does not auto-discover arbitrary local byze-miner checkouts',()=>{
  const text=fs.readFileSync(path.join(__dirname,'..','tools','ensure-native.js'),'utf8')
  assert.doesNotMatch(text,/homedir\(|Downloads.*byze-miner|ldev.*byze-miner|BYZE_P2POOL_MINER_SOURCE/)
  assert.match(text,/--bootstrap-official/)
  assert.match(PINNED_SOURCE_COMMIT,/^[0-9a-f]{40}$/)
})

test('native integrity or source-commit failures are never auto-replaced',()=>{
  for(const code of ['native-component-checksum-mismatch','native-component-symlink-rejected','native-component-source-commit-mismatch']){
    const bad=integrityFailure({miner:{code},verifier:{code:'native-component-missing'}})
    assert.equal(bad.code,code)
  }
  assert.equal(integrityFailure({miner:{code:'native-component-missing'},verifier:{code:'native-component-not-bundled'}}),undefined)
})
