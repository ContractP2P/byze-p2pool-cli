'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('native source trust policy must reject untracked files', () => {
  const file = path.join(
    __dirname,
    '..',
    'tools',
    'lib',
    'native-source-policy.js'
  )

  const source = fs.readFileSync(file, 'utf8')

  assert.match(
    source,
    /--untracked-files=all/,
    'Pinned native source validation must inspect all untracked files'
  )

  assert.doesNotMatch(
    source,
    /--untracked-files=no/,
    'Pinned native source validation must never ignore untracked files'
  )
})
