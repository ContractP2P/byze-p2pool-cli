'use strict'

const crypto = require('crypto')

const MINING_PROTOCOL = 'contract-byze-p2pool-v1'
const DEFAULT_CELL_MAX_MEMBERS = 20
const DEFAULT_RELAY_BACKUPS = 2
const DEFAULT_RELAY_EPOCH_MS = 60_000
const DEFAULT_MAX_DIRECT_PAYEES = 400
const MAX_GLOBAL_CELL_CHECKPOINTS = 256
const MAX_CELL_MAX_MEMBERS = 64
const MAX_RELAY_BACKUPS = 5
const MAX_PAYOUT_ADDRESS_BYTES = 160
const MAX_SHARE_WORK = 2n ** 120n

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function normalizeHex64(value) {
  const text = String(value || '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(text) ? text : ''
}

function normalizePeerId(value) {
  return normalizeHex64(value)
}

function normalizePayoutAddress(value) {
  const text = String(value || '').replace(/[\r\n\0\s]/g, '').slice(0, MAX_PAYOUT_ADDRESS_BYTES)
  if (!text || !/^[A-Za-z0-9:._-]+$/.test(text)) return ''
  return text
}

function normalizeCellId(value) {
  const text = String(value || '').trim().slice(0, 96)
  return /^[A-Za-z0-9:._-]{3,96}$/.test(text) ? text : ''
}

function positiveBigInt(value, { allowZero = false, max = MAX_SHARE_WORK } = {}) {
  try {
    const n = typeof value === 'bigint' ? value : BigInt(String(value))
    if (allowZero ? n < 0n : n <= 0n) return null
    if (n > max) return null
    return n
  } catch { return null }
}

function assignmentSeed({ byzeBlockHash, contractHash, assignmentEpoch }) {
  const block = normalizeHex64(byzeBlockHash)
  const contract = normalizeHex64(contractHash)
  const epoch = Math.max(0, Math.floor(Number(assignmentEpoch) || 0))
  if (!block || !contract) return ''
  return sha256Hex(Buffer.from(`${MINING_PROTOCOL}\0assign\0${block}\0${contract}\0${epoch}`))
}

function rendezvousScore(seed, peerId, cellId) {
  const safeSeed = normalizeHex64(seed)
  const peer = normalizePeerId(peerId)
  const cell = normalizeCellId(cellId)
  if (!safeSeed || !peer || !cell) return ''
  return sha256Hex(Buffer.from(`${MINING_PROTOCOL}\0rendezvous\0${safeSeed}\0${peer}\0${cell}`))
}

function deterministicNewCellId({ seed, existingCells = [] }) {
  const safeSeed = normalizeHex64(seed)
  if (!safeSeed) return ''
  const occupied = new Set((Array.isArray(existingCells) ? existingCells : []).map((cell) => normalizeCellId(cell?.id)).filter(Boolean))
  for (let ordinal = 1; ordinal <= 1_000_000; ordinal += 1) {
    const suffix = sha256Hex(Buffer.from(`${MINING_PROTOCOL}\0cell\0${safeSeed}\0${ordinal}`)).slice(0, 16)
    const id = `cell:${ordinal}:${suffix}`
    if (!occupied.has(id)) return id
  }
  return ''
}

function selectCellForPeer({ peerId, contractHash, byzeBlockHash, assignmentEpoch, cells = [], maxMembers = DEFAULT_CELL_MAX_MEMBERS }) {
  const peer = normalizePeerId(peerId)
  const limit = Math.max(2, Math.min(MAX_CELL_MAX_MEMBERS, Math.floor(Number(maxMembers) || DEFAULT_CELL_MAX_MEMBERS)))
  const seed = assignmentSeed({ byzeBlockHash, contractHash, assignmentEpoch })
  if (!peer || !seed) return { ok: false, code: 'miningAssignmentInputInvalid' }

  const normalized = (Array.isArray(cells) ? cells : []).map((cell) => ({
    id: normalizeCellId(cell?.id),
    memberCount: Math.max(0, Math.floor(Number(cell?.memberCount) || 0)),
    generation: Math.max(0, Math.floor(Number(cell?.generation) || 0))
  })).filter((cell) => cell.id && cell.memberCount <= limit)

  const open = normalized.filter((cell) => cell.memberCount < limit)
  if (!open.length) {
    const cellId = deterministicNewCellId({ seed, existingCells: normalized })
    return cellId ? { ok: true, cellId, created: true, seed, maxMembers: limit } : { ok: false, code: 'miningCellCreationFailed' }
  }

  const frontierCount = Math.max(...open.map((cell) => cell.memberCount))
  const frontier = open.filter((cell) => cell.memberCount === frontierCount)
  frontier.sort((a, b) => {
    const scoreA = rendezvousScore(seed, peer, a.id)
    const scoreB = rendezvousScore(seed, peer, b.id)
    return scoreB.localeCompare(scoreA) || a.id.localeCompare(b.id)
  })
  return { ok: true, cellId: frontier[0].id, created: false, seed, maxMembers: limit }
}

function relaySeed({ previousPoolShareId = '', byzeBlockHash = '', contractHash = '' }) {
  const prev = normalizeHex64(String(previousPoolShareId || '').replace(/^ps:/, ''))
  const block = normalizeHex64(byzeBlockHash)
  const contract = normalizeHex64(contractHash)
  if (!contract || (!prev && !block)) return ''
  return sha256Hex(Buffer.from(`${MINING_PROTOCOL}\0relay\0${prev || block}\0${contract}`))
}

function electCellRelays({ members = [], cellId, epoch, seed, backups = DEFAULT_RELAY_BACKUPS }) {
  const cell = normalizeCellId(cellId)
  const safeSeed = normalizeHex64(seed)
  const safeEpoch = Math.max(0, Math.floor(Number(epoch) || 0))
  const backupCount = Math.max(0, Math.min(MAX_RELAY_BACKUPS, Math.floor(Number(backups) || 0)))
  if (!cell || !safeSeed) return { ok: false, code: 'miningRelayInputInvalid' }
  const peers = [...new Set((Array.isArray(members) ? members : []).map((member) => normalizePeerId(member?.peerId || member?.peerKey || member)).filter(Boolean))]
  if (!peers.length) return { ok: false, code: 'miningRelayNoEligiblePeer' }
  peers.sort((a, b) => {
    const sa = sha256Hex(Buffer.from(`${MINING_PROTOCOL}\0relay-score\0${safeSeed}\0${cell}\0${safeEpoch}\0${a}`))
    const sb = sha256Hex(Buffer.from(`${MINING_PROTOCOL}\0relay-score\0${safeSeed}\0${cell}\0${safeEpoch}\0${b}`))
    return sb.localeCompare(sa) || a.localeCompare(b)
  })
  return { ok: true, primary: peers[0], backups: peers.slice(1, 1 + backupCount), ranking: peers }
}

function localShareSigningPayload(share) {
  return {
    protocol: MINING_PROTOCOL,
    kind: 'local-share',
    contractHash: normalizeHex64(share?.contractHash),
    poolId: String(share?.poolId || '').slice(0, 96),
    cellId: normalizeCellId(share?.cellId),
    epoch: Math.max(0, Math.floor(Number(share?.epoch) || 0)),
    jobId: String(share?.jobId || '').slice(0, 128),
    minerPeerId: normalizePeerId(share?.minerPeerId),
    payoutAddress: normalizePayoutAddress(share?.payoutAddress),
    nonce: String(share?.nonce || '').slice(0, 96),
    powHash: normalizeHex64(share?.powHash),
    work: String(share?.work || ''),
    createdAt: Math.max(1, Math.floor(Number(share?.createdAt) || 0))
  }
}

function localShareId(share) {
  const payload = localShareSigningPayload(share)
  return `ls:${sha256Hex(Buffer.from(`${MINING_PROTOCOL}\0local-share\0${canonical(payload)}`))}`
}

function validateLocalShareStructure(share) {
  if (!share || typeof share !== 'object') return { ok: false, code: 'miningShareInvalid' }
  const payload = localShareSigningPayload(share)
  if (!payload.contractHash || !payload.poolId || !payload.cellId || !payload.jobId || !payload.minerPeerId || !payload.payoutAddress || !payload.powHash) return { ok: false, code: 'miningShareInvalid' }
  const work = positiveBigInt(payload.work)
  if (work == null) return { ok: false, code: 'miningShareWorkInvalid' }
  const expected = localShareId(payload)
  if (String(share.shareId || '') !== expected) return { ok: false, code: 'miningShareIdInvalid' }
  return { ok: true, payload: { ...payload, shareId: expected }, work }
}

function merkleRootHex(ids) {
  let level = (Array.isArray(ids) ? ids : []).map((value) => sha256Hex(Buffer.from(String(value)))).sort()
  if (!level.length) return sha256Hex(Buffer.alloc(0))
  while (level.length > 1) {
    const next = []
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]
      const right = level[i + 1] || left
      next.push(sha256Hex(Buffer.from(left + right, 'hex')))
    }
    level = next
  }
  return level[0]
}

