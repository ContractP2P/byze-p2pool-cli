'use strict'

// BYZE v0.3 mainnet consensus rules. Keep values aligned with the pinned Core release.
const FORK_HEIGHT = 28000
const FORK_MARKER = 1 << 4
const MIN_CORE_VERSION = 300

const LEGACY_PAYOUT = /^5120[0-9a-f]{64}$/
const STATELESS_PAYOUT = /^5220[0-9a-f]{64}$/

function payoutScriptKind(value) {
  const script = String(value || '').toLowerCase()
  if (LEGACY_PAYOUT.test(script)) return 'legacy'
  if (STATELESS_PAYOUT.test(script)) return 'stateless'
  return ''
}

function checkPayoutScript(script, height) {
  const kind = payoutScriptKind(script)
  if (!kind) return {ok:false, code:'miningPayoutScriptUnsupported'}
  if (kind === 'stateless' && (!Number.isSafeInteger(height) || height < FORK_HEIGHT)) {
    return {ok:false, code:'miningStatelessPayoutNotActive'}
  }
  return {ok:true, kind}
}

function checkCoreVersion(networkInfo, height) {
  if (!Number.isSafeInteger(height) || height < 1) return {ok:false, code:'miningForkHeightInvalid'}
  if (height < FORK_HEIGHT) return {ok:true}
  const version = Number(networkInfo?.version)
  if (!Number.isSafeInteger(version) || version < MIN_CORE_VERSION) {
    return {ok:false, code:'miningByzeCoreV03Required'}
  }
  return {ok:true}
}

function checkTemplateCompatibility(template, networkInfo) {
  const height = Number(template?.height)
  const version = Number(template?.version)
  if (!Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(version)) {
    return {ok:false, code:'miningForkTemplateInvalid'}
  }
  const core = checkCoreVersion(networkInfo, height)
  if (!core.ok) return core
  if (height >= FORK_HEIGHT && (version & FORK_MARKER) === 0) {
    return {ok:false, code:'miningForkMarkerMissing'}
  }
  return {ok:true}
}

function headerVersion(blockHex) {
  if (typeof blockHex !== 'string' || !/^[0-9a-f]{8}$/i.test(blockHex.slice(0, 8))) return null
  return Buffer.from(blockHex.slice(0, 8), 'hex').readUInt32LE(0)
}

function checkCandidateCompatibility(blockHex, height, expectedVersion, networkInfo) {
  const version = headerVersion(blockHex)
  if (version === null) return {ok:false, code:'miningBlockHeaderInvalid'}
  const core = checkCoreVersion(networkInfo, height)
  if (!core.ok) return core
  if (expectedVersion != null && (!Number.isSafeInteger(expectedVersion) || version !== (expectedVersion >>> 0))) {
    return {ok:false, code:'miningBlockTemplateVersionMismatch'}
  }
  if (height >= FORK_HEIGHT && (version & FORK_MARKER) === 0) {
    return {ok:false, code:'miningForkMarkerMissing'}
  }
  return {ok:true, version}
}

module.exports = {
  FORK_HEIGHT, FORK_MARKER, MIN_CORE_VERSION,
  payoutScriptKind, checkPayoutScript, checkCoreVersion,
  checkTemplateCompatibility, headerVersion, checkCandidateCompatibility
}
