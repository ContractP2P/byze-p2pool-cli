'use strict'

function satoshisToByze(value, { trim = true } = {}) {
  let n
  try { n = BigInt(String(value || 0)) } catch { n = 0n }
  const neg = n < 0n
  const abs = neg ? -n : n
  const whole = abs / 100_000_000n
  const frac = (abs % 100_000_000n).toString().padStart(8, '0')
  const body = trim ? `${whole}.${frac}`.replace(/\.?0+$/, '') : `${whole}.${frac}`
  return `${neg ? '-' : ''}${body || '0'}`
}

function coinsToSatoshis(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    const neg = text.startsWith('-')
    const raw = neg ? text.slice(1) : text
    const [whole = '0', fraction = ''] = raw.split('.')
    const frac = (fraction + '00000000').slice(0, 8)
    try {
      const n = BigInt(whole || '0') * 100_000_000n + BigInt(frac || '0')
      return neg ? -n : n
    } catch {}
  }
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return BigInt(Math.round(num * 1e8))
}

function outputPaysAddress(vout, payoutAddress, payoutScriptHex = '') {
  const spk = vout?.scriptPubKey || vout?.scriptpubkey || {}
  const addresses = [spk.address, ...(Array.isArray(spk.addresses) ? spk.addresses : [])]
    .filter(Boolean)
    .map(String)
  if (addresses.includes(String(payoutAddress || ''))) return true
  const hex = String(spk.hex || spk.script || '').toLowerCase()
  return !!payoutScriptHex && hex === String(payoutScriptHex).toLowerCase()
}

function sumPayoutFromVouts(vouts, payoutAddress, payoutScriptHex = '') {
  let satoshis = 0n
  for (const vout of Array.isArray(vouts) ? vouts : []) {
    if (!outputPaysAddress(vout, payoutAddress, payoutScriptHex)) continue
    const sat = coinsToSatoshis(vout?.value)
    if (sat != null && sat > 0n) satoshis += sat
  }
  return satoshis
}

module.exports = { satoshisToByze, coinsToSatoshis, outputPaysAddress, sumPayoutFromVouts }
