'use strict'

const { transactionMetrics, MAX_BLOCK_WEIGHT } = require('./block-weight')

const {
  canonical,
  sha256Hex,
  localShareId,
  validateLocalShareStructure,
  buildCellCheckpoint,
  normalizePayoutAddress
} = require('./p2pool-protocol')

const RANDOMX_PROOF_MODE = 'byze-randomx-v2'
const RANDOMX_SHARE_DIFFICULTY_MULTIPLIER = 256
const MAX_RANDOMX_SHARE_AGE_MS = 3 * 60_000
const MAX_CLOCK_SKEW_MS = 60_000
const UINT256_MAX = (1n << 256n) - 1n

function hex64(value) {
  const text = String(value || '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(text) ? text : ''
}

function hex160(value) {
  const text = String(value || '').toLowerCase()
  return /^[0-9a-f]{160}$/.test(text) ? text : ''
}

function safeCoinbaseHex(value) {
  const text=String(value||'').toLowerCase()
  return /^[0-9a-f]+$/.test(text) && !(text.length%2) && text.length>=20 && text.length<=128*1024 ? text : ''
}
function safePplnsTip(value){const text=String(value||'');return text===''||/^ps:[0-9a-f]{64}$/.test(text)?text:''}
function safePositiveIntegerString(value){try{const n=BigInt(String(value));return n>0n?n.toString():''}catch{return ''}}
function safeMerkleBranch(value){
  if(!Array.isArray(value)||value.length>32)return []
  const out=value.map(hex64); return out.every(Boolean)?out:[]
}

function safePoolId(value) {
  const text = String(value || '').trim().slice(0, 96)
  return /^[A-Za-z0-9:._-]{3,96}$/.test(text) ? text : ''
}

function safeCellId(value) {
  const text = String(value || '').trim().slice(0, 96)
  return /^[A-Za-z0-9:._-]{3,96}$/.test(text) ? text : ''
}

function safePeerId(value) { return hex64(value) }

function safeMultiplier(value = RANDOMX_SHARE_DIFFICULTY_MULTIPLIER) {
  const n = Math.floor(Number(value) || 0)
  return n >= 1 && n <= 1_000_000 ? n : 0
}

function targetBigInt(targetHex) {
  const h = hex64(targetHex)
  if (!h) return null
  try { return BigInt(`0x${h}`) } catch { return null }
}

function shareTargetFromNetworkTarget(networkTargetHex, multiplier = RANDOMX_SHARE_DIFFICULTY_MULTIPLIER) {
  const target = targetBigInt(networkTargetHex)
  const m = safeMultiplier(multiplier)
  if (target == null || target <= 0n || !m) return ''
  const shareTarget = target * BigInt(m)
  return (shareTarget > UINT256_MAX ? UINT256_MAX : shareTarget).toString(16).padStart(64, '0')
}

function workFromTarget(targetHex) {
  const target = targetBigInt(targetHex)
  if (target == null || target < 0n || target >= UINT256_MAX) return target === UINT256_MAX ? 1n : null
  return UINT256_MAX / (target + 1n)
}

function reverseHexBytes(hex) {
  const h = hex64(hex)
  if (!h) return ''
  return Buffer.from(h, 'hex').reverse().toString('hex')
}

function hashMeetsTarget(hashHex, targetHex) {
  const h = hex64(hashHex)
  const t = targetBigInt(targetHex)
  if (!h || t == null) return false
  // byze-rxhash returns uint256 bytes in little-endian order, like Core.
  const reversed = BigInt(`0x${reverseHexBytes(h)}`)
  return t > 0n && reversed <= t
}

function headerNonce(header80) {
  const header = hex160(header80)
  if (!header) return null
  const bytes = Buffer.from(header, 'hex')
  return bytes.readUInt32LE(76)
}

function headerBits(header80) {
  const header = hex160(header80)
  if (!header) return ''
  return Buffer.from(header, 'hex').readUInt32LE(72).toString(16).padStart(8, '0')
}

function targetFromCompactBits(bitsHex) {
  const text = String(bitsHex || '').toLowerCase()
  if (!/^[0-9a-f]{8}$/.test(text)) return ''
  const compact = Number.parseInt(text, 16) >>> 0
  const exponent = compact >>> 24
  const mantissa = compact & 0x007fffff
  if (!mantissa || (compact & 0x00800000)) return ''
  let target = BigInt(mantissa)
  if (exponent <= 3) target >>= 8n * BigInt(3 - exponent)
  else target <<= 8n * BigInt(exponent - 3)
  if (target <= 0n || target >= (1n << 256n)) return ''
  return target.toString(16).padStart(64, '0')
}

function sanitizeGbtTemplate(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, code: 'miningRandomxTemplateInvalid' }
  const previousblockhash = hex64(raw.previousblockhash)
  const target = hex64(raw.target)
  const bits = String(raw.bits || '').toLowerCase()
  const version = Math.floor(Number(raw.version))
  const curtime = Math.floor(Number(raw.curtime))
  const mintime = Math.floor(Number(raw.mintime || raw.curtime))
  const height = Math.floor(Number(raw.height))
  const coinbasevalue = Math.floor(Number(raw.coinbasevalue))
  if (!previousblockhash || !target || !/^[0-9a-f]{8}$/.test(bits) || !Number.isInteger(version) || !Number.isInteger(curtime) || curtime <= 0 || !Number.isInteger(height) || height <= 0 || !Number.isSafeInteger(coinbasevalue) || coinbasevalue <= 0) return { ok: false, code: 'miningRandomxTemplateInvalid' }
  const rules = Array.isArray(raw.rules) ? raw.rules.map((v) => String(v || '').slice(0, 64)).filter(Boolean).slice(0, 32) : []
  const defaultWitnessCommitment = String(raw.default_witness_commitment || '').toLowerCase()
  if (defaultWitnessCommitment && (!/^[0-9a-f]+$/.test(defaultWitnessCommitment) || defaultWitnessCommitment.length % 2)) return { ok:false, code:'miningRandomxTemplateWitnessInvalid' }
  const transactions = []
  for (const tx of Array.isArray(raw.transactions) ? raw.transactions : []) {
    const data = String(tx?.data || '').toLowerCase()
    const txid = String(tx?.txid || '').toLowerCase()
    if (!/^[0-9a-f]+$/.test(data) || data.length % 2 || !/^[0-9a-f]{64}$/.test(txid)) return { ok:false, code:'miningRandomxTemplateTransactionInvalid' }
    let metrics
    try { metrics = transactionMetrics(data) } catch { return { ok:false, code:'miningRandomxTemplateTransactionInvalid' } }
    if (metrics.txid !== txid || (tx.hash != null && tx.hash !== metrics.hash) || (tx.weight != null && tx.weight !== metrics.weight)) return { ok:false, code:'miningRandomxTemplateTransactionMismatch' }
    if (!Number.isSafeInteger(tx.fee) || tx.fee < 0 || !Array.isArray(tx.depends) || tx.depends.some(n => !Number.isSafeInteger(n) || n < 1 || n > transactions.length)) return { ok:false, code:'miningRandomxTemplateMetadataInvalid' }
    transactions.push({ data, txid, hash:metrics.hash, weight:metrics.weight, fee:tx.fee, depends:tx.depends.slice() })
    if (transactions.length > 5000) return { ok:false, code:'miningRandomxTemplateTooManyTransactions' }
  }
  if (raw.weightlimit != null && (!Number.isSafeInteger(raw.weightlimit) || raw.weightlimit <= 0)) return { ok:false, code:'miningRandomxTemplateWeightInvalid' }
  const template = {
    weightlimit: Math.min(MAX_BLOCK_WEIGHT, raw.weightlimit || MAX_BLOCK_WEIGHT),
    version,
    previousblockhash,
    bits,
    curtime,
    mintime: Number.isInteger(mintime) && mintime > 0 ? mintime : curtime,
    coinbasevalue,
    height,
    target,
    rules,
    default_witness_commitment: defaultWitnessCommitment,
    coinbasescript: '',
    transactions
  }
  const templateHash = randomxTemplateHash(template)
  return { ok: true, template, templateHash }
}

