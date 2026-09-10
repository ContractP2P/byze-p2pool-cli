#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const CLI_ROOT = path.resolve(__dirname, '..')
const BUILD_ENV = path.join(CLI_ROOT, '.build-env')
const DOCKERFILE = path.join(BUILD_ENV, 'Dockerfile')

const IMAGE = 'byze-native-repro:0.2.5-rc1'
const PLATFORM = 'linux/amd64'

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

function run(command, args) {
  console.log()
  console.log(`> ${command} ${args.join(' ')}`)

  const result = spawnSync(command, args, {
    cwd: CLI_ROOT,
    stdio: 'inherit'
  })

  if (result.error) {
    fail(`${command}: ${result.error.message}`)
  }

  if (result.status !== 0) {
    process.exit(result.status === null ? 1 : result.status)
  }
}

if (!fs.existsSync(DOCKERFILE)) {
  fail(`missing Dockerfile: ${DOCKERFILE}`)
}

if (!fs.existsSync(path.join(BUILD_ENV, 'verify.sh'))) {
  fail('missing .build-env/verify.sh')
}

if (!fs.existsSync(path.join(BUILD_ENV, 'versions.json'))) {
  fail('missing .build-env/versions.json')
}

console.log('===== BYZE REPRODUCIBLE DOCKER BUILD =====')
console.log(`CLI root : ${CLI_ROOT}`)
console.log(`Platform : ${PLATFORM}`)
console.log(`Image    : ${IMAGE}`)

run('docker', ['version'])

console.log()
console.log('===== BUILD PINNED ENVIRONMENT =====')

run('docker', [
  'build',
  '--platform', PLATFORM,
  '--no-cache',
  '-t', IMAGE,
  '-f', DOCKERFILE,
  BUILD_ENV
])

console.log()
console.log('===== VERIFY REPRODUCIBLE ARTIFACTS =====')

const mount = `type=bind,src=${CLI_ROOT},dst=/src-cli,readonly`

run('docker', [
  'run',
  '--rm',
  '--platform', PLATFORM,
  '--mount', mount,
  IMAGE,
  '/bin/bash',
  '/src-cli/.build-env/verify.sh'
])

console.log()
console.log('==============================================')
console.log('OK: Docker reproducibility gate passed')
console.log('==============================================')
