#!/usr/bin/env node
'use strict'

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const KEY = `${process.platform}-${process.arch}`

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : ''
}

function sha256(file) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')
}

function runBuild(source) {
  const work = path.join(ROOT, '.native-work', KEY)
  const out = path.join(ROOT, 'native', KEY)

  fs.rmSync(work, { recursive:true, force:true })
  fs.rmSync(out, { recursive:true, force:true })

  const builder = path.join(ROOT, 'tools', 'build-native-bundle.js')

  const r = spawnSync(
    process.execPath,
    [builder, '--source', source],
    { stdio:'inherit' }
  )

  if (r.status !== 0) {
    throw new Error(`Native build failed with exit ${r.status}`)
  }

  const files = [
    'byze-p2pool-miner' + (process.platform === 'win32' ? '.exe' : ''),
    'byze-rxhash' + (process.platform === 'win32' ? '.exe' : ''),
    'native-manifest.json'
  ]

  const result = {}

  for (const name of files) {
    const file = path.join(out, name)

    if (!fs.existsSync(file)) {
      throw new Error(`Expected build artifact missing: ${name}`)
    }

    result[name] = {
      path: file,
      sha256: sha256(file),
      bytes: fs.readFileSync(file)
    }
  }

  return result
}

const source = path.resolve(arg('--source') || '')

if (!source || !fs.existsSync(source)) {
  console.error(
    'Usage: node tools/reproducible-native-build.js --source /path/to/byze-miner'
  )
  process.exit(2)
}

const tmp = fs.mkdtempSync(
  path.join(os.tmpdir(), 'byze-native-repro-')
)

try {
  console.log('=== Reproducible native build #1 ===')
  const first = runBuild(source)

  for (const [name, info] of Object.entries(first)) {
    fs.writeFileSync(path.join(tmp, name), info.bytes)
  }

  console.log()
  console.log('=== Reproducible native build #2 ===')
  const second = runBuild(source)

  console.log()
  console.log('=== SHA-256 comparison ===')

  for (const name of Object.keys(first)) {
    console.log(`${name}`)
    console.log(`  build1: ${first[name].sha256}`)
    console.log(`  build2: ${second[name].sha256}`)

    if (first[name].sha256 !== second[name].sha256) {
      throw new Error(`NON-REPRODUCIBLE: SHA-256 differs for ${name}`)
    }

    if (!first[name].bytes.equals(second[name].bytes)) {
      throw new Error(`NON-REPRODUCIBLE: bytes differ for ${name}`)
    }
  }

  console.log()
  console.log(`OK: ${KEY} native bundle is bit-for-bit reproducible`)
} finally {
  fs.rmSync(tmp, { recursive:true, force:true })
}