function buildCellCheckpoint({ contractHash, poolId, cellId, epoch, previousCheckpointId = '', shares = [] }) {
  const safeContract = normalizeHex64(contractHash)
  const safeCell = normalizeCellId(cellId)
  const safePool = String(poolId || '').slice(0, 96)
  if (!safeContract || !safeCell || !safePool) return { ok: false, code: 'miningCheckpointInvalid' }
  const unique = new Map()
  for (const raw of Array.isArray(shares) ? shares : []) {
    const checked = validateLocalShareStructure(raw)
    if (!checked.ok) return checked
    if (checked.payload.contractHash !== safeContract || checked.payload.poolId !== safePool || checked.payload.cellId !== safeCell || checked.payload.epoch !== Math.max(0, Math.floor(Number(epoch) || 0))) return { ok: false, code: 'miningCheckpointShareMismatch' }
    unique.set(checked.payload.shareId, { ...checked.payload, work: checked.work })
  }
  const rows = [...unique.values()].sort((a, b) => a.shareId.localeCompare(b.shareId))
  const workByMiner = new Map()
  const workByPayout = new Map()
  let totalWork = 0n
  for (const share of rows) {
    totalWork += share.work
    workByMiner.set(share.minerPeerId, (workByMiner.get(share.minerPeerId) || 0n) + share.work)
    workByPayout.set(share.payoutAddress, (workByPayout.get(share.payoutAddress) || 0n) + share.work)
  }
  const base = {
    protocol: MINING_PROTOCOL,
    kind: 'cell-checkpoint',
    contractHash: safeContract,
    poolId: safePool,
    cellId: safeCell,
    epoch: Math.max(0, Math.floor(Number(epoch) || 0)),
    previousCheckpointId: String(previousCheckpointId || '').slice(0, 80),
    shareCount: rows.length,
    shareRoot: merkleRootHex(rows.map((share) => share.shareId)),
    totalWork: totalWork.toString(),
    workByMiner: Object.fromEntries([...workByMiner.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value.toString()])),
    workByPayout: Object.fromEntries([...workByPayout.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value.toString()]))
  }
  const checkpointId = `cp:${sha256Hex(Buffer.from(`${MINING_PROTOCOL}\0checkpoint\0${canonical(base)}`))}`
  return { ok: true, checkpoint: { ...base, checkpointId } }
}

