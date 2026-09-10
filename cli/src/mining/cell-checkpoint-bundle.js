'use strict'

const crypto = require('crypto')

const CELL_CHECKPOINT_BUNDLE_PROTOCOL = 'contract-byze-p2pool-cell-checkpoint-bundle-v1'
const MAX_CELL_CHECKPOINT_PROOFS = 4096
const MAX_CELL_CHECKPOINT_BUNDLE_BYTES = 4 * 1024 * 1024
const MAX_CELL_CHECKPOINT_CHUNK_BYTES = 48 * 1024
const MAX_CELL_CHECKPOINT_CHUNKS = 256

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}
function sha256Hex(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function jsonBytes(value) { try { return Buffer.byteLength(JSON.stringify(value), 'utf8') } catch { return Infinity } }

function cellProofBundleHash(proofs) {
  const rows = Array.isArray(proofs) ? proofs : []
  const hash = crypto.createHash('sha256')
  hash.update(`${CELL_CHECKPOINT_BUNDLE_PROTOCOL}\0proofs\0[`)
  for (let i = 0; i < rows.length; i++) {
    if (i) hash.update(',')
    hash.update(canonical(rows[i]))
  }
  hash.update(']')
  return hash.digest('hex')
}

function proofArrayJsonBytes(proofs) {
  const rows = Array.isArray(proofs) ? proofs : []
  let bytes = 2
  for (let i = 0; i < rows.length; i++) {
    let encoded
    try { encoded = JSON.stringify(rows[i]) } catch { return Infinity }
    bytes += Buffer.byteLength(encoded, 'utf8') + (i ? 1 : 0)
    if (bytes > MAX_CELL_CHECKPOINT_BUNDLE_BYTES) return bytes
  }
  return bytes
}

function cellCheckpointSigningPayload(packet) {
  const checkpoint = packet?.checkpoint || {}
  const proofs = Array.isArray(packet?.proofs) ? packet.proofs : []
  return {
    protocol: CELL_CHECKPOINT_BUNDLE_PROTOCOL,
    kind: 'cell-checkpoint-bundle',
    checkpointId: String(checkpoint.checkpointId || ''),
    contractHash: String(checkpoint.contractHash || ''),
    poolId: String(checkpoint.poolId || ''),
    cellId: String(checkpoint.cellId || ''),
    epoch: Math.max(0, Math.floor(Number(checkpoint.epoch) || 0)),
    previousPoolShareId: String(packet?.previousPoolShareId || ''),
    proofCount: proofs.length,
    proofBundleHash: cellProofBundleHash(proofs),
    signerPeerKey: String(packet?.signerPeerKey || '').toLowerCase()
  }
}

function validateCellCheckpointPacketShape(packet) {
  const checkpoint = packet?.checkpoint
  const proofs = Array.isArray(packet?.proofs) ? packet.proofs : []
  const signerPeerKey = String(packet?.signerPeerKey || '').toLowerCase()
  const previousPoolShareId = String(packet?.previousPoolShareId || '')
  if (!checkpoint || checkpoint.kind !== 'cell-checkpoint' || !/^cp:[0-9a-f]{64}$/.test(String(checkpoint.checkpointId || ''))) return { ok:false, code:'miningCellCheckpointBundleInvalid' }
  if (!proofs.length || proofs.length > MAX_CELL_CHECKPOINT_PROOFS) return { ok:false, code:'miningCellCheckpointProofCountInvalid' }
  if (!/^[0-9a-f]{64}$/.test(signerPeerKey) || !packet?.signature) return { ok:false, code:'miningCellCheckpointSignerInvalid' }
  if (previousPoolShareId && !/^ps:[0-9a-f]{64}$/.test(previousPoolShareId)) return { ok:false, code:'miningCellCheckpointPreviousInvalid' }
  const proofBytes = proofArrayJsonBytes(proofs)
  if (!Number.isFinite(proofBytes) || proofBytes > MAX_CELL_CHECKPOINT_BUNDLE_BYTES) return { ok:false, code:'miningCellCheckpointBundleTooLarge' }
  return { ok:true, checkpoint, proofs, signerPeerKey, previousPoolShareId, signingPayload:cellCheckpointSigningPayload(packet) }
}

function splitCellCheckpointPacket(packet, maxChunkBytes = MAX_CELL_CHECKPOINT_CHUNK_BYTES) {
  const shape = validateCellCheckpointPacketShape(packet)
  if (!shape.ok) return shape
  const proofs = shape.proofs
  const bundleHash = cellProofBundleHash(proofs)
  const base = {
    checkpoint: packet.checkpoint,
    previousPoolShareId: String(packet.previousPoolShareId || ''),
    signature: String(packet.signature || ''),
    signerPeerKey: shape.signerPeerKey
  }
  const target = Math.max(8 * 1024, Math.min(MAX_CELL_CHECKPOINT_CHUNK_BYTES, Number(maxChunkBytes) || MAX_CELL_CHECKPOINT_CHUNK_BYTES))
  const chunks = []
  let current = []
  for (const proof of proofs) {
    const candidate = [...current, proof]
    const probe = { ...base, proofs:candidate, proofBundle:{ protocol:CELL_CHECKPOINT_BUNDLE_PROTOCOL, bundleHash, proofCount:proofs.length, chunkIndex:0, chunkCount:999 } }
    if (current.length && jsonBytes(probe) > target) {
      chunks.push(current)
      current = [proof]
    } else current = candidate
    const one = { ...base, proofs:current, proofBundle:{ protocol:CELL_CHECKPOINT_BUNDLE_PROTOCOL, bundleHash, proofCount:proofs.length, chunkIndex:0, chunkCount:999 } }
    if (jsonBytes(one) > target) return { ok:false, code:'miningCellCheckpointChunkTooLarge' }
  }
  if (current.length) chunks.push(current)
  if (!chunks.length || chunks.length > MAX_CELL_CHECKPOINT_CHUNKS) return { ok:false, code:'miningCellCheckpointChunkCountInvalid' }
  const packets = chunks.map((chunk, index) => ({
    ...base,
    proofs:chunk,
    proofBundle:{ protocol:CELL_CHECKPOINT_BUNDLE_PROTOCOL, bundleHash, proofCount:proofs.length, chunkIndex:index, chunkCount:chunks.length }
  }))
  if (packets.some((row) => jsonBytes(row) > MAX_CELL_CHECKPOINT_CHUNK_BYTES)) return { ok:false, code:'miningCellCheckpointChunkTooLarge' }
  return { ok:true, bundleHash, proofCount:proofs.length, chunkCount:packets.length, packets }
}

class CellCheckpointProofAssembler {
  constructor({ maxBundles = 24, maxBytes = 16 * 1024 * 1024, ttlMs = 2 * 60 * 1000 } = {}) {
    this.maxBundles = Math.max(4, Math.min(256, Number(maxBundles) || 24))
    this.maxBytes = Math.max(1024 * 1024, Math.min(128 * 1024 * 1024, Number(maxBytes) || 16 * 1024 * 1024))
    this.ttlMs = Math.max(60_000, Math.min(30 * 60 * 1000, Number(ttlMs) || 2 * 60 * 1000))
    this.byKey = new Map()
  }
  totalBytes() { let total=0; for (const rec of this.byKey.values()) total += rec.bytes; return total }
  prune(now = Date.now()) {
    for (const [key, rec] of this.byKey) if (now - rec.updatedAt > this.ttlMs) this.byKey.delete(key)
    while (this.byKey.size > this.maxBundles || this.totalBytes() > this.maxBytes) this.byKey.delete(this.byKey.keys().next().value)
  }
  add(packet, transportPeerKey = '', now = Date.now()) {
    const meta = packet?.proofBundle
    if (!meta) return { ok:true, complete:true, packet }
    const checkpointId = String(packet?.checkpoint?.checkpointId || '')
    const signer = String(packet?.signerPeerKey || transportPeerKey || '').toLowerCase()
    const bundleHash = String(meta.bundleHash || '').toLowerCase()
    const proofCount = Number(meta.proofCount), chunkIndex = Number(meta.chunkIndex), chunkCount = Number(meta.chunkCount)
    if (meta.protocol !== CELL_CHECKPOINT_BUNDLE_PROTOCOL || !/^cp:[0-9a-f]{64}$/.test(checkpointId) || !/^[0-9a-f]{64}$/.test(signer) || !/^[0-9a-f]{64}$/.test(bundleHash)) return { ok:false, code:'miningCellCheckpointBundleInvalid' }
    if (!Number.isInteger(proofCount) || proofCount < 1 || proofCount > MAX_CELL_CHECKPOINT_PROOFS || !Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > MAX_CELL_CHECKPOINT_CHUNKS || !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunkCount) return { ok:false, code:'miningCellCheckpointChunkInvalid' }
    if (!Array.isArray(packet.proofs) || !packet.proofs.length || jsonBytes(packet) > MAX_CELL_CHECKPOINT_CHUNK_BYTES) return { ok:false, code:'miningCellCheckpointChunkInvalid' }
    const core = { checkpoint:packet.checkpoint, previousPoolShareId:String(packet.previousPoolShareId || ''), signature:String(packet.signature || ''), signerPeerKey:signer }
    const coreHash = sha256Hex(Buffer.from(canonical(core)))
    const key = `${signer}:${checkpointId}:${bundleHash}`
    this.prune(now)
    let rec = this.byKey.get(key)
    if (!rec) { rec={core,coreHash,bundleHash,proofCount,chunkCount,chunks:new Map(),bytes:0,updatedAt:now}; this.byKey.set(key,rec) }
    if (rec.coreHash !== coreHash || rec.proofCount !== proofCount || rec.chunkCount !== chunkCount) return { ok:false, code:'miningCellCheckpointBundleMismatch' }
    const rawBytes = jsonBytes(packet)
    if (!rec.chunks.has(chunkIndex)) { rec.chunks.set(chunkIndex, packet.proofs); rec.bytes += rawBytes }
    rec.updatedAt=now; this.byKey.delete(key); this.byKey.set(key,rec); this.prune(now)
    if (!this.byKey.has(key)) return { ok:false, code:'miningCellCheckpointAssemblerBusy' }
    if (rec.bytes > MAX_CELL_CHECKPOINT_BUNDLE_BYTES + MAX_CELL_CHECKPOINT_CHUNK_BYTES) { this.byKey.delete(key); return { ok:false, code:'miningCellCheckpointBundleTooLarge' } }
    if (rec.chunks.size !== rec.chunkCount) return { ok:true, complete:false, receivedChunks:rec.chunks.size, chunkCount:rec.chunkCount }
    const proofs=[]
    for (let i=0;i<rec.chunkCount;i++) { const chunk=rec.chunks.get(i); if(!chunk)return {ok:true,complete:false}; proofs.push(...chunk) }
    this.byKey.delete(key)
    if (proofs.length !== proofCount || cellProofBundleHash(proofs) !== bundleHash) return { ok:false, code:'miningCellCheckpointBundleMismatch' }
    return { ok:true, complete:true, packet:{ ...rec.core, proofs } }
  }
}

module.exports = {
  CELL_CHECKPOINT_BUNDLE_PROTOCOL,
  MAX_CELL_CHECKPOINT_PROOFS,
  MAX_CELL_CHECKPOINT_BUNDLE_BYTES,
  MAX_CELL_CHECKPOINT_CHUNK_BYTES,
  MAX_CELL_CHECKPOINT_CHUNKS,
  cellProofBundleHash,
  cellCheckpointSigningPayload,
  validateCellCheckpointPacketShape,
  splitCellCheckpointPacket,
  CellCheckpointProofAssembler
}
