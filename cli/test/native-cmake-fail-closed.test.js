'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('native CMake transformations are fail-closed', () => {
  const file = path.join(
    __dirname,
    '..',
    'tools',
    'lib',
    'p2pool-native-source.js'
  )

  const source = fs.readFileSync(file, 'utf8')

  assert.match(
    source,
    /function replaceCmakeRequired\(/,
    'CMake patch must use a required replacement helper'
  )

  assert.match(
    source,
    /P2Pool native CMake patch incompatible/,
    'Missing CMake patterns must cause a hard failure'
  )

  assert.match(source, /'Boost find_package'/)
  assert.match(source, /'Boost::system target'/)
  assert.match(source, /'native miner target name'/)
})
