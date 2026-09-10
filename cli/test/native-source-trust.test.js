'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('fs')
const path=require('path')
const { PINNED_SOURCE_COMMIT }=require('../tools/lib/native-source-policy')

test('native builder requires the pinned upstream git commit',()=>{
  const builder=fs.readFileSync(path.join(__dirname,'..','tools','build-native-bundle.js'),'utf8')
  const ensure=fs.readFileSync(path.join(__dirname,'..','tools','ensure-native.js'),'utf8')
  assert.match(builder,/verifyPinnedSource\(source\)/)
  assert.match(builder,/Refusing unpinned native source/)
  assert.match(ensure,/verifyPinnedSource\(target\)/)
  assert.match(PINNED_SOURCE_COMMIT,/^[0-9a-f]{40}$/)
})

test('CLI native patch helper matches Contract v0.15.85 Boost header-only portability definitions',()=>{
  const helper=fs.readFileSync(path.join(__dirname,'..','tools','lib','p2pool-native-source.js'),'utf8')
  assert.match(helper,/CONTRACT_BOOST_SYSTEM_HEADER_ONLY/)
  assert.match(helper,/BOOST_ERROR_CODE_HEADER_ONLY/)
  assert.match(helper,/BOOST_SYSTEM_NO_LIB/)
})
