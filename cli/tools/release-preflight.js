#!/usr/bin/env node
'use strict'

const fs=require('fs')
const path=require('path')
const APP_VERSION=require('../package.json').version
const { nativeBundleStatus, EXPECTED_NATIVE_SOURCE_COMMIT }=require('../src/mining/native-components')

const ROOT=path.resolve(__dirname,'..')
const allowSourceRc=process.argv.includes('--source-rc')
function fail(msg){console.error(`FAIL: ${msg}`);process.exitCode=2}
function ok(msg){console.log(`OK: ${msg}`)}

const pkg=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'))
const compat=JSON.parse(fs.readFileSync(path.join(ROOT,'COMPATIBILITY.json'),'utf8'))
if(pkg.version===APP_VERSION&&compat.cliVersion===APP_VERSION)ok(`version ${APP_VERSION} is consistent`);else fail('package/CLI/compatibility versions differ')
if(compat.poolId==='byze-main-p2pool-v1'&&compat.networkPolicy?.chain==='main'&&compat.networkPolicy?.failClosed===true)ok('public network policy is fail-closed mainnet');else fail('mainnet policy metadata is incomplete')
for(const rel of ['README.md','SECURITY.md','THIRD_PARTY-NOTICES.md','RELEASE-CHECKLIST.md','config/pool-policy.json','licenses/byze-miner-MIT.txt','licenses/RandomX-BSD-3-Clause.txt']){
  if(fs.existsSync(path.join(ROOT,rel)))ok(`${rel} present`);else fail(`${rel} missing`)
}
if(pkg.license&&pkg.license!=='UNLICENSED')ok(`CLI license declared: ${pkg.license}`);else if(allowSourceRc)console.warn('SOURCE-RC: CLI publication license is not yet selected.');else fail('CLI license is still UNLICENSED')
const native=nativeBundleStatus()
if(native.miner.ok&&native.verifier.ok&&native.miner.sourceCommit===EXPECTED_NATIVE_SOURCE_COMMIT&&native.verifier.sourceCommit===EXPECTED_NATIVE_SOURCE_COMMIT)ok(`native bundle verified for ${native.platformKey}`)
else if(allowSourceRc)console.warn(`SOURCE-RC: native bundle is intentionally absent/incomplete for ${native.platformKey}.`)
else fail(`native release bundle unavailable or invalid for ${native.platformKey}`)
if(process.exitCode)process.exit(process.exitCode)
console.log(allowSourceRc?'Source RC preflight passed. End-user release gates remain explicit.':'Public release preflight passed.')
