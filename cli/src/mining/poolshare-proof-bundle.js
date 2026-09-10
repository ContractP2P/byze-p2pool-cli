'use strict'

const crypto = require('crypto')

const PROOF_BUNDLE_PROTOCOL = 'contract-byze-p2pool-proof-bundle-v1'
const MAX_POOLSHARE_PROOFS = 4096
const MAX_POOLSHARE_PROOF_BUNDLE_BYTES = 4 * 1024 * 1024
const MAX_POOLSHARE_PROOF_CHUNK_BYTES = 48 * 1024
const MAX_POOLSHARE_PROOF_CHUNKS = 256

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}
function sha256Hex(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function jsonBytes(value) { try { return Buffer.byteLength(JSON.stringify(value), 'utf8') } catch { return Infinity } }

function proofBundleHash(proofs) {
  const rows = Array.isArray(proofs) ? proofs : []
  const hash = crypto.createHash('sha256')
  hash.update(`${PROOF_BUNDLE_PROTOCOL}\0proofs\0[`)
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
    if (bytes > MAX_POOLSHARE_PROOF_BUNDLE_BYTES) return bytes
  }
  return bytes
}

function splitPoolShareProofPacket(packet, maxChunkBytes = MAX_POOLSHARE_PROOF_CHUNK_BYTES) {
  const proofs = Array.isArray(packet?.proofs) ? packet.proofs : []
  if (!packet?.share || !packet?.checkpoint || !packet?.signature || !proofs.length) return { ok:false, code:'miningPoolShareProofBundleInvalid' }
  if (proofs.length > MAX_POOLSHARE_PROOFS) return { ok:false, code:'miningPoolShareProofCountInvalid' }
  const proofBytes = proofArrayJsonBytes(proofs)
  if (!Number.isFinite(proofBytes) || proofBytes > MAX_POOLSHARE_PROOF_BUNDLE_BYTES) return { ok:false, code:'miningPoolShareProofBundleTooLarge' }
  const bundleHash = proofBundleHash(proofs)
  const base = {
    share: packet.share,
    checkpoint: packet.checkpoint,
    signature: String(packet.signature || ''),
    signerPeerKey: String(packet.signerPeerKey || '')
  }
  const target = Math.max(8 * 1024, Math.min(MAX_POOLSHARE_PROOF_CHUNK_BYTES, Number(maxChunkBytes) || MAX_POOLSHARE_PROOF_CHUNK_BYTES))
  const chunks = []
  let current = []
  for (const proof of proofs) {
    const candidate = [...current, proof]
    const probe = { ...base, proofs:candidate, proofBundle:{ protocol:PROOF_BUNDLE_PROTOCOL, bundleHash, proofCount:proofs.length, chunkIndex:0, chunkCount:999 } }
    if (current.length && jsonBytes(probe) > target) {
      chunks.push(current)
      current = [proof]
    } else current = candidate
    if (jsonBytes({ ...base, proofs:current, proofBundle:{ protocol:PROOF_BUNDLE_PROTOCOL, bundleHash, proofCount:proofs.length, chunkIndex:0, chunkCount:999 } }) > target) {
      return { ok:false, code:'miningPoolShareProofChunkTooLarge' }
    }
  }
  if (current.length) chunks.push(current)
  if (!chunks.length || chunks.length > MAX_POOLSHARE_PROOF_CHUNKS) return { ok:false, code:'miningPoolShareProofChunkCountInvalid' }
  const packets = chunks.map((chunk, index) => ({
    ...base,
    proofs: chunk,
    proofBundle: {
      protocol: PROOF_BUNDLE_PROTOCOL,
      bundleHash,
      proofCount: proofs.length,
      chunkIndex: index,
      chunkCount: chunks.length
    }
  }))
  if (packets.some((row) => jsonBytes(row) > MAX_POOLSHARE_PROOF_CHUNK_BYTES)) return { ok:false, code:'miningPoolShareProofChunkTooLarge' }
  return { ok:true, bundleHash, proofCount:proofs.length, chunkCount:packets.length, packets }
}

