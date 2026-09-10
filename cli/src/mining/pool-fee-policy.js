'use strict'

const fs = require('fs')
const crypto = require('crypto')

const POOL_FEE_PROTOCOL = 'contract-byze-p2pool-fee-v1'
const DEFAULT_POOL_FEE_BASIS_POINTS = 50
const OFFICIAL_POOL_FEE_ADDRESS = 'byz1ptlyn7q58zyhht8lds0u58n6mf4vehx6ds8gkax0vmtc49az2w9eqgqsm5p'
const BASIS_POINTS_DENOMINATOR = 10_000

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

function sha256Hex(value) { return crypto.createHash('sha256').update(value).digest('hex') }

function normalizePoolId(value) {
  const text = String(value || '').trim().slice(0, 96)
  return /^[A-Za-z0-9:._-]{3,96}$/.test(text) ? text : ''
}

function normalizeFeeAddress(value) {
  const text = String(value || '').replace(/[\r\n\0\s]/g, '').slice(0, 160)
  return text && /^[A-Za-z0-9:._-]{8,160}$/.test(text) ? text : ''
}

function createPoolFeePolicy({ poolId, feeAddress, feeBasisPoints = DEFAULT_POOL_FEE_BASIS_POINTS } = {}) {
  const normalizedPoolId = normalizePoolId(poolId)
  const normalizedAddress = normalizeFeeAddress(feeAddress)
  const bps = Math.floor(Number(feeBasisPoints))
  if (!normalizedPoolId) return { ok:false, code:'miningPoolFeePoolInvalid' }
  if (!Number.isInteger(bps) || bps !== DEFAULT_POOL_FEE_BASIS_POINTS) return { ok:false, code:'miningPoolFeeRateInvalid' }
  const base = {
    protocol: POOL_FEE_PROTOCOL,
    poolId: normalizedPoolId,
    feeBasisPoints: bps,
    feeAddress: normalizedAddress
  }
  const policyHash = sha256Hex(Buffer.from(`${POOL_FEE_PROTOCOL}\0policy\0${canonical(base)}`))
  if (!normalizedAddress) return { ok:false, code:'miningPoolFeeAddressMissing', ...base, policyHash, configured:false }
  return { ok:true, ...base, policyHash, configured:true }
}

function loadPoolFeePolicy({ filePath = '', poolId = 'byze-main-p2pool-v1', env = process.env } = {}) {
  let configured = {}
  if (filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) configured = parsed
    } catch {}
  }
  const envAddress = String(env?.CONTRACT_BYZE_POOL_FEE_ADDRESS || '').trim()
  const configuredAddress = normalizeFeeAddress(configured.feeAddress || '')
  const feeAddress = normalizeFeeAddress(envAddress) || configuredAddress || OFFICIAL_POOL_FEE_ADDRESS
  return createPoolFeePolicy({ poolId, feeAddress, feeBasisPoints: DEFAULT_POOL_FEE_BASIS_POINTS })
}

module.exports = {
  POOL_FEE_PROTOCOL,
  DEFAULT_POOL_FEE_BASIS_POINTS,
  OFFICIAL_POOL_FEE_ADDRESS,
  BASIS_POINTS_DENOMINATOR,
  normalizeFeeAddress,
  createPoolFeePolicy,
  loadPoolFeePolicy
}
