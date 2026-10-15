#!/usr/bin/env node
'use strict'
// Validate the exact contents of a staged *experimental* Linux x64 bundle.
// This is not a release-signature or BYZE Core integration substitute.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

function check(root) {
  const resolved = path.resolve(root)
  const required = [
    'bin/node', 'bin/byze-p2pool', 'app/package.json',
    'app/src/byze-p2pool.js', 'app/config/pool-policy.json',
    'app/node_modules/hyperswarm/package.json',
    'app/node_modules/hyperdht/package.json',
    'app/native/linux-x64/byze-p2pool-miner',
    'app/native/linux-x64/byze-rxhash',
    'app/native/linux-x64/native-manifest.json',
    'app/licenses/RandomX-BSD-3-Clause.txt',
    'bin/byze-cli-lab',
    'app/tools/byze-lab-remote-cli.js',
    'app/tools/download-core.js',
    'app/THIRD_PARTY-NOTICES.md',
  ]
  for (const name of required) {
    const target = path.resolve(resolved, name)
    if (!target.startsWith(resolved + path.sep)) throw Error('Path escape')
    const info = fs.lstatSync(target)
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Unsafe bundle member: ' + name)
  }
  const runner = spawnSync(path.join(resolved, 'bin/node'),
    [path.join(resolved, 'app/src/byze-p2pool.js'), '--version'],
    { encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH || '/usr/bin:/bin' } })
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(resolved, 'app/package.json'), 'utf8')).version
  if (!/^\d+\.\d+\.\d+-[a-zA-Z0-9.-]+$/.test(String(packageVersion || '')) ||
      runner.status !== 0 || String(runner.stdout || '').trim() !== packageVersion) {
    throw Error('Portable JS runtime self-test failed')
  }
  const miner = spawnSync(path.join(resolved, 'app/native/linux-x64/byze-p2pool-miner'),
    ['--features'], { encoding: 'utf8', timeout: 5000 })
  if (miner.status !== 0 || !/contract-direct-coinbase-v2/.test(miner.stdout + miner.stderr)) {
    throw Error('Portable miner native capability missing')
  }
  // The managed native bundle has its own pinned-source + SHA256 checks.
  const manifest = require(path.join(resolved, 'app/native/linux-x64/native-manifest.json'))
  const officialPin = 'd84db8a84ba4a06432fcdddbf1584b89a7e52379'
  for (const entry of [manifest.platforms?.['linux-x64']?.miner,
                       manifest.platforms?.['linux-x64']?.verifier]) {
    if (!entry || entry.sourceCommit !== officialPin || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw Error('Missing pinned native manifest entry')
    }
    const filename = path.basename(entry.filename)
    const digest = crypto.createHash('sha256').update(
      fs.readFileSync(path.join(resolved, 'app/native/linux-x64', filename))).digest('hex')
    if (digest !== entry.sha256) throw Error('Native hash mismatch')
  }
  process.stdout.write('BYZE_P2POOL_PORTABLE_LAB_BUNDLE_VERIFIED\n')
}
if (require.main === module) {
  try { check(process.argv[2] || '') } catch (e) {
    console.error('PORTABLE LAB VERIFICATION FAILED:', e.message); process.exitCode = 1
  }
}
module.exports = { check }