function randomxTemplateHash(template) {
  return sha256Hex(Buffer.from(`${RANDOMX_PROOF_MODE}\0template\0${canonical(template || {})}`))
}

function randomxJobId({ contractHash, poolId, cellId, templateHash, difficultyMultiplier = RANDOMX_SHARE_DIFFICULTY_MULTIPLIER }) {
  const contract = hex64(contractHash)
  const pool = safePoolId(poolId)
  const cell = safeCellId(cellId)
  const template = hex64(templateHash)
  const multiplier = safeMultiplier(difficultyMultiplier)
  if (!contract || !pool || !cell || !template || !multiplier) return ''
  return `rxj:${sha256Hex(Buffer.from(`${RANDOMX_PROOF_MODE}\0job\0${contract}\0${pool}\0${cell}\0${template}\0${multiplier}`))}`
}

function proofEnvelopeSigningPayload(packet) {
  const proof = packet?.proof || {}
  return {
    proofMode: RANDOMX_PROOF_MODE,
    share: packet?.share || null,
    proof: {
      header80: hex160(proof.header80),
      networkTarget: hex64(proof.networkTarget),
      shareTarget: hex64(proof.shareTarget),
      previousBlockHash: hex64(proof.previousBlockHash),
      templateHash: hex64(proof.templateHash),
      height: Math.max(1, Math.floor(Number(proof.height) || 0)),
      difficultyMultiplier: safeMultiplier(proof.difficultyMultiplier),
      blockCandidate: proof.blockCandidate === true,
      jobCommitmentHash: hex64(proof.jobCommitmentHash),
      feePolicyHash: hex64(proof.feePolicyHash),
      pplnsTipId: safePplnsTip(proof.pplnsTipId),
      coinbaseValue: safePositiveIntegerString(proof.coinbaseValue),
      coinbaseNoWitnessHex: safeCoinbaseHex(proof.coinbaseNoWitnessHex),
      coinbaseMerkleBranch: safeMerkleBranch(proof.coinbaseMerkleBranch)
    }
  }
}