function buildGlobalEpochCheckpoint({ contractHash, poolId, epoch, cellCheckpoints = [] }) {
  const safeContract = normalizeHex64(contractHash)
  const safePool = String(poolId || '').slice(0, 96)
  const safeEpoch = Math.max(0, Math.floor(Number(epoch) || 0))
  if (!safeContract || !safePool) return { ok:false, code:'miningGlobalCheckpointInvalid' }

  const byCell = new Map()
  for (const raw of Array.isArray(cellCheckpoints) ? cellCheckpoints : []) {
    if (!raw || raw.kind !== 'cell-checkpoint' || !/^cp:[0-9a-f]{64}$/.test(String(raw.checkpointId || ''))) return { ok:false, code:'miningGlobalCheckpointCellInvalid' }
    if (raw.contractHash !== safeContract || raw.poolId !== safePool || Number(raw.epoch) !== safeEpoch) return { ok:false, code:'miningGlobalCheckpointCellMismatch' }
    const cellId = normalizeCellId(raw.cellId)
    const totalWork = positiveBigInt(raw.totalWork)
    if (!cellId || totalWork == null) return { ok:false, code:'miningGlobalCheckpointCellInvalid' }
    const payoutEntries = Object.entries(raw.workByPayout || {})
    if (!payoutEntries.length || payoutEntries.length > DEFAULT_MAX_DIRECT_PAYEES) return { ok:false, code:'miningGlobalCheckpointCellInvalid' }
    let payoutSum = 0n
    for (const [address, work] of payoutEntries) {
      const safeAddress = normalizePayoutAddress(address)
      const n = positiveBigInt(work)
      if (!safeAddress || n == null) return { ok:false, code:'miningGlobalCheckpointCellInvalid' }
      payoutSum += n
    }
    if (payoutSum !== totalWork) return { ok:false, code:'miningGlobalCheckpointCellWorkMismatch' }
    const prior = byCell.get(cellId)
    if (!prior) byCell.set(cellId, raw)
    else {
      const priorWork = positiveBigInt(prior.totalWork) || 0n
      if (totalWork > priorWork || (totalWork === priorWork && String(raw.checkpointId).localeCompare(String(prior.checkpointId)) < 0)) byCell.set(cellId, raw)
    }
  }
  const checkpoints = [...byCell.values()].sort((a,b) => String(a.cellId).localeCompare(String(b.cellId)) || String(a.checkpointId).localeCompare(String(b.checkpointId)))
  if (!checkpoints.length || checkpoints.length > MAX_GLOBAL_CELL_CHECKPOINTS) return { ok:false, code:'miningGlobalCheckpointCellCountInvalid' }

  const workByMiner = new Map()
  const workByPayout = new Map()
  const cellWork = {}
  let totalWork = 0n
  for (const cp of checkpoints) {
    const cpWork = positiveBigInt(cp.totalWork)
    if (cpWork == null) return { ok:false, code:'miningGlobalCheckpointCellInvalid' }
    totalWork += cpWork
    cellWork[cp.cellId] = cpWork.toString()
    for (const [peerId, work] of Object.entries(cp.workByMiner || {})) {
      const peer = normalizePeerId(peerId)
      const n = positiveBigInt(work)
      if (!peer || n == null) return { ok:false, code:'miningGlobalCheckpointMinerInvalid' }
      workByMiner.set(peer, (workByMiner.get(peer) || 0n) + n)
    }
    for (const [address, work] of Object.entries(cp.workByPayout || {})) {
      const safeAddress = normalizePayoutAddress(address)
      const n = positiveBigInt(work)
      if (!safeAddress || n == null) return { ok:false, code:'miningGlobalCheckpointPayoutInvalid' }
      workByPayout.set(safeAddress, (workByPayout.get(safeAddress) || 0n) + n)
    }
  }
  if (totalWork <= 0n || !workByPayout.size || workByPayout.size > DEFAULT_MAX_DIRECT_PAYEES) return { ok:false, code:'miningGlobalCheckpointWorkInvalid' }
  const payoutTotal = [...workByPayout.values()].reduce((sum,n)=>sum+n,0n)
  if (payoutTotal !== totalWork) return { ok:false, code:'miningGlobalCheckpointWorkMismatch' }

  const checkpointIds = checkpoints.map((cp) => cp.checkpointId)
  const globalCellId = `global:${sha256Hex(Buffer.from(`${MINING_PROTOCOL}\0global-cell\0${safeContract}\0${safePool}\0${safeEpoch}`)).slice(0, 24)}`
  const base = {
    protocol: MINING_PROTOCOL,
    kind: 'global-epoch-checkpoint',
    contractHash: safeContract,
    poolId: safePool,
    cellId: globalCellId,
    epoch: safeEpoch,
    cellCount: checkpoints.length,
    checkpointIds,
    checkpointRoot: merkleRootHex(checkpointIds),
    totalWork: totalWork.toString(),
    cellWork,
    workByMiner: Object.fromEntries([...workByMiner.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,v.toString()])),
    workByPayout: Object.fromEntries([...workByPayout.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,v.toString()]))
  }
  const checkpointId = `gc:${sha256Hex(Buffer.from(`${MINING_PROTOCOL}\0global-checkpoint\0${canonical(base)}`))}`
  return { ok:true, checkpoint:{ ...base, checkpointId }, cellCheckpoints:checkpoints }
}

