'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const APP_ROOT = path.resolve(__dirname, '..', '..')
const MANIFEST_SCHEMA = 'byze-p2pool-native-manifest-v1'
const EXPECTED_NATIVE_SOURCE_COMMIT = 'd84db8a84ba4a06432fcdddbf1584b89a7e52379'

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

function executableName(kind, platform = process.platform) {
  const suffix = platform === 'win32' ? '.exe' : ''
  if (kind === 'miner') return `byze-p2pool-miner${suffix}`
  if (kind === 'verifier') return `byze-rxhash${suffix}`
  throw new Error(`Unknown native component kind: ${kind}`)
}

function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(1024 * 1024)
  try {
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (!n) break
      hash.update(buf.subarray(0, n))
    }
  } finally { fs.closeSync(fd) }
  return hash.digest('hex')
}

function isExecutable(file, platform = process.platform) {
  try {
    const mode = platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK
    fs.accessSync(file, mode)
    return fs.statSync(file).isFile()
  } catch { return false }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function managedNativeDir({ root = APP_ROOT, env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const explicit = String(env.BYZE_P2POOL_NATIVE_DIR || '').trim()
  return path.resolve(explicit || path.join(root, 'native', platformKey(platform, arch)))
}

function manifestPathFor(dir, root = APP_ROOT) {
  const local = path.join(dir, 'native-manifest.json')
  if (fs.existsSync(local)) return local
  return path.join(root, 'native', 'manifest.json')
}

function resolveManagedComponent(kind, opts = {}) {
  const root = opts.root || APP_ROOT
  const platform = opts.platform || process.platform
  const arch = opts.arch || process.arch
  const key = platformKey(platform, arch)
  const dir = managedNativeDir({ root, env: opts.env || process.env, platform, arch })
  const manifestFile = manifestPathFor(dir, root)
  const manifest = readJson(manifestFile)
  if (!manifest || manifest.schema !== MANIFEST_SCHEMA) {
    return { ok:false, code:'native-manifest-invalid', kind, dir, manifestFile, path:'' }
  }
  const entry = manifest.platforms?.[key]?.[kind]
  if (!entry || typeof entry !== 'object') {
    return { ok:false, code:'native-component-not-bundled', kind, dir, manifestFile, path:'' }
  }
  const filename = String(entry.filename || executableName(kind, platform))
  if (path.basename(filename) !== filename) {
    return { ok:false, code:'native-component-filename-invalid', kind, dir, manifestFile, path:'' }
  }
  const file = path.resolve(dir, filename)
  if (path.dirname(file) !== path.resolve(dir)) {
    return { ok:false, code:'native-component-path-invalid', kind, dir, manifestFile, path:'' }
  }
  try { if (fs.lstatSync(file).isSymbolicLink()) return { ok:false, code:'native-component-symlink-rejected', kind, dir, manifestFile, path:file } } catch {}
  if (!isExecutable(file, platform)) {
    return { ok:false, code:'native-component-missing', kind, dir, manifestFile, path:file }
  }
  const expected = String(entry.sha256 || '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return { ok:false, code:'native-component-checksum-missing', kind, dir, manifestFile, path:file }
  }
  const actual = sha256File(file)
  if (actual !== expected) {
    return { ok:false, code:'native-component-checksum-mismatch', kind, dir, manifestFile, path:file, expectedSha256:expected, actualSha256:actual }
  }
  const sourceCommit = String(entry.sourceCommit || '').toLowerCase()
  if (sourceCommit !== EXPECTED_NATIVE_SOURCE_COMMIT) {
    return { ok:false, code:'native-component-source-commit-mismatch', kind, dir, manifestFile, path:file, sourceCommit, expectedSourceCommit:EXPECTED_NATIVE_SOURCE_COMMIT }
  }
  return {
    ok:true,
    code:'ok',
    kind,
    dir,
    manifestFile,
    path:file,
    sha256:actual,
    feature:String(entry.feature || ''),
    sourceCommit,
    buildId:String(entry.buildId || '')
  }
}

function nativeBundleStatus(opts = {}) {
  const miner = resolveManagedComponent('miner', opts)
  const verifier = resolveManagedComponent('verifier', opts)
  return { platformKey:platformKey(opts.platform || process.platform, opts.arch || process.arch), dir:miner.dir || verifier.dir, miner, verifier }
}

module.exports = {
  APP_ROOT,
  MANIFEST_SCHEMA,
  platformKey,
  executableName,
  sha256File,
  managedNativeDir,
  resolveManagedComponent,
  nativeBundleStatus,
  EXPECTED_NATIVE_SOURCE_COMMIT
}
