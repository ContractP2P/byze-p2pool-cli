#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const APP_VERSION = require('../package.json').version
const {
  nativeBundleStatus,
  EXPECTED_NATIVE_SOURCE_COMMIT
} = require('../src/mining/native-components')

const ROOT = path.resolve(__dirname, '..')
const allowSourceRc = process.argv.includes('--source-rc')

let failed = false

function fail(msg) {
  failed = true
  console.error(`FAIL: ${msg}`)
}

function ok(msg) {
  console.log(`OK: ${msg}`)
}

function checkBlockingReleaseChecklist() {
  const checklistPath = path.join(ROOT, 'RELEASE-CHECKLIST.md')

  if (!fs.existsSync(checklistPath)) {
    fail('RELEASE-CHECKLIST.md missing')
    return
  }

  const text = fs.readFileSync(checklistPath, 'utf8')
  const lines = text.split(/\r?\n/)

  let inBlockingSection = false
  const open = []

  for (const line of lines) {
    if (/^##\s+Blocking public-release gates\s*$/i.test(line)) {
      inBlockingSection = true
      continue
    }

    if (inBlockingSection && /^##\s+/.test(line)) {
      break
    }

    if (!inBlockingSection) continue

    const match = line.match(/^\s*-\s*\[\s\]\s+(.+?)\s*$/)
    if (match) open.push(match[1])
  }

  if (!inBlockingSection) {
    fail('Blocking public-release gates section missing from RELEASE-CHECKLIST.md')
    return
  }

  if (open.length === 0) {
    ok('all blocking public-release checklist gates are complete')
    return
  }

  for (const item of open) {
    fail(`blocking release gate open: ${item}`)
  }
}

const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
)

const compat = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'COMPATIBILITY.json'), 'utf8')
)

if (
  pkg.version === APP_VERSION &&
  compat.cliVersion === APP_VERSION
) {
  ok(`version ${APP_VERSION} is consistent`)
} else {
  fail('package/CLI/compatibility versions differ')
}

if (
  compat.poolId === 'byze-main-p2pool-v1' &&
  compat.networkPolicy?.chain === 'main' &&
  compat.networkPolicy?.failClosed === true
) {
  ok('public network policy is fail-closed mainnet')
} else {
  fail('mainnet policy metadata is incomplete')
}

for (const rel of [
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY-NOTICES.md',
  'RELEASE-CHECKLIST.md',
  'config/pool-policy.json'
]) {
  if (fs.existsSync(path.join(ROOT, rel))) {
    ok(`${rel} present`)
  } else {
    fail(`${rel} missing`)
  }
}

if (pkg.license && pkg.license !== 'UNLICENSED') {
  ok(`CLI license declared: ${pkg.license}`)
} else if (allowSourceRc) {
  console.warn('SOURCE-RC: CLI publication license is not yet selected.')
} else {
  fail('CLI license is still UNLICENSED')
}

const native = nativeBundleStatus()

if (
  native.miner.ok &&
  native.verifier.ok &&
  native.miner.sourceCommit === EXPECTED_NATIVE_SOURCE_COMMIT &&
  native.verifier.sourceCommit === EXPECTED_NATIVE_SOURCE_COMMIT
) {
  ok(`native bundle verified for ${native.platformKey}`)
} else if (allowSourceRc) {
  console.warn(
    `SOURCE-RC: native bundle is intentionally absent/incomplete for ${native.platformKey}.`
  )
} else {
  fail(`native release bundle unavailable or invalid for ${native.platformKey}`)
}

if (!allowSourceRc) {
  checkBlockingReleaseChecklist()
}

if (failed) {
  if (allowSourceRc) {
    console.error('Source RC preflight FAILED.')
  } else {
    console.error('Public release preflight FAILED.')
  }
  process.exit(2)
}

console.log(
  allowSourceRc
    ? 'Source RC preflight passed. End-user release gates remain explicit.'
    : 'Public release preflight passed.'
)