function buildPoolShare({ checkpoint, previousPoolShareId = '', poolWork = null, byzeHeight = 0, byzePrevBlockHash = '' }) {
  if (!checkpoint || !['cell-checkpoint','global-epoch-checkpoint'].includes(String(checkpoint.kind || '')) || !/^(?:cp|gc):[0-9a-f]{64}$/.test(String(checkpoint.checkpointId || ''))) return { ok: false, code: 'miningPoolShareCheckpointInvalid' }
  const checkpointWork = positiveBigInt(checkpoint.totalWork)
  const work = poolWork == null ? checkpointWork : positiveBigInt(poolWork)
  if (checkpointWork == null || work == null || work > checkpointWork) return { ok: false, code: 'miningPoolShareWorkInvalid' }
  const prevHash = String(previousPoolShareId || '').replace(/^ps:/, '')
  if (prevHash && !normalizeHex64(prevHash)) return { ok: false, code: 'miningPoolSharePreviousInvalid' }
  const block = normalizeHex64(byzePrevBlockHash)
  if (!block) return { ok: false, code: 'miningPoolShareTipInvalid' }
  const base = {
    protocol: MINING_PROTOCOL,
    kind: 'pool-share',
    contractHash: checkpoint.contractHash,
    poolId: checkpoint.poolId,
    cellId: checkpoint.cellId,
    checkpointId: checkpoint.checkpointId,
    previousPoolShareId: prevHash ? `ps:${prevHash}` : '',
    byzeHeight: Math.max(0, Math.floor(Number(byzeHeight) || 0)),
    byzePrevBlockHash: block,
    work: work.toString(),
    payoutWeights: checkpoint.workByPayout
  }
  const poolShareId = `ps:${sha256Hex(Buffer.from(`${MINING_PROTOCOL}\0pool-share\0${canonical(base)}`))}`
  return { ok: true, poolShare: { ...base, poolShareId } }
}

