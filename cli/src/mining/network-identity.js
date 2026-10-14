'use strict'
// Single source of the network identity used by miner and passive observers.
// Changing any value changes which mining peers are compatible with one another.
module.exports = Object.freeze({
  CONTRACT_ID: 'org.contract.byze-p2pool',
  CONTRACT_VERSION: '0.1.3',
  CONTRACT_SOURCE_HASH: '0ba509a74eb5f475ce41f152349fe49a7d19e4fbd6c14c1833632c61681a0b66',
  BUILTIN_PUBLISHER_KEY: '77a412df63379feff5e8a0cdef364b10377d7fcd0d2753f6000b48bf5b4e523e',
  POOL_ID: 'byze-main-p2pool-v1',
  SECURITY_GENERATION: 'coinbase-binding-v2-global-epoch-v6'
})
