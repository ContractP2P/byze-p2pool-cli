'use strict'

const crypto = require('crypto')

const LIVE_PROTOCOL = 'contract-byze-p2pool-live-v1'
const DEFAULT_TTL_MS = 90_000
const MAX_TTL_MS = 180_000
const MAX_MEMBERS = 64
const MAX_DETERMINISTIC_CELLS = 256

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function hex64(value) {
  const text = String(value || '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(text) ? text : ''
}

function safeText(value, max = 160) {
  return String(value ?? '').replace(/[\r\n\0]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, max)
}

function safePoolId(value) {
  const text = safeText(value, 96)
  return /^[A-Za-z0-9:._-]{3,96}$/.test(text) ? text : ''
}

function safeInstanceId(value) {
  const text = safeText(value, 96)
  return /^cfi1:[0-9a-f-]{36}$/i.test(text) ? text : ''
}

function safePayoutAddress(value) {
  const text = String(value || '').replace(/[\r\n\0\s]/g, '').slice(0, 160)
  return text && /^[A-Za-z0-9:._-]+$/.test(text) ? text : ''
}

function safeFeeBasisPoints(value) {
  const n = Math.floor(Number(value) || 0)
  return n >= 0 && n <= 10_000 ? n : 0
}

function normalizeMiningState(value) {
  const state = String(value || '').toUpperCase()
  return ['JOINED', 'MINING', 'PAUSED', 'STOPPED', 'LEFT'].includes(state) ? state : ''
}

function presenceSigningPayload(value) {
  const updatedAt = Math.max(1, Math.floor(Number(value?.updatedAt) || 0))
  const expiresAt = Math.max(updatedAt, Math.floor(Number(value?.expiresAt) || 0))
  const payload = {
    protocol: LIVE_PROTOCOL,
    kind: 'membership',
    peerKey: hex64(value?.peerKey),
    alias: safeText(value?.alias || 'Contact', 48) || 'Contact',
    instanceId: safeInstanceId(value?.instanceId),
    contractId: safeText(value?.contractId, 128),
    version: safeText(value?.version, 32),
    publisherKey: hex64(value?.publisherKey),
    sourceHash: hex64(value?.sourceHash),
    poolId: safePoolId(value?.poolId),
    payoutAddress: safePayoutAddress(value?.payoutAddress),
    miningState: normalizeMiningState(value?.miningState),
    updatedAt,
    expiresAt,
    seq: Math.max(1, Math.floor(Number(value?.seq) || 1))
  }
  const feePolicyHash = hex64(value?.feePolicyHash)
  const feeAddress = safePayoutAddress(value?.feeAddress)
  const feeBasisPoints = safeFeeBasisPoints(value?.feeBasisPoints)
  if (feePolicyHash || feeAddress || feeBasisPoints) Object.assign(payload, { feePolicyHash, feeBasisPoints, feeAddress })
  return payload
}

function validatePresenceShape(value, { now = Date.now(), expectedPeerKey = '' } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'miningPresenceInvalid' }
  const payload = presenceSigningPayload(value)
  if (!payload.peerKey || !payload.instanceId || !payload.contractId || !payload.version || !payload.publisherKey || !payload.sourceHash || !payload.poolId || !payload.payoutAddress || !payload.miningState) return { ok: false, code: 'miningPresenceInvalid' }
  if (expectedPeerKey && payload.peerKey !== hex64(expectedPeerKey)) return { ok: false, code: 'miningPresencePeerMismatch' }
  if (payload.expiresAt <= now - 5_000 || payload.expiresAt > payload.updatedAt + MAX_TTL_MS) return { ok: false, code: 'miningPresenceExpired' }
  if (payload.updatedAt > now + 60_000) return { ok: false, code: 'miningPresenceFuture' }
  return { ok: true, payload }
}

function membershipSeed({ contractHash, poolId }) {
  const contract = hex64(contractHash)
  const pool = safePoolId(poolId)
  if (!contract || !pool) return ''
  return sha256Hex(Buffer.from(`${LIVE_PROTOCOL}\0membership\0${contract}\0${pool}`))
}

function deterministicCellId(seed, index) {
  const safeSeed = hex64(seed)
  const ordinal = Math.max(0, Math.floor(Number(index) || 0))
  if (!safeSeed) return ''
  return `cell:${ordinal + 1}:${sha256Hex(Buffer.from(`${LIVE_PROTOCOL}\0cell\0${safeSeed}\0${ordinal}`)).slice(0, 16)}`
}

function isDeterministicCellId({ cellId, contractHash, poolId, maxCells = MAX_DETERMINISTIC_CELLS }) {
  const seed = membershipSeed({ contractHash, poolId })
  const text = String(cellId || '')
  const match = /^cell:(\d+):([0-9a-f]{16})$/.exec(text)
  const limit = Math.max(1, Math.min(MAX_DETERMINISTIC_CELLS, Math.floor(Number(maxCells) || MAX_DETERMINISTIC_CELLS)))
  if (!seed || !match) return false
  const ordinal = Number(match[1])
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > limit) return false
  return deterministicCellId(seed, ordinal - 1) === text
}

function assignLiveCells({ members = [], contractHash, poolId, maxMembers = 20 }) {
  const seed = membershipSeed({ contractHash, poolId })
  const limit = Math.max(2, Math.min(MAX_MEMBERS, Math.floor(Number(maxMembers) || 20)))
  if (!seed) return { ok: false, code: 'miningMembershipSeedInvalid' }
  const unique = new Map()
  for (const raw of Array.isArray(members) ? members : []) {
    const peerKey = hex64(raw?.peerKey || raw)
    if (!peerKey) continue
    const miningState = typeof raw === 'object' ? normalizeMiningState(raw?.miningState) : ''
    if (miningState && !['JOINED', 'MINING', 'PAUSED'].includes(miningState)) continue
    const existing = unique.get(peerKey)
    const next = typeof raw === 'object' ? { ...raw, peerKey } : { peerKey }
    if (!existing || Number(next.updatedAt || 0) >= Number(existing.updatedAt || 0)) unique.set(peerKey, next)
  }
  const ranked = [...unique.values()].sort((a, b) => {
    const sa = sha256Hex(Buffer.from(`${LIVE_PROTOCOL}\0rank\0${seed}\0${a.peerKey}`))
    const sb = sha256Hex(Buffer.from(`${LIVE_PROTOCOL}\0rank\0${seed}\0${b.peerKey}`))
    return sa.localeCompare(sb) || a.peerKey.localeCompare(b.peerKey)
  })
  const cells = []
  const byPeer = {}
  for (let offset = 0, index = 0; offset < ranked.length; offset += limit, index += 1) {
    const cellMembers = ranked.slice(offset, offset + limit)
    const id = deterministicCellId(seed, index)
    const cell = { id, index: index + 1, maxMembers: limit, members: cellMembers }
    cells.push(cell)
    for (const member of cellMembers) byPeer[member.peerKey] = id
  }
  return { ok: true, seed, maxMembers: limit, cells, byPeer }
}

function liveCellForPeer(args) {
  const assigned = assignLiveCells(args)
  if (!assigned.ok) return assigned
  const peerKey = hex64(args?.peerKey)
  const cellId = assigned.byPeer[peerKey] || ''
  const cell = assigned.cells.find((entry) => entry.id === cellId) || null
  return { ...assigned, cellId, cell }
}

module.exports = {
  LIVE_PROTOCOL,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  canonical,
  presenceSigningPayload,
  validatePresenceShape,
  membershipSeed,
  deterministicCellId,
  isDeterministicCellId,
  assignLiveCells,
  liveCellForPeer
}
