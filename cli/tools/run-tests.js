'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// Expand filenames here because Windows npm shells do not expand globs.
const root = path.resolve(__dirname, '..')
const files = fs.readdirSync(path.join(root, 'test'))
  .filter(name => name.endsWith('.test.js')).sort()
  .map(name => path.join(root, 'test', name))
if (!files.length) throw new Error('No test files found')
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