function bigintGcd(a, b) {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y) { const r = x % y; x = y; y = r }
  return x || 1n
}

function addFraction(aNum, aDen, bNum, bDen) {
  const g = bigintGcd(aDen, bDen)
  const left = bDen / g
  const right = aDen / g
  let num = aNum * left + bNum * right
  let den = aDen * left
  const reduce = bigintGcd(num, den)
  num /= reduce
  den /= reduce
  return { num, den }
}

function calculateDirectPayouts({ poolShares = [], rewardSatoshis, maxOutputs = DEFAULT_MAX_DIRECT_PAYEES, feeAddress = '', feeBasisPoints = 0 }) {
  const reward = positiveBigInt(rewardSatoshis, { allowZero: true, max: 21_000_000n * 100_000_000n })
  if (reward == null || reward <= 0n) return { ok: false, code: 'miningPayoutRewardInvalid' }
  const shares = Array.isArray(poolShares) ? poolShares : []
  if (!shares.length || shares.length > 4096) return { ok: false, code: 'miningPayoutPoolShareCountInvalid' }
  const limit = Math.max(1, Math.min(10_000, Math.floor(Number(maxOutputs) || DEFAULT_MAX_DIRECT_PAYEES)))
  const feeBps = Math.max(0, Math.min(10_000, Math.floor(Number(feeBasisPoints) || 0)))
  const normalizedFeeAddress = feeBps > 0 ? normalizePayoutAddress(feeAddress) : ''
  if (feeBps > 0 && !normalizedFeeAddress) return { ok: false, code: 'miningPayoutFeeAddressInvalid' }
  const feeSatoshis = feeBps > 0 ? (reward * BigInt(feeBps)) / 10_000n : 0n
  const minerReward = reward - feeSatoshis

  const weights = new Map()
  let totalPoolWork = 0n
  for (const share of shares) {
    if (!share || share.kind !== 'pool-share' || !/^ps:[0-9a-f]{64}$/.test(String(share.poolShareId || ''))) return { ok: false, code: 'miningPayoutPoolShareInvalid' }
    const poolWork = positiveBigInt(share.work)
    if (poolWork == null) return { ok: false, code: 'miningPayoutPoolShareInvalid' }
    const localWeights = Object.entries(share.payoutWeights || {})
      .map(([address, work]) => [normalizePayoutAddress(address), positiveBigInt(work)])
      .filter(([address, work]) => address && work != null)
    const localTotal = localWeights.reduce((sum, [, work]) => sum + work, 0n)
    if (localTotal <= 0n) return { ok: false, code: 'miningPayoutPoolShareInvalid' }

    for (const [address, localWork] of localWeights) {
      const prior = weights.get(address) || { num: 0n, den: 1n }
      weights.set(address, addFraction(prior.num, prior.den, poolWork * localWork, localTotal))
    }
    totalPoolWork += poolWork
  }
  if (totalPoolWork <= 0n || !weights.size) return { ok: false, code: 'miningPayoutNoWork' }
  if (weights.size > limit) return { ok: false, code: 'miningPayoutTooManyOutputs', outputs: weights.size, maxOutputs: limit }

  const rows = []
  let distributed = 0n
  for (const [address, weight] of weights.entries()) {
    const numerator = minerReward * weight.num
    const denominator = totalPoolWork * weight.den
    const amount = numerator / denominator
    const remainderNum = numerator % denominator
    distributed += amount
    rows.push({ address, amount, remainderNum, remainderDen: denominator })
  }

  let remainder = minerReward - distributed
  if (remainder < 0n) return { ok: false, code: 'miningPayoutInvariantFailed' }
  rows.sort((a, b) => {
    const left = a.remainderNum * b.remainderDen
    const right = b.remainderNum * a.remainderDen
    if (left !== right) return left > right ? -1 : 1
    return a.address.localeCompare(b.address)
  })
  for (let i = 0; remainder > 0n && rows.length; i = (i + 1) % rows.length) {
    rows[i].amount += 1n
    remainder -= 1n
  }

  if (feeSatoshis > 0n) {
    const existing = rows.find((row) => row.address === normalizedFeeAddress)
    if (existing) existing.amount += feeSatoshis
    else rows.push({ address: normalizedFeeAddress, amount: feeSatoshis, remainderNum: 0n, remainderDen: 1n })
  }
  const outputs = rows
    .filter((row) => row.amount > 0n)
    .sort((a, b) => a.address.localeCompare(b.address))
    .map((row) => ({ address: row.address, satoshis: row.amount.toString() }))
  if (outputs.length > limit) return { ok: false, code: 'miningPayoutTooManyOutputs', outputs: outputs.length, maxOutputs: limit }
  const sum = outputs.reduce((acc, row) => acc + BigInt(row.satoshis), 0n)
  if (sum !== reward) return { ok: false, code: 'miningPayoutInvariantFailed' }
  return { ok: true, outputs, totalSatoshis: reward.toString(), minerSatoshis: minerReward.toString(), feeSatoshis: feeSatoshis.toString(), feeBasisPoints: feeBps, feeAddress: normalizedFeeAddress }
}

module.exports = {
  MINING_PROTOCOL,
  DEFAULT_CELL_MAX_MEMBERS,
  DEFAULT_RELAY_BACKUPS,
  DEFAULT_RELAY_EPOCH_MS,
  DEFAULT_MAX_DIRECT_PAYEES,
  canonical,
  sha256Hex,
  assignmentSeed,
  rendezvousScore,
  deterministicNewCellId,
  selectCellForPeer,
  relaySeed,
  electCellRelays,
  localShareSigningPayload,
  localShareId,
  validateLocalShareStructure,
  merkleRootHex,
  buildCellCheckpoint,
  buildGlobalEpochCheckpoint,
  buildPoolShare,
  calculateDirectPayouts,
  normalizePayoutAddress
}
