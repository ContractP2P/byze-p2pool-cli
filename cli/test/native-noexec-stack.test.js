'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('Linux x64 native patch explicitly disables executable stack', () => {
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
    /\.note\.GNU-stack/,
    'RandomX assembly must declare GNU-stack metadata'
  )

  assert.match(
    source,
    /jit_compiler_x86_static\.S/,
    'GNU-stack hardening must target the RandomX x86 assembly source'
  )

  assert.match(
    source,
    /process\.platform === 'linux'/,
    'GNU-stack patch must be Linux-specific'
  )
})