class PoolShareProofAssembler {
  constructor({ maxBundles = 12, maxBytes = 12 * 1024 * 1024, ttlMs = 2 * 60 * 1000 } = {}) {
    this.maxBundles = Math.max(4, Math.min(128, Number(maxBundles) || 12))
    this.maxBytes = Math.max(1024 * 1024, Math.min(128 * 1024 * 1024, Number(maxBytes) || 12 * 1024 * 1024))
    this.ttlMs = Math.max(60_000, Math.min(30 * 60 * 1000, Number(ttlMs) || 2 * 60 * 1000))
    this.byKey = new Map()
  }
  prune(now = Date.now()) {
    for (const [key, rec] of this.byKey) if (now - rec.updatedAt > this.ttlMs) this.byKey.delete(key)
    while (this.byKey.size > this.maxBundles || this.totalBytes() > this.maxBytes) this.byKey.delete(this.byKey.keys().next().value)
  }
  totalBytes() { let total = 0; for (const rec of this.byKey.values()) total += rec.bytes; return total }
  add(packet, transportPeerKey = '', now = Date.now()) {
    const meta = packet?.proofBundle
    if (!meta) return { ok:true, complete:true, packet }
    const shareId = String(packet?.share?.poolShareId || '')
    const signer = String(packet?.signerPeerKey || transportPeerKey || '').toLowerCase()
    const bundleHash = String(meta.bundleHash || '').toLowerCase()
    const proofCount = Number(meta.proofCount)
    const chunkIndex = Number(meta.chunkIndex)
    const chunkCount = Number(meta.chunkCount)
    if (meta.protocol !== PROOF_BUNDLE_PROTOCOL || !/^ps:[0-9a-f]{64}$/.test(shareId) || !/^[0-9a-f]{64}$/.test(signer) || !/^[0-9a-f]{64}$/.test(bundleHash)) return { ok:false, code:'miningPoolShareProofBundleInvalid' }
    if (!Number.isInteger(proofCount) || proofCount < 1 || proofCount > MAX_POOLSHARE_PROOFS || !Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > MAX_POOLSHARE_PROOF_CHUNKS || !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunkCount) return { ok:false, code:'miningPoolShareProofChunkInvalid' }
    if (!Array.isArray(packet.proofs) || !packet.proofs.length || jsonBytes(packet) > MAX_POOLSHARE_PROOF_CHUNK_BYTES) return { ok:false, code:'miningPoolShareProofChunkInvalid' }
    const core = { share:packet.share, checkpoint:packet.checkpoint, signature:String(packet.signature || ''), signerPeerKey:signer }
    const coreHash = sha256Hex(Buffer.from(canonical(core)))
    const key = `${signer}:${shareId}:${bundleHash}`
    this.prune(now)
    let rec = this.byKey.get(key)
    if (!rec) {
      rec = { core, coreHash, bundleHash, proofCount, chunkCount, chunks:new Map(), bytes:0, updatedAt:now }
      this.byKey.set(key, rec)
    }
    if (rec.coreHash !== coreHash || rec.proofCount !== proofCount || rec.chunkCount !== chunkCount) return { ok:false, code:'miningPoolShareProofBundleMismatch' }
    const rawBytes = jsonBytes(packet)
    if (!rec.chunks.has(chunkIndex)) { rec.chunks.set(chunkIndex, packet.proofs); rec.bytes += rawBytes }
    rec.updatedAt = now
    this.byKey.delete(key)
    this.byKey.set(key, rec)
    this.prune(now)
    if (!this.byKey.has(key)) return { ok:false, code:'miningPoolShareProofAssemblerBusy' }
    if (rec.bytes > MAX_POOLSHARE_PROOF_BUNDLE_BYTES + MAX_POOLSHARE_PROOF_CHUNK_BYTES) { this.byKey.delete(key); return { ok:false, code:'miningPoolShareProofBundleTooLarge' } }
    if (rec.chunks.size !== rec.chunkCount) return { ok:true, complete:false, receivedChunks:rec.chunks.size, chunkCount:rec.chunkCount }
    const proofs = []
    for (let i = 0; i < rec.chunkCount; i++) {
      const chunk = rec.chunks.get(i)
      if (!chunk) return { ok:true, complete:false, receivedChunks:rec.chunks.size, chunkCount:rec.chunkCount }
      proofs.push(...chunk)
    }
    this.byKey.delete(key)
    if (proofs.length !== proofCount || proofBundleHash(proofs) !== bundleHash) return { ok:false, code:'miningPoolShareProofBundleMismatch' }
    return { ok:true, complete:true, packet:{ ...rec.core, proofs } }
  }
}

module.exports = {
  PROOF_BUNDLE_PROTOCOL,
  MAX_POOLSHARE_PROOFS,
  MAX_POOLSHARE_PROOF_BUNDLE_BYTES,
  MAX_POOLSHARE_PROOF_CHUNK_BYTES,
  MAX_POOLSHARE_PROOF_CHUNKS,
  proofBundleHash,
  splitPoolShareProofPacket,
  PoolShareProofAssembler
}