function buildRandomxLocalShare({ contractHash, poolId, cellId, epoch, minerPeerId, payoutAddress, jobId, nonce, powHash, createdAt = Date.now(), shareTarget }) {
  const work = workFromTarget(shareTarget)
  const safeNonce = Number(nonce)
  if (work == null || work <= 0n || !Number.isInteger(safeNonce) || safeNonce < 0 || safeNonce > 0xffffffff) return { ok: false, code: 'miningRandomxShareInvalid' }
  const base = {
    contractHash: hex64(contractHash),
    poolId: safePoolId(poolId),
    cellId: safeCellId(cellId),
    epoch: Math.max(0, Math.floor(Number(epoch) || 0)),
    jobId: String(jobId || '').slice(0, 128),
    minerPeerId: safePeerId(minerPeerId),
    payoutAddress: normalizePayoutAddress(payoutAddress),
    nonce: String(safeNonce),
    powHash: hex64(powHash),
    work: work.toString(),
    createdAt: Math.max(1, Math.floor(Number(createdAt) || 0))
  }
  if (!base.contractHash || !base.poolId || !base.cellId || !base.jobId || !base.minerPeerId || !base.payoutAddress || !base.powHash) return { ok: false, code: 'miningRandomxShareInvalid' }
  const shareId = localShareId(base)
  const checked = validateLocalShareStructure({ ...base, shareId })
  return checked.ok ? { ok: true, proofMode: RANDOMX_PROOF_MODE, share: checked.payload, work: checked.work } : checked
}

