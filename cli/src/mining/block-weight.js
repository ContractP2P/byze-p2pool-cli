'use strict'

const crypto = require('crypto')
const MAX_BLOCK_WEIGHT = 4_000_000
// Core rc4: XMSS 2500, SPHINCS+ 7856, dual public key 100 bytes.
// All three vectors are in BOTH block serializations, not in the witness.
const QUANTUM_TAIL_BYTES = 3 + 2500 + 3 + 7856 + 1 + 100
const sha256d = b => crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest()
const compactSizeBytes = n => n < 253 ? 1 : n <= 65535 ? 3 : n <= 0xffffffff ? 5 : 9

class Reader {
  constructor(hex) {
    if (typeof hex !== 'string' || !/^[0-9a-f]+$/i.test(hex) || hex.length % 2 || hex.length > MAX_BLOCK_WEIGHT * 2) throw new Error('invalid serialization')
    this.b = Buffer.from(hex, 'hex')
    this.p = 0
  }
  take(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.b.length - this.p) throw new Error('truncated serialization')
    const bytes = this.b.subarray(this.p, this.p + n)
    this.p += n
    return bytes
  }
  compact() {
    const prefix = this.take(1)[0]
    if (prefix < 253) return prefix
    const b = this.take(prefix === 253 ? 2 : prefix === 254 ? 4 : 8)
    const n = prefix === 253 ? BigInt(b.readUInt16LE()) : prefix === 254 ? BigInt(b.readUInt32LE()) : b.readBigUInt64LE()
    if (n < (prefix === 253 ? 253n : prefix === 254 ? 65536n : 4294967296n) || n > BigInt(this.b.length)) throw new Error('invalid compact size')
    return Number(n)
  }
  vector() { return this.take(this.compact()) }
}

function readTransaction(r) {
  const start = r.p
  const version = r.take(4)
  let witness = false
  if (r.b[r.p] === 0) {
    r.take(1)
    if (r.take(1)[0] !== 1) throw new Error('invalid witness flags')
    witness = true
  }
  const vinStart = r.p
  const inputs = r.compact()
  if (!inputs || inputs > r.b.length / 41) throw new Error('invalid inputs')
  for (let i = 0; i < inputs; i++) { r.take(36); r.vector(); r.take(4) }
  const outputs = r.compact()
  if (!outputs || outputs > r.b.length / 9) throw new Error('invalid outputs')
  for (let i = 0; i < outputs; i++) { r.take(8); r.vector() }
  const outputsEnd = r.p
  if (witness) {
    let hasWitness = false
    for (let i = 0; i < inputs; i++) {
      const items = r.compact()
      if (items > r.b.length) throw new Error('invalid witness stack')
      if (items) hasWitness = true
      for (let j = 0; j < items; j++) r.vector()
    }
    if (!hasWitness) throw new Error('empty witness serialization')
  }
  const locktime = r.take(4)
  const stripped = Buffer.concat([version, r.b.subarray(vinStart, outputsEnd), locktime])
  const raw = r.b.subarray(start, r.p)
  return {
    weight: stripped.length * 3 + raw.length,
    txid: sha256d(stripped).reverse().toString('hex'),
    hash: sha256d(raw).reverse().toString('hex')
  }
}

function transactionMetrics(hex) {
  const r = new Reader(hex)
  const result = readTransaction(r)
  if (r.p !== r.b.length) throw new Error('trailing transaction bytes')
  return result
}

function blockWeight(hex) {
  const r = new Reader(hex)
  r.take(80)
  const count = r.compact()
  if (!count || count > 5001) throw new Error('invalid transaction count')
  let weight = r.p * 4
  for (let i = 0; i < count; i++) weight += readTransaction(r).weight
  const tailStart = r.p
  for (let i = 0; i < 3; i++) r.vector()
  if (r.p !== r.b.length) throw new Error('trailing block bytes')
  return weight + (r.p - tailStart) * 4
}

function coinbaseWeightBound(outputs) {
  if (!Array.isArray(outputs) || !outputs.length || outputs.length > 400) throw new Error('invalid coinbase outputs')
  // One input with the consensus maximum 100-byte scriptSig; one witness
  // commitment output; marker/flag and the 32-byte reserved witness value.
  let stripped = 4 + 1 + 36 + 1 + 100 + 4 + compactSizeBytes(outputs.length + 1) + 4
  for (const output of outputs) {
    if (!/^5120[0-9a-f]{64}$/i.test(output.script || '')) throw new Error('unsupported payout script')
    const bytes = output.script.length / 2
    stripped += 8 + compactSizeBytes(bytes) + bytes
  }
  stripped += 8 + 1 + 38
  return stripped * 4 + 36
}

function witnessCommitment(transactions) {
  let level = [Buffer.alloc(32), ...transactions.map(tx => Buffer.from(tx.hash, 'hex').reverse())]
  while (level.length > 1) {
    if (level.length % 2) level.push(level[level.length - 1])
    const next = []
    for (let i = 0; i < level.length; i += 2) next.push(sha256d(Buffer.concat([level[i], level[i + 1]])))
    level = next
  }
  return '6a24aa21a9ed' + sha256d(Buffer.concat([level[0], Buffer.alloc(32)])).toString('hex')
}

// Keep a topologically ordered prefix: removing the tail also removes every
// descendant of a removed transaction. No PPLNS recipient is dropped.
function fitTemplateWeight(template, outputs) {
  const transactions = template.transactions.map(tx => ({ ...tx }))
  const limit = Math.min(MAX_BLOCK_WEIGHT, template.weightlimit || MAX_BLOCK_WEIGHT)
  const coinbaseWeight = coinbaseWeightBound(outputs)
  let txWeight = transactions.reduce((sum, tx) => sum + tx.weight, 0)
  let reward = BigInt(template.coinbasevalue)
  let removed = 0
  const totalWeight = () => (80 + compactSizeBytes(transactions.length + 1) + QUANTUM_TAIL_BYTES) * 4 + coinbaseWeight + txWeight
  while (totalWeight() > limit && transactions.length) {
    const tx = transactions.pop()
    if (!Number.isSafeInteger(tx.fee) || tx.fee < 0) throw new Error('template transaction fee unavailable')
    reward -= BigInt(tx.fee)
    txWeight -= tx.weight
    removed++
  }
  if (!Number.isSafeInteger(txWeight) || totalWeight() > limit || reward <= 0n) throw new Error('direct coinbase exceeds block weight budget')
  return {
    template: { ...template, transactions, coinbasevalue: Number(reward), default_witness_commitment: witnessCommitment(transactions) },
    removed, weightBound: totalWeight(), coinbaseWeight
  }
}

module.exports = { MAX_BLOCK_WEIGHT, QUANTUM_TAIL_BYTES, transactionMetrics, blockWeight, coinbaseWeightBound, witnessCommitment, fitTemplateWeight }
