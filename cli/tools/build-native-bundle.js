#!/usr/bin/env node
'use strict'

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { sourceFingerprint, copySourceTree, patchP2PoolMinerSource } = require('./lib/p2pool-native-source')
const { PINNED_SOURCE_COMMIT, verifyPinnedSource } = require('./lib/native-source-policy')

const ROOT = path.resolve(__dirname, '..')
function arg(name) { const i=process.argv.indexOf(name); return i>=0 ? process.argv[i+1] : '' }
function flag(name) { return process.argv.includes(name) }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
function platformKey() { return `${process.platform}-${process.arch}` }
function same(a,b) { return JSON.stringify(a) === JSON.stringify(b) }
function run(cmd,args,opts={}) { const r=spawnSync(cmd,args,{stdio:'inherit',...opts}); if(r.status!==0)throw new Error(`${cmd} failed with exit ${r.status}`) }

const source = path.resolve(arg('--source') || '')
if (!source || !fs.existsSync(path.join(source,'src','main.cpp'))) {
  console.error('Usage: node tools/build-native-bundle.js --source /read-only/path/to/byze-miner [--prepare-only]')
  process.exit(2)
}

const sourceTrust = verifyPinnedSource(source)
if (!sourceTrust.ok) {
  console.error(`Refusing unpinned native source: ${sourceTrust.code}`)
  console.error(`Expected commit: ${PINNED_SOURCE_COMMIT}`)
  process.exit(3)
}
const before = sourceFingerprint(source)
const key = platformKey()
const work = path.join(ROOT, '.native-work', key, 'source')
const build = path.join(ROOT, '.native-work', key, 'build')
const outDir = path.join(ROOT, 'native', key)
copySourceTree(source, work)
patchP2PoolMinerSource(work)
const afterCopy = sourceFingerprint(source)
if (!same(before, afterCopy)) throw new Error('Upstream checkout changed while preparing P2Pool native source; aborting')

if (flag('--prepare-only')) {
  console.log(`Prepared isolated P2Pool source copy: ${work}`)
  console.log('Upstream checkout verified unchanged.')
  process.exit(0)
}

fs.rmSync(build,{recursive:true,force:true}); fs.mkdirSync(build,{recursive:true})
run('cmake',['-S',work,'-B',build,'-DCMAKE_BUILD_TYPE=Release'])
run('cmake',['--build',build,'--config','Release','-j',String(Math.max(1,Math.min(8,os.cpus().length)))])

const suffix=process.platform==='win32'?'.exe':''
const candidates=(name)=>[
  path.join(build,`${name}${suffix}`),
  path.join(build,'Release',`${name}${suffix}`)
]
const find=(name)=>candidates(name).find(fs.existsSync)
const miner=find('byze-p2pool-miner'), verifier=find('byze-rxhash')
if(!miner||!verifier)throw new Error('Native build completed but expected executables were not found')
fs.mkdirSync(outDir,{recursive:true})
const minerOut=path.join(outDir,`byze-p2pool-miner${suffix}`)
const verifierOut=path.join(outDir,`byze-rxhash${suffix}`)
fs.copyFileSync(miner,minerOut); fs.copyFileSync(verifier,verifierOut)
fs.copyFileSync(path.join(ROOT,'THIRD_PARTY-NOTICES.md'),path.join(outDir,'THIRD_PARTY-NOTICES.md'))
fs.cpSync(path.join(ROOT,'licenses'),path.join(outDir,'licenses'),{recursive:true})
if(process.platform!=='win32'){fs.chmodSync(minerOut,0o755);fs.chmodSync(verifierOut,0o755)}

const sourceCommit=sourceTrust.commit
const manifest={
  schema:'byze-p2pool-native-manifest-v1',
  platforms:{
    [key]:{
      miner:{filename:path.basename(minerOut),sha256:sha256(minerOut),feature:'contract-direct-coinbase-v2',sourceCommit,buildId:`pinned-${sourceCommit.slice(0,12)}`},
      verifier:{filename:path.basename(verifierOut),sha256:sha256(verifierOut),sourceCommit,buildId:`pinned-${sourceCommit.slice(0,12)}`}
    }
  }
}
fs.writeFileSync(path.join(outDir,'native-manifest.json'),JSON.stringify(manifest,null,2)+'\n')
const after = sourceFingerprint(source)
if (!same(before, after)) throw new Error('SECURITY FAILURE: upstream checkout changed during native build')
console.log(`Managed native bundle ready: ${outDir}`)
console.log('Upstream checkout verified unchanged.')