function validateRandomxEnvelope(packet, {
  expectedPeerId = '', expectedPayoutAddress = '', expectedContractHash = '', expectedPoolId = '', expectedCellId = '',
  epochMs = 60_000, now = Date.now(), allowPreviousEpoch = true
} = {}) {
  if (!packet || packet.proofMode !== RANDOMX_PROOF_MODE || !packet.share || !packet.proof || typeof packet.signature !== 'string') return { ok: false, code: 'miningRandomxShareInvalid' }
  const checked = validateLocalShareStructure(packet.share)
  if (!checked.ok) return checked
  const share = checked.payload
  const proof = proofEnvelopeSigningPayload(packet).proof
  const rawProof=packet.proof||{}
  if(String(rawProof.jobCommitmentHash||'').toLowerCase()!==proof.jobCommitmentHash || String(rawProof.feePolicyHash||'').toLowerCase()!==proof.feePolicyHash || String(rawProof.pplnsTipId||'')!==proof.pplnsTipId || String(rawProof.coinbaseValue||'')!==proof.coinbaseValue || String(rawProof.coinbaseNoWitnessHex||'').toLowerCase()!==proof.coinbaseNoWitnessHex || !Array.isArray(rawProof.coinbaseMerkleBranch) || rawProof.coinbaseMerkleBranch.length!==proof.coinbaseMerkleBranch.length || rawProof.coinbaseMerkleBranch.some((v,i)=>String(v||'').toLowerCase()!==proof.coinbaseMerkleBranch[i])) return {ok:false,code:'miningRandomxBindingProofInvalid'}
  if (!proof.header80 || !proof.networkTarget || !proof.shareTarget || !proof.previousBlockHash || !proof.templateHash || !proof.height || !proof.difficultyMultiplier || !proof.jobCommitmentHash || !proof.feePolicyHash || !proof.coinbaseValue || !proof.coinbaseNoWitnessHex || !Array.isArray(proof.coinbaseMerkleBranch)) return { ok: false, code: 'miningRandomxProofInvalid' }
  const bits = headerBits(proof.header80)
  const headerTarget = targetFromCompactBits(bits)
  if (!bits || !headerTarget || headerTarget !== proof.networkTarget) return { ok:false, code:'miningRandomxHeaderTargetMismatch' }
  const expectedShareTarget = shareTargetFromNetworkTarget(proof.networkTarget, proof.difficultyMultiplier)
  if (!expectedShareTarget || proof.shareTarget !== expectedShareTarget) return { ok: false, code: 'miningRandomxTargetInvalid' }
  const expectedWork = workFromTarget(proof.shareTarget)
  if (expectedWork == null || checked.work !== expectedWork) return { ok: false, code: 'miningRandomxWorkInvalid' }
  const nonce = headerNonce(proof.header80)
  if (nonce == null || share.nonce !== String(nonce)) return { ok: false, code: 'miningRandomxNonceMismatch' }
  if (!hashMeetsTarget(share.powHash, proof.shareTarget)) return { ok: false, code: 'miningRandomxTargetMiss' }
  if (proof.blockCandidate !== hashMeetsTarget(share.powHash, proof.networkTarget)) return { ok: false, code: 'miningRandomxBlockFlagInvalid' }

  const expectedPeer = expectedPeerId ? safePeerId(expectedPeerId) : ''
  const expectedAddress = expectedPayoutAddress ? normalizePayoutAddress(expectedPayoutAddress) : ''
  const expectedContract = expectedContractHash ? hex64(expectedContractHash) : ''
  const expectedPool = expectedPoolId ? safePoolId(expectedPoolId) : ''
  const expectedCell = expectedCellId ? safeCellId(expectedCellId) : ''
  if (expectedPeer && share.minerPeerId !== expectedPeer) return { ok: false, code: 'miningRandomxSharePeerMismatch' }
  if (expectedAddress && share.payoutAddress !== expectedAddress) return { ok: false, code: 'miningRandomxSharePayoutMismatch' }
  if (expectedContract && share.contractHash !== expectedContract) return { ok: false, code: 'miningRandomxShareContractMismatch' }
  if (expectedPool && share.poolId !== expectedPool) return { ok: false, code: 'miningRandomxSharePoolMismatch' }
  if (expectedCell && share.cellId !== expectedCell) return { ok: false, code: 'miningRandomxShareCellMismatch' }

  const safeEpochMs = Math.max(10_000, Math.min(10 * 60_000, Math.floor(Number(epochMs) || 60_000)))
  const currentEpoch = Math.floor(Math.max(1, Number(now) || Date.now()) / safeEpochMs)
  const minEpoch = allowPreviousEpoch ? currentEpoch - 1 : currentEpoch
  if (share.epoch < minEpoch || share.epoch > currentEpoch + 1) return { ok: false, code: 'miningRandomxShareEpochInvalid' }
  if (share.createdAt > now + MAX_CLOCK_SKEW_MS || share.createdAt < now - MAX_RANDOMX_SHARE_AGE_MS) return { ok: false, code: 'miningRandomxShareExpired' }
  if (Math.floor(share.createdAt / safeEpochMs) !== share.epoch) return { ok: false, code: 'miningRandomxShareEpochInvalid' }

  return { ok: true, proofMode: RANDOMX_PROOF_MODE, payload: share, work: checked.work, proof }
}

function randomxCheckpoint({ contractHash, poolId, cellId, epoch, shares = [] }) {
  const built = buildCellCheckpoint({ contractHash, poolId, cellId, epoch, shares })
  return built.ok ? { ...built, proofMode: RANDOMX_PROOF_MODE } : built
}

module.exports = {
  RANDOMX_PROOF_MODE,
  RANDOMX_SHARE_DIFFICULTY_MULTIPLIER,
  MAX_RANDOMX_SHARE_AGE_MS,
  shareTargetFromNetworkTarget,
  workFromTarget,
  hashMeetsTarget,
  headerNonce,
  headerBits,
  targetFromCompactBits,
  sanitizeGbtTemplate,
  randomxTemplateHash,
  randomxJobId,
  proofEnvelopeSigningPayload,
  buildRandomxLocalShare,
  validateRandomxEnvelope,
  randomxCheckpoint
}
