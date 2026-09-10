'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('fs')
const os=require('os')
const path=require('path')
const crypto=require('crypto')
const { resolveManagedComponent, platformKey, EXPECTED_NATIVE_SOURCE_COMMIT }=require('../src/mining/native-components')
const { discoverBinary }=require('../src/mining/native-bridge')

function sha(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'byze-p2pool-native-'))
  const miner=path.join(dir,process.platform==='win32'?'byze-p2pool-miner.exe':'byze-p2pool-miner')
  const verifier=path.join(dir,process.platform==='win32'?'byze-rxhash.exe':'byze-rxhash')
  fs.writeFileSync(miner,process.platform==='win32'?'fixture':'#!/bin/sh\necho contract-direct-coinbase-v2\n')
  fs.writeFileSync(verifier,process.platform==='win32'?'fixture':'#!/bin/sh\nexit 0\n')
  if(process.platform!=='win32'){fs.chmodSync(miner,0o755);fs.chmodSync(verifier,0o755)}
  const key=platformKey()
  fs.writeFileSync(path.join(dir,'native-manifest.json'),JSON.stringify({schema:'byze-p2pool-native-manifest-v1',platforms:{[key]:{miner:{filename:path.basename(miner),sha256:sha(miner),feature:'contract-direct-coinbase-v2',sourceCommit:EXPECTED_NATIVE_SOURCE_COMMIT},verifier:{filename:path.basename(verifier),sha256:sha(verifier),sourceCommit:EXPECTED_NATIVE_SOURCE_COMMIT}}}},null,2))
  return {dir,miner,verifier}
}

test('managed native resolver accepts only checksum-pinned P2Pool components',()=>{
  const f=fixture(), env={BYZE_P2POOL_NATIVE_DIR:f.dir}
  assert.equal(resolveManagedComponent('miner',{env}).ok,true)
  assert.equal(discoverBinary('miner',env),path.resolve(f.miner))
  fs.appendFileSync(f.miner,'tamper')
  assert.equal(resolveManagedComponent('miner',{env}).code,'native-component-checksum-mismatch')
  assert.equal(discoverBinary('miner',env),'')
})

test('managed resolver never falls back to PATH or a byze-miner checkout',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'byze-p2pool-empty-'))
  fs.writeFileSync(path.join(dir,'native-manifest.json'),JSON.stringify({schema:'byze-p2pool-native-manifest-v1',platforms:{}}))
  const env={BYZE_P2POOL_NATIVE_DIR:dir,PATH:process.env.PATH||'',HOME:os.homedir()}
  assert.equal(discoverBinary('miner',env),'')
  assert.equal(discoverBinary('verifier',env),'')
})

test('managed resolver rejects symlinked executables',()=>{
  if(process.platform==='win32')return
  const f=fixture()
  const real=path.join(f.dir,'real-miner')
  fs.renameSync(f.miner,real)
  fs.symlinkSync(real,f.miner)
  const manifest=JSON.parse(fs.readFileSync(path.join(f.dir,'native-manifest.json'),'utf8'))
  manifest.platforms[platformKey()].miner.sha256=sha(real)
  fs.writeFileSync(path.join(f.dir,'native-manifest.json'),JSON.stringify(manifest))
  assert.equal(resolveManagedComponent('miner',{env:{BYZE_P2POOL_NATIVE_DIR:f.dir}}).code,'native-component-symlink-rejected')
})

test('managed resolver rejects a manifest built from an unpinned upstream commit',()=>{
  const f=fixture()
  const manifestFile=path.join(f.dir,'native-manifest.json')
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'))
  manifest.platforms[platformKey()].miner.sourceCommit='0'.repeat(40)
  fs.writeFileSync(manifestFile,JSON.stringify(manifest))
  assert.equal(resolveManagedComponent('miner',{env:{BYZE_P2POOL_NATIVE_DIR:f.dir}}).code,'native-component-source-commit-mismatch')
})
