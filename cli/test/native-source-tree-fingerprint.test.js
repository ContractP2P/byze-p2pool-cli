'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  sourceFingerprint
} = require('../tools/lib/p2pool-native-source')

function makeTree() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'byze-native-tree-')
  )

  fs.mkdirSync(path.join(root, 'src'), { recursive:true })
  fs.mkdirSync(
    path.join(root, 'third_party', 'randomx', 'src'),
    { recursive:true }
  )

  fs.writeFileSync(
    path.join(root, 'CMakeLists.txt'),
    'project(test)\n'
  )

  fs.writeFileSync(
    path.join(root, 'src', 'main.cpp'),
    'int main() { return 0; }\n'
  )

  fs.writeFileSync(
    path.join(root, 'src', 'byze_rxhash.cpp'),
    'void rx() {}\n'
  )

  fs.writeFileSync(
    path.join(root, 'third_party', 'randomx', 'src', 'dataset.cpp'),
    'version A\n'
  )

  return root
}

test('native source fingerprint covers the complete build source tree', () => {
  const root = makeTree()

  try {
    const before = sourceFingerprint(root)

    fs.writeFileSync(
      path.join(root, 'third_party', 'randomx', 'src', 'dataset.cpp'),
      'version B\n'
    )

    const after = sourceFingerprint(root)

    assert.notDeepEqual(
      after,
      before,
      'Changing an arbitrary native source file must change the fingerprint'
    )
  } finally {
    fs.rmSync(root, { recursive:true, force:true })
  }
})

test('native source fingerprint rejects symlinks', () => {
  const root = makeTree()

  try {
    fs.symlinkSync(
      path.join(root, 'src', 'main.cpp'),
      path.join(root, 'src', 'linked.cpp')
    )

    assert.throws(
      () => sourceFingerprint(root),
      /Symlink forbidden/
    )
  } finally {
    fs.rmSync(root, { recursive:true, force:true })
  }
})
