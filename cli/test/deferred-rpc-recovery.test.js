'use strict'

// Regression for #2 / #3: exercise the real deferred queue and retry loop.
// This is a deterministic unit test, NOT a live byzed outage soak test.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { MinerApp, loadPolicy } = require('../src/byze-p2pool')

const TRANSIENT = ['miningPayoutValidationUnavailable', 'miningPayoutValidationBusy']
const PEER = 'ab'.repeat(32)

function harness() {
  const policy = loadPolicy(path.join(__dirname, '../config/pool-policy.json'))
  const app = new MinerApp({
    alias: 'retry-test', wallet: 'byz1testaddress000000', threads: 1,
    policy, byze: { call: async () => { throw new Error('offline') } }, noSubmit: true
  })
  // Only the result of full validation is simulated; queueing/retries are real.
  const outcomes = []
  const attempts = { local: 0, pool: 0 }
  let online = false
  app.validationGate.run = async (_peer, fn) => fn()
  app.acceptLocalShare = async () => {
    attempts.local++
    return online ? { ok: true, duplicate: false } : { ok: false, code: TRANSIENT[0] }
  }
  app.acceptPoolShare = async () => {
    attempts.pool++
    return online ? { ok: true, duplicate: false } : { ok: false, code: TRANSIENT[1] }
  }
  app.recordRemoteOutcome = (kind, packet, outcome) => outcomes.push({ kind, id: packet.share.shareId || packet.share.poolShareId, outcome })
  return { app, attempts, outcomes, restore: () => { online = true } }
}

test('deferred local and pool shares survive transient RPC failures and recover exactly once', async () => {
  const { app, attempts, outcomes, restore } = harness()
  const local = { share: { shareId: 'ls:' + '11'.repeat(32) } }
  const pool = { share: { poolShareId: 'ps:' + '22'.repeat(32) } }
  assert.equal(app.deferContext('local', PEER, local), true)
  assert.equal(app.deferContext('pool', PEER, pool), true)
  // Trigger retries without waiting for wall-clock timers.
  for (const map of [app.deferredLocalShares, app.deferredPoolShares])
    for (const rec of map.values()) rec.retryAt = 0
  await app.retryDeferredContext()
  assert.equal(app.deferredLocalShares.size, 1)
  assert.equal(app.deferredPoolShares.size, 1)
  assert.deepEqual(outcomes, [])
  assert.deepEqual(attempts, { local: 1, pool: 1 })

  restore()
  for (const map of [app.deferredLocalShares, app.deferredPoolShares])
    for (const rec of map.values()) rec.retryAt = 0
  await app.retryDeferredContext()
  assert.equal(app.deferredLocalShares.size, 0)
  assert.equal(app.deferredPoolShares.size, 0)
  assert.deepEqual(outcomes.map(x => [x.kind, x.outcome]).sort(), [['local', 'accepted'], ['pool', 'accepted']])
  await app.retryDeferredContext()
  assert.deepEqual(attempts, { local: 2, pool: 2 }, 'drained shares must not be retried')
  assert.equal(outcomes.length, 2, 'no double-accounting')
})

test('expired deferred shares are dropped rather than accepted after recovery', async () => {
  const { app, attempts, outcomes, restore } = harness()
  const packet = { share: { shareId: 'ls:' + '33'.repeat(32) } }
  assert.equal(app.deferContext('local', PEER, packet), true)
  const rec = app.deferredLocalShares.get(packet.share.shareId)
  rec.retryAt = 0
  rec.firstSeen = Date.now() - 121_000
  restore()
  await app.retryDeferredContext()
  assert.equal(app.deferredLocalShares.size, 0)
  assert.equal(attempts.local, 0)
  assert.deepEqual(outcomes, [])
})
