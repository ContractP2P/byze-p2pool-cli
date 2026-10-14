#!/usr/bin/env node
'use strict'

// Real, disposable byzed regtest outage and P2Pool deferred-queue integration.
// Share validity other than RPC payout-script validation is intentionally stubbed.
// This is NOT evidence of a live two-peer share/PPLNS soak test on mainnet.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomInt } = require('node:crypto')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { MinerApp, loadPolicy } = require('../src/byze-p2pool')
const { PayoutAddressValidator } = require('../src/mining/payout-address')
const run = promisify(execFile)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  if (process.env.BYZE_OUTAGE_TEST_CONFIRM !== 'DISPOSABLE_REGTEST_ONLY')
    throw new Error('Set BYZE_OUTAGE_TEST_CONFIRM=DISPOSABLE_REGTEST_ONLY. Never point this test at a live node.')
  const bin = path.resolve(process.env.BYZE_CORE_BIN || '')
  if (!process.env.BYZE_CORE_BIN) throw new Error('Set BYZE_CORE_BIN to verified official Core binaries.')
  const daemon = path.join(bin, 'byzed')
  const cli = path.join(bin, 'byze-cli')
  for (const file of [daemon, cli]) fs.accessSync(file, fs.constants.X_OK)
  const downtime = Number(process.env.BYZE_OUTAGE_MS || 60000)
  if (!Number.isSafeInteger(downtime) || downtime < 60000 || downtime > 90000)
    throw new Error('BYZE_OUTAGE_MS must be 60000..90000 for the real outage acceptance test.')
  const datadir = fs.mkdtempSync(path.join(os.tmpdir(), 'byze-outage-regtest-'))
  const port = randomInt(21000, 49000)
  const common = ['-regtest', `-datadir=${datadir}`, `-rpcport=${port}`]
  const daemonArgs = [...common, '-daemon=0','-server=1','-listen=0','-connect=0',
    '-dnsseed=0','-discover=0','-networkactive=0','-dbcache=64','-par=1','-printtoconsole=0']
  let child
  async function rpc(method, params = []) {
    let stdout
    try {
      ({ stdout } = await run(cli, [...common, method, ...params.map(x => typeof x === 'string' ? x : JSON.stringify(x))],
        { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }))
    } catch (e) {
      throw new Error(`RPC ${method} failed (code ${e.code}): ${String(e.stderr || e.stdout || e.message).slice(0, 1200)}`)
    }
    const output = stdout.trim()
    if (!output) return null
    try { return JSON.parse(output) } catch { return output }
  }
  async function start() {
    child = spawn(daemon, daemonArgs, { stdio: 'ignore' })
    const started = child
    const error = new Promise((_, reject) => started.once('error', reject))
    for (let i = 0; i < 120; i++) {
      if (started.exitCode !== null) throw new Error(`byzed unexpectedly exited: ${started.exitCode}`)
      try {
        const info = await Promise.race([rpc('getblockchaininfo'), error])
        assert.equal(info.chain, 'regtest')
        assert.equal(await rpc('getconnectioncount'), 0, 'network must remain disconnected')
        return
      } catch (e) {
        if (e.message && /ENOENT|EACCES/.test(e.message)) throw e
        await sleep(1000)
      }
    }
    throw new Error('byzed regtest did not become ready')
  }
  async function stop() {
    const proc = child
    if (!proc) return
    try { await rpc('stop') } catch {}
    if (proc.exitCode === null) {
      await Promise.race([new Promise(resolve => proc.once('exit', resolve)), sleep(12000)])
    }
    if (proc.exitCode === null) {
      proc.kill('SIGTERM')
      await Promise.race([new Promise(resolve => proc.once('exit', resolve)), sleep(4000)])
    }
    if (proc.exitCode === null) proc.kill('SIGKILL')
    child = null
  }
  try {
    await start()
    const policy = loadPolicy(path.join(__dirname, '../config/pool-policy.json'))
    let payoutAddress = policy.feeAddress
    const reference = await rpc('validateaddress', [payoutAddress])
    if (reference?.isvalid !== true) {
      console.log('Pool address not valid on regtest: creating isolated wallet address.')
      await rpc('createwallet', ['byze-outage-test'])
      payoutAddress = String(await rpc('getnewaddress'))
    } else {
      console.log('Using an existing public address for read-only payout validation (no wallet required).')
    }
    assert.equal((await new PayoutAddressValidator(rpc).validate(payoutAddress)).ok, true)
    const app = new MinerApp({ alias:'outage-regtest', wallet:payoutAddress, threads:1,
      policy, byze:{ call:rpc }, noSubmit:true })
    app.validationGate.run = async (_peer, fn) => fn()
    const seen = new Set(), outcomes = [], attempts = { local:0, pool:0 }
    async function check(kind, packet) {
      attempts[kind]++
      const result = await new PayoutAddressValidator(rpc, { ttlMs:0 }).validate(payoutAddress)
      if (!result.ok) return result
      const id = packet.share.shareId || packet.share.poolShareId
      const duplicate = seen.has(id)
      seen.add(id)
      return { ok:true, duplicate }
    }
    app.acceptLocalShare = (_peer, packet) => check('local', packet)
    app.acceptPoolShare = (_peer, packet) => check('pool', packet)
    app.recordRemoteOutcome = (kind, packet, outcome) => outcomes.push({
      kind, id:packet.share.shareId || packet.share.poolShareId, outcome })
    const peer = 'ab'.repeat(32)
    let serial = 0
    function queue(kind) {
      serial++
      const id = (kind === 'local' ? 'ls:' : 'ps:') + serial.toString(16).padStart(64, '0')
      const packet = { share: kind === 'local' ? { shareId:id } : { poolShareId:id } }
      assert.equal(app.deferContext(kind, peer, packet), true)
      return id
    }
    function forceRetry() {
      for (const map of [app.deferredLocalShares, app.deferredPoolShares])
        for (const rec of map.values()) rec.retryAt = 0
      return app.retryDeferredContext()
    }
    await stop()
    // An actual byzed process is now down, while the real deferred retry loop runs.
    await assert.rejects(() => rpc('getblockchaininfo'))
    const t0 = Date.now()
    for (let i = 0; i < 3; i++) {
      queue('local'); queue('pool')
      await forceRetry()
      assert.equal(outcomes.length, 0, 'no false acceptance while Core is offline')
      assert.equal(app.deferredLocalShares.size, i + 1)
      assert.equal(app.deferredPoolShares.size, i + 1)
      await sleep(Math.ceil(downtime / 3))
    }
    assert.ok(Date.now() - t0 >= downtime)
    await start()
    await forceRetry()
    assert.equal(app.deferredLocalShares.size, 0)
    assert.equal(app.deferredPoolShares.size, 0)
    assert.equal(outcomes.length, 6)
    assert.ok(outcomes.every(x => x.outcome === 'accepted'))
    assert.equal(new Set(outcomes.map(x => x.id)).size, 6)
    const acceptedCount = outcomes.length
    await forceRetry()
    assert.equal(outcomes.length, acceptedCount, 'no duplicate share accounting')
    const expired = queue('pool')
    const rec = app.deferredPoolShares.get(expired)
    rec.firstSeen = Date.now() - 121000
    await forceRetry()
    assert.equal(app.deferredPoolShares.size, 0)
    assert.equal(outcomes.length, acceptedCount, 'expired deferred share must never be accepted')
    console.log(JSON.stringify({ result:'BYZE_REAL_BYZED_REGTEST_RPC_OUTAGE_PASSED',
      downtimeMs:Date.now()-t0, acceptedSyntheticPackets:acceptedCount,
      duplicateAcceptances:0, expiredDropped:1, attempts,
      scope:'real isolated byzed process, real RPC validation, synthetic share queue; not two-peer mining/PPLNS',
      network:'regtest', networkConnections:0 }))
  } finally {
    await stop()
    fs.rmSync(datadir, { recursive:true, force:true })
  }
}
main().catch(e => { console.error('BYZE_REGTEST_OUTAGE_FAILED:', e.stack || e.message); process.exitCode = 1 })
