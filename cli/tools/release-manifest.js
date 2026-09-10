#!/usr/bin/env node
'use strict'
const fs=require('fs')
const path=require('path')
const crypto=require('crypto')
const APP_VERSION=require('../package.json').version
const { PINNED_SOURCE_COMMIT }=require('./lib/native-source-policy')

function arg(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:''}
function sha256(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}
const artifact=path.resolve(arg('--artifact')||'')
const out=path.resolve(arg('--out')||path.join(process.cwd(),'release-manifest.json'))
if(!artifact||!fs.existsSync(artifact)){console.error('Usage: node tools/release-manifest.js --artifact /path/to/release.zip [--out manifest.json]');process.exit(2)}
const root=path.resolve(__dirname,'..')
const compatibility=path.join(root,'COMPATIBILITY.json')
const policy=path.join(root,'config','pool-policy.json')
const manifest={schema:'byze-p2pool-release-manifest-v1',version:APP_VERSION,artifact:path.basename(artifact),artifactSha256:sha256(artifact),artifactBytes:fs.statSync(artifact).size,compatibilitySha256:sha256(compatibility),poolPolicySha256:sha256(policy),nativeSourceCommit:PINNED_SOURCE_COMMIT,createdAt:new Date().toISOString()}
fs.writeFileSync(out,JSON.stringify(manifest,null,2)+'\n')
console.log(out)
