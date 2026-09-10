#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { nativeBundleStatus } = require('../src/mining/native-components')
const { PINNED_SOURCE_COMMIT, OFFICIAL_SOURCE_URL, verifyPinnedSource } = require('./lib/native-source-policy')

const ROOT = path.resolve(__dirname, '..')

function exec(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding:'utf8', windowsHide:true, ...opts })
}

function gitAvailable() { return exec('git', ['--version']).status === 0 }

function integrityFailure(status) {
  const rows = [status.miner, status.verifier]
  return rows.find((row) => row && [
    'native-component-checksum-mismatch',
    'native-component-symlink-rejected',
    'native-component-filename-invalid',
    'native-component-path-invalid',
    'native-component-source-commit-mismatch'
  ].includes(row.code))
}

function fetchPinnedOfficialSource() {
  if (!gitAvailable()) return ''
  const cacheRoot = path.join(ROOT, '.native-source-cache')
  const target = path.join(cacheRoot, `byze-miner-${PINNED_SOURCE_COMMIT.slice(0,12)}`)
  const current = fs.existsSync(target) ? verifyPinnedSource(target) : { ok:false }
  if (current.ok) return target
  fs.mkdirSync(cacheRoot, { recursive:true })
  fs.rmSync(target, { recursive:true, force:true })
  console.log('Developer bootstrap: fetching the pinned official byze-miner source…')
  let r = spawnSync('git', ['clone', '--no-checkout', '--filter=blob:none', OFFICIAL_SOURCE_URL, target], { stdio:'inherit' })
  if (r.status !== 0) { fs.rmSync(target,{recursive:true,force:true}); return '' }
  r = spawnSync('git', ['-C', target, 'checkout', '--detach', PINNED_SOURCE_COMMIT], { stdio:'inherit' })
  if (r.status !== 0) { fs.rmSync(target,{recursive:true,force:true}); return '' }
  r = spawnSync('git', ['-C', target, 'submodule', 'update', '--init', '--recursive'], { stdio:'inherit' })
  if (r.status !== 0) { fs.rmSync(target,{recursive:true,force:true}); return '' }
  const checked = verifyPinnedSource(target)
  if (!checked.ok) { fs.rmSync(target,{recursive:true,force:true}); return '' }
  return target
}

function main(argv = process.argv.slice(2)) {
  let status = nativeBundleStatus()
  if (status.miner.ok && status.verifier.ok) return 0
  const compromised = integrityFailure(status)
  if (compromised) {
    console.error(`ERROR: native component integrity failure (${compromised.code}). Refusing replacement.`)
    return 3
  }

  if (!argv.includes('--bootstrap-official')) {
    console.error('ERROR: managed native P2Pool components are missing for this platform.')
    console.error(`Expected directory: ${status.dir}`)
    console.error('Public releases must bundle prebuilt, checksum-pinned native components.')
    console.error('Developer-only fallback: npm run native:bootstrap-official')
    return 4
  }

  const source = fetchPinnedOfficialSource()
  if (!source) {
    console.error('ERROR: unable to obtain and verify the pinned official byze-miner source.')
    return 5
  }
  const verified = verifyPinnedSource(source)
  if (!verified.ok) {
    console.error(`ERROR: pinned source verification failed (${verified.code}).`)
    return 6
  }
  console.log(`Developer bootstrap from pinned commit ${verified.commit}.`)
  const builder = path.join(ROOT, 'tools', 'build-native-bundle.js')
  const r = spawnSync(process.execPath, [builder, '--source', source], { stdio:'inherit', env:process.env })
  if (r.status !== 0) return Number.isInteger(r.status) ? r.status : 7
  status = nativeBundleStatus()
  if (!(status.miner.ok && status.verifier.ok)) {
    console.error('ERROR: native build completed but managed components failed verification.')
    return 8
  }
  console.log(`Managed developer bundle ready: ${status.platformKey}`)
  return 0
}

if (require.main === module) process.exitCode = main()
module.exports = { integrityFailure, fetchPinnedOfficialSource, main, PINNED_SOURCE_COMMIT, verifyPinnedSource }
