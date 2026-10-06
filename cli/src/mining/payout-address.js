'use strict'

// validateaddress resolves a script; it does not prove ownership/spendability.
// rc4 getaddressinfo can identify plain Taproot derived by a loaded wallet.
class PayoutAddressValidator {
  constructor(rpc, { warn = () => {}, now = Date.now, maxEntries = 512, ttlMs = 60_000 } = {}) {
    this.rpc = rpc
    this.warn = warn
    this.now = now
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
    this.cache = new Map()
    this.pending = new Map()
    this.warned = new Map()
  }

  async validate(address) {
    if (typeof address !== 'string' || !/^[A-Za-z0-9]{8,160}$/.test(address)) {
      return { ok: false, code: 'miningPayoutAddressInvalid' }
    }
    const cached = this.cache.get(address)
    if (cached && cached.expiresAt > this.now()) return cached.result
    if (this.pending.has(address)) return this.pending.get(address)
    if (this.pending.size >= 16) return { ok: false, code: 'miningPayoutValidationBusy' }
    const task = this.check(address)
    this.pending.set(address, task)
    try {
      const result = await task
      this.cache.delete(address)
      this.cache.set(address, { result, expiresAt: this.now() + (result.ok ? this.ttlMs : 1_000) })
      while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value)
      if (result.ok && result.spendability === 'unknown' && (!this.warned.has(address) || this.now() - this.warned.get(address) >= 600_000)) {
        this.warned.set(address, this.now())
        while (this.warned.size > this.maxEntries) this.warned.delete(this.warned.keys().next().value)
        this.warn(`Payout ${address}: valid output script, but this node cannot confirm spendability. Use getnewaddress on Byze rc4 or later and verify the receiving wallet.`)
      }
      return result
    } finally {
      this.pending.delete(address)
    }
  }

  async check(address) {
    let validated
    try { validated = await this.rpc('validateaddress', [address]) }
    catch { return { ok: false, code: 'miningPayoutValidationUnavailable' } }
    if (validated?.isvalid !== true) return { ok: false, code: 'miningPayoutAddressInvalid' }
    const script = String(validated.scriptPubKey || '').toLowerCase()
    // Byze rc4 supports witness-v1 32-byte payout programs only.
    if (!/^5120[0-9a-f]{64}$/.test(script)) return { ok: false, code: 'miningPayoutScriptUnsupported' }
    if (validated.unspendable === true) return { ok: false, code: 'miningPayoutUnspendable' }
    let info
    try { info = await this.rpc('getaddressinfo', [address]) } catch {}
    if (info?.unspendable === true) return { ok: false, code: 'miningPayoutUnspendable' }
    if (info?.scriptPubKey && String(info.scriptPubKey).toLowerCase() !== script) {
      return { ok: false, code: 'miningPayoutScriptMismatch' }
    }
    const quantum = info?.solvable === true && info?.desc === `quantum_program(${script.slice(4)})`
    return { ok: true, scriptPubKey: script, spendability: quantum ? 'wallet-quantum' : 'unknown' }
  }
}

module.exports = { PayoutAddressValidator }
