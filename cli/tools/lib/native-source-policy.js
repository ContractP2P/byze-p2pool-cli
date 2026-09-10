'use strict'

const { spawnSync } = require('child_process')

const PINNED_SOURCE_COMMIT = 'd84db8a84ba4a06432fcdddbf1584b89a7e52379'
const OFFICIAL_SOURCE_URL = 'https://github.com/powhermes/byze-miner.git'

function runGit(dir, args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding:'utf8', windowsHide:true })
}

function verifyPinnedSource(dir, { requireClean = true } = {}) {
  const head = runGit(dir, ['rev-parse', 'HEAD'])
  if (head.status !== 0) return { ok:false, code:'native-source-git-required' }
  const commit = String(head.stdout || '').trim().toLowerCase()
  if (commit !== PINNED_SOURCE_COMMIT) return { ok:false, code:'native-source-commit-mismatch', commit, expected:PINNED_SOURCE_COMMIT }
  if (requireClean) {
    const status = runGit(dir, ['status', '--porcelain', '--untracked-files=no'])
    if (status.status !== 0) return { ok:false, code:'native-source-status-failed' }
    if (String(status.stdout || '').trim()) return { ok:false, code:'native-source-dirty' }
  }
  const submodules = runGit(dir, ['submodule', 'status', '--recursive'])
  if (submodules.status !== 0) return { ok:false, code:'native-source-submodule-status-failed' }
  const bad = String(submodules.stdout || '').split(/\r?\n/).filter(Boolean).find((line) => /^[+-U]/.test(line))
  if (bad) return { ok:false, code:'native-source-submodule-mismatch', detail:bad }
  return { ok:true, commit }
}

module.exports = { PINNED_SOURCE_COMMIT, OFFICIAL_SOURCE_URL, verifyPinnedSource }
