'use strict'

const net = require('net')
const os = require('os')
const { resolveManagedComponent } = require('./native-components')
const { spawn, spawnSync } = require('child_process')
const {
  RANDOMX_PROOF_MODE,
  RANDOMX_SHARE_DIFFICULTY_MULTIPLIER,
  shareTargetFromNetworkTarget,
  hashMeetsTarget,
  headerNonce
} = require('./p2pool-randomx')
const { coinbaseMerkleBranch } = require('./mining-job-commitment')

const MAX_STRATUM_LINE = 10 * 1024 * 1024
const MAX_BLOCK_HEX = 16 * 1024 * 1024
const MAX_RANDOMX_VERIFY_QUEUE = 256

let nativeMessageHandler = null
function setNativeMessageHandler(handler) { nativeMessageHandler = typeof handler === 'function' ? handler : null }
function post(message) {
  try { nativeMessageHandler?.(message) } catch {}
  try { process.parentPort?.postMessage(message) } catch {}
}

function discoverBinary(kind, env = process.env) {
  const resolved = resolveManagedComponent(kind, { env })
  return resolved.ok ? resolved.path : ''
}

function minerFeatures(binary) {
  if (!binary) return []
  try {
    const result = spawnSync(binary, ['--features'], { encoding:'utf8', timeout:3000, windowsHide:true, env:minimalNativeEnv() })
    const text = `${result.stdout || ''}\n${result.stderr || ''}`
    return [...new Set(text.split(/[\s,;]+/).map((v)=>v.trim()).filter((v)=>/^[a-z0-9._-]{3,64}$/i.test(v)))]
  } catch { return [] }
}

function safeThreads(value) {
  const logical = Math.max(1, Number(os.availableParallelism?.() || os.cpus()?.length || 1))
  return Math.max(1, Math.min(logical, Math.floor(Number(value) || 1)))
}

function safeAddress(value) {
  const text = String(value || '').replace(/[\r\n\0\s]/g, '').slice(0, 160)
  return /^[A-Za-z0-9:._-]+$/.test(text) ? text : ''
}

function safeWorkerTag(value) {
  const text = String(value || 'contract-p2pool').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48)
  return text || 'contract-p2pool'
}

function normalizeJob(raw) {
  const job = raw && typeof raw === 'object' ? raw : {}
  const template = job.template && typeof job.template === 'object' ? job.template : {}
  const id = String(job.id || '').slice(0, 128)
  const target = String(template.target || '').toLowerCase()
  const previousblockhash = String(template.previousblockhash || '').toLowerCase()
  const templateHash = String(job.templateHash || '').toLowerCase()
  if (!/^rxj:[0-9a-f]{64}$/.test(id) || !/^[0-9a-f]{64}$/.test(target) || !/^[0-9a-f]{64}$/.test(previousblockhash) || !/^[0-9a-f]{64}$/.test(templateHash) || !/^[0-9a-f]{64}$/.test(String(job.jobCommitmentHash||'')) || !/^[0-9a-f]{64}$/.test(String(job.feePolicyHash||'')) || !(String(job.pplnsTipId||'')==='' || /^ps:[0-9a-f]{64}$/.test(String(job.pplnsTipId||'')))) return null
  return {
    id,
    templateHash,
    jobCommitmentHash: String(job.jobCommitmentHash || '').toLowerCase(),
    feePolicyHash: String(job.feePolicyHash || '').toLowerCase(),
    pplnsTipId: String(job.pplnsTipId || ''),
    template: {
      version: Math.floor(Number(template.version) || 0),
      previousblockhash,
      bits: String(template.bits || '').toLowerCase(),
      curtime: Math.floor(Number(template.curtime) || 0),
      mintime: Math.floor(Number(template.mintime || template.curtime) || 0),
      coinbasevalue: Math.floor(Number(template.coinbasevalue) || 0),
      height: Math.floor(Number(template.height) || 0),
      target,
      rules: Array.isArray(template.rules) ? template.rules.map(String).slice(0, 32) : [],
      default_witness_commitment: String(template.default_witness_commitment || '').toLowerCase(),
      coinbasescript: String(template.coinbasescript || '').toLowerCase(),
      coinbaseoutputs: Array.isArray(template.coinbaseoutputs) ? template.coinbaseoutputs.slice(0, 400).map((row) => ({ address:String(row?.address || '').slice(0,160), value:String(row?.value || ''), script:String(row?.script || '').toLowerCase() })) : [],
      directCoinbaseCommitment: String(template.directCoinbaseCommitment || '').toLowerCase(),
      transactions: Array.isArray(template.transactions) ? template.transactions.slice(0, 5000).map((tx) => ({ data:String(tx?.data || '').toLowerCase(), txid:String(tx?.txid || '').toLowerCase() })) : []
    }
  }
}

function lowerNativePriority(child, priority = 10) {
  const pid = Number(child?.pid || 0)
  if (!pid) return false
  try {
    os.setPriority(pid, Math.max(0, Math.min(19, Number(priority) || 10)))
    return true
  } catch {
    return false
  }
}

class RxVerifier {
  constructor(binary) {
    this.binary = binary
    this.child = null
    this.ready = false
    this.buffer = ''
    this.queue = []
    this.current = null
    this.queuedHeaders = new Set()
    this.busyRejected = 0
  }

  start() {
    if (!this.binary || this.child) return
    try {
      this.child = spawn(this.binary, ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: minimalNativeEnv() })
      lowerNativePriority(this.child, 12)
      this.child.stdout.setEncoding('utf8')
      this.child.stdout.on('data', (chunk) => this.onStdout(chunk))
      this.child.stderr.setEncoding('utf8')
      this.child.stderr.on('data', (chunk) => post({ kind: 'log', level: 'warn', message: String(chunk).trim().slice(0, 500) }))
      this.child.once('exit', () => { this.ready = false; this.child = null; this.failAll('randomxVerifierStopped') })
      this.child.once('error', () => { this.ready = false; this.child = null; this.failAll('randomxVerifierUnavailable') })
    } catch { this.child = null }
  }

  onStdout(chunk) {
    this.buffer += String(chunk || '')
    if (this.buffer.length > 1024 * 1024) this.buffer = ''
    while (true) {
      const i = this.buffer.indexOf('\n')
      if (i < 0) break
      const line = this.buffer.slice(0, i).trim()
      this.buffer = this.buffer.slice(i + 1)
      if (!line) continue
      if (line === 'READY') { this.ready = true; post({ kind: 'verifier-ready' }); this.pump(); continue }
      if (/^[0-9a-fA-F]{64}$/.test(line) && this.current) {
        const current = this.current
        this.current = null
        clearTimeout(current.timer)
        this.queuedHeaders.delete(current.header80)
        current.resolve(line.toLowerCase())
        this.pump()
      }
    }
  }

  verify(header80, timeoutMs = 60000) {
    const normalized = String(header80 || '').toLowerCase()
    if (!/^[0-9a-f]{160}$/i.test(normalized)) return Promise.reject(Object.assign(new Error('Invalid RandomX header'), { code: 'randomxHeaderInvalid' }))
    if ((this.current && this.current.header80 === normalized) || this.queuedHeaders.has(normalized)) {
      return Promise.reject(Object.assign(new Error('RandomX verification already queued'), { code: 'randomxVerifierDuplicate' }))
    }
    if (this.queue.length + (this.current ? 1 : 0) >= MAX_RANDOMX_VERIFY_QUEUE) {
      this.busyRejected += 1
      return Promise.reject(Object.assign(new Error('RandomX verifier busy'), { code: 'randomxVerifierBusy' }))
    }
    return new Promise((resolve, reject) => {
      const item = { header80: normalized, resolve, reject, timer: null }
      item.timer = setTimeout(() => {
        if (this.current === item) this.current = null
        else this.queue = this.queue.filter((row) => row !== item)
        this.queuedHeaders.delete(item.header80)
        reject(Object.assign(new Error('RandomX verifier timeout'), { code: 'randomxVerifierTimeout' }))
        this.pump()
      }, Math.max(2000, Math.min(Number(timeoutMs) || 60000, 120000)))
      this.queue.push(item)
      this.queuedHeaders.add(item.header80)
      this.pump()
    })
  }

  pump() {
    if (!this.ready || !this.child?.stdin || this.current || !this.queue.length) return
    this.current = this.queue.shift()
    try { this.child.stdin.write(`${this.current.header80}\n`) } catch {
      const item = this.current; this.current = null; clearTimeout(item.timer); this.queuedHeaders.delete(item.header80); item.reject(Object.assign(new Error('RandomX verifier write failed'), { code: 'randomxVerifierUnavailable' }))
    }
  }

  failAll(code) {
    const rows = [...this.queue]
    this.queue = []
    this.queuedHeaders.clear()
    if (this.current) rows.unshift(this.current)
    this.current = null
    for (const item of rows) { clearTimeout(item.timer); item.reject(Object.assign(new Error(code), { code })) }
  }

  stop() {
    this.failAll('randomxVerifierStopped')
    try { this.child?.kill('SIGTERM') } catch {}
    this.child = null
    this.ready = false
  }
}

function minimalNativeEnv() {
  const keep = ['HOME','USERPROFILE','PATH','TMPDIR','TEMP','TMP','SystemRoot','WINDIR','LANG','LC_ALL','DYLD_LIBRARY_PATH','LD_LIBRARY_PATH']
  const env = { CONTRACT_RANDOMX_WORKER: '1' }
  for (const key of keep) if (process.env[key] != null) env[key] = process.env[key]
  return env
}

class Supervisor {
  constructor() {
    this.server = null
    this.port = 0
    this.socket = null
    this.socketBuffer = ''
    this.miner = null
    this.minerBuffer = ''
    this.minerPath = discoverBinary('miner')
    this.minerFeatures = minerFeatures(this.minerPath)
    this.verifierPath = discoverBinary('verifier')
    this.verifier = new RxVerifier(this.verifierPath)
    this.config = null
    this.job = null
    this.startedAt = 0
    this.hashrate = 0
    this.accepted = 0
    this.rejected = 0
    this.networkCandidates = 0
    this.lastNetworkCandidateAt = 0
    this.lastNetworkCandidateHeight = 0
    this.lastNetworkCandidateBytes = 0
    this.lastError = ''
    this.lastStatusEmitAt = 0
    this.statusEmitTimer = null
  }

  refreshDiscovery() {
    if (!this.miner) { this.minerPath = discoverBinary('miner'); this.minerFeatures = minerFeatures(this.minerPath) }
    if (!this.verifier.child) {
      const nextVerifier = discoverBinary('verifier')
      if (nextVerifier !== this.verifierPath) {
        this.verifier.stop()
        this.verifierPath = nextVerifier
        this.verifier = new RxVerifier(this.verifierPath)
      }
    }
    if (this.minerPath && this.verifierPath && /^native-(?:miner|verifier)-not-found$/.test(this.lastError)) this.lastError = ''
    return this.status()
  }

  status() {
    return {
      backend: 'managed-byze-p2pool-miner',
      proofMode: RANDOMX_PROOF_MODE,
      minerAvailable: !!this.minerPath,
      verifierAvailable: !!this.verifierPath,
      verifierReady: !!this.verifier.ready,
      verifierQueueDepth: Number(this.verifier.queue.length + (this.verifier.current ? 1 : 0)),
      verifierQueueMax: MAX_RANDOMX_VERIFY_QUEUE,
      verifierBusyRejected: Number(this.verifier.busyRejected || 0),
      running: !!this.miner,
      ready: !!this.miner && !!this.verifier.ready && !!this.job,
      threads: Number(this.config?.threads || 0),
      maxThreads: Math.max(1, Number(os.availableParallelism?.() || os.cpus()?.length || 1)),
      hashrate: Number(this.hashrate || 0),
      accepted: Number(this.accepted || 0),
      rejected: Number(this.rejected || 0),
      networkCandidates: Number(this.networkCandidates || 0),
      lastNetworkCandidateAt: Number(this.lastNetworkCandidateAt || 0),
      lastNetworkCandidateHeight: Number(this.lastNetworkCandidateHeight || 0),
      lastNetworkCandidateBytes: Number(this.lastNetworkCandidateBytes || 0),
      jobId: String(this.job?.id || ''),
      height: Number(this.job?.template?.height || 0),
      lastError: String(this.lastError || '').slice(0, 300),
      blockSubmissionEnabled: false,
      blockSubmissionStage: 'quantum-signature-required',
      nativeMemoryNote: 'separate-miner-and-verifier-datasets',
      supervisorPid: Number(process.pid || 0),
      minerPid: Number(this.miner?.pid || 0),
      verifierPid: Number(this.verifier?.child?.pid || 0),
      nativeProcessesActive: Number(!!this.miner) + Number(!!this.verifier?.child),
      minerPriorityPolicy: 'normal',
      verifierPriorityPolicy: 'background',
      minerFeatures: [...this.minerFeatures],
      directCoinbaseSupported: this.minerFeatures.includes('contract-direct-coinbase-v2'),
      directCoinbaseCommitted: !!this.job?.template?.coinbaseoutputs?.length && this.minerFeatures.includes('contract-direct-coinbase-v2'),
      directCoinbaseCommitment: this.job?.template?.directCoinbaseCommitment || ''
    }
  }

  emitStatus({ immediate = false } = {}) {
    const now = Date.now()
    const minGapMs = 1500
    const send = () => {
      this.statusEmitTimer = null
      this.lastStatusEmitAt = Date.now()
      post({ kind: 'status', status: this.status() })
    }
    if (immediate || !this.lastStatusEmitAt || now - this.lastStatusEmitAt >= minGapMs) {
      if (this.statusEmitTimer) { clearTimeout(this.statusEmitTimer); this.statusEmitTimer = null }
      send()
      return
    }
    if (!this.statusEmitTimer) {
      this.statusEmitTimer = setTimeout(send, Math.max(10, minGapMs - (now - this.lastStatusEmitAt)))
      this.statusEmitTimer.unref?.()
    }
  }

  async ensureServer() {
    if (this.server) return
    await new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.acceptSocket(socket))
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        server.removeListener('error', reject)
        this.server = server
        this.port = Number(server.address()?.port || 0)
        resolve()
      })
    })
  }

  acceptSocket(socket) {
    if (socket.remoteAddress && !['127.0.0.1','::ffff:127.0.0.1','::1'].includes(socket.remoteAddress)) { socket.destroy(); return }
    if (this.socket && !this.socket.destroyed) { socket.destroy(); return }
    this.socket = socket
    this.socketBuffer = ''
    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    socket.on('data', (chunk) => this.onSocketData(chunk))
    socket.on('close', () => { if (this.socket === socket) this.socket = null })
    socket.on('error', () => {})
  }

  send(obj) {
    if (!this.socket || this.socket.destroyed) return false
    try { this.socket.write(`${JSON.stringify(obj)}\n`); return true } catch { return false }
  }

  sendJob() {
    if (!this.job) return false
    const t = this.job.template
    this.send({ id: null, method: 'mining.set_difficulty', params: [Number(this.config?.difficultyMultiplier || RANDOMX_SHARE_DIFFICULTY_MULTIPLIER)] })
    const directSupported = this.minerFeatures.includes('contract-direct-coinbase-v2')
    return this.send({ id: null, method: 'mining.notify', params: [this.job.id, {
      template: {
        version: t.version,
        mintime: t.mintime,
        coinbasevalue: t.coinbasevalue,
        coinbasescript: t.coinbasescript || '',
        coinbaseoutputs: directSupported ? (t.coinbaseoutputs || []) : [],
        direct_coinbase_commitment: directSupported ? (t.directCoinbaseCommitment || '') : '',
        rules: t.rules,
        default_witness_commitment: t.default_witness_commitment || '',
        transactions: t.transactions || []
      },
      previousblockhash: t.previousblockhash,
      bits: t.bits,
      curtime: t.curtime,
      height: t.height,
      target: t.target
    }] })
  }

  onSocketData(chunk) {
    this.socketBuffer += String(chunk || '')
    if (this.socketBuffer.length > MAX_STRATUM_LINE) { this.socket?.destroy(); this.socketBuffer = ''; return }
    while (true) {
      const nl = this.socketBuffer.indexOf('\n')
      if (nl < 0) break
      const raw = this.socketBuffer.slice(0, nl)
      this.socketBuffer = this.socketBuffer.slice(nl + 1)
      let msg
      try { msg = JSON.parse(raw) } catch { continue }
      void this.handleStratum(msg)
    }
  }

  async handleStratum(msg) {
    const method = String(msg?.method || '')
    if (method === 'mining.subscribe') {
      this.send({ id: msg.id ?? null, result: true, error: null })
      return
    }
    if (method === 'mining.authorize') {
      this.send({ id: msg.id ?? null, result: true, error: null })
      this.sendJob()
      return
    }
    if (method !== 'mining.submit') return
    const params = Array.isArray(msg.params) ? msg.params : []
    const blockHex = String(params[1] || '').toLowerCase()
    const jobId = String(params[2] || '')
    const coinbaseNoWitnessHex = String(params[3] || '').toLowerCase()
    if (!this.job || jobId !== this.job.id || !/^[0-9a-f]+$/.test(blockHex) || blockHex.length < 160 || blockHex.length > MAX_BLOCK_HEX || !/^[0-9a-f]+$/.test(coinbaseNoWitnessHex) || coinbaseNoWitnessHex.length % 2 || coinbaseNoWitnessHex.length > 128 * 1024) {
      this.rejected += 1; this.send({ id: msg.id ?? null, result: false, error: [20, 'invalid share', null] }); this.emitStatus(); return
    }
    const header80 = blockHex.slice(0, 160)
    try {
      const powHash = await this.verifier.verify(header80)
      const multiplier = Number(this.config?.difficultyMultiplier || RANDOMX_SHARE_DIFFICULTY_MULTIPLIER)
      const shareTarget = shareTargetFromNetworkTarget(this.job.template.target, multiplier)
      if (!shareTarget || !hashMeetsTarget(powHash, shareTarget)) throw Object.assign(new Error('share target miss'), { code: 'randomxTargetMiss' })
      const nonce = headerNonce(header80)
      const blockCandidate = hashMeetsTarget(powHash, this.job.template.target)
      const foundAt = Date.now()
      this.accepted += 1
      if (blockCandidate) {
        this.networkCandidates += 1
        this.lastNetworkCandidateAt = foundAt
        this.lastNetworkCandidateHeight = Number(this.job.template.height || 0)
        this.lastNetworkCandidateBytes = Math.floor(blockHex.length / 2)
      }
      const branchBuilt=coinbaseMerkleBranch((this.job.template.transactions||[]).map((tx)=>tx.txid))
      if(!branchBuilt.ok) throw Object.assign(new Error(branchBuilt.code),{code:branchBuilt.code})
      this.send({ id: msg.id ?? null, result: true, error: null })
      post({ kind: 'share', candidate: {
        jobId: this.job.id,
        templateHash: this.job.templateHash,
        jobCommitmentHash: this.job.jobCommitmentHash,
        feePolicyHash: this.job.feePolicyHash,
        pplnsTipId: this.job.pplnsTipId,
        coinbaseValue: String(this.job.template.coinbasevalue),
        coinbaseNoWitnessHex,
        coinbaseMerkleBranch: branchBuilt.branch,
        header80,
        nonce,
        powHash,
        networkTarget: this.job.template.target,
        shareTarget,
        previousBlockHash: this.job.template.previousblockhash,
        height: this.job.template.height,
        difficultyMultiplier: multiplier,
        blockCandidate,
        directCoinbaseCommitted: !!this.job.template.coinbaseoutputs?.length && this.minerFeatures.includes('contract-direct-coinbase-v2'),
        directCoinbaseCommitment: this.job.template.directCoinbaseCommitment || '',
        ...(blockCandidate ? { blockHex } : {}),
        foundAt
      } })
      this.emitStatus()
    } catch (error) {
      this.rejected += 1
      this.lastError = String(error?.code || error?.message || error || 'verification failed')
      this.send({ id: msg.id ?? null, result: false, error: [20, 'RandomX verification failed', null] })
      this.emitStatus()
    }
  }

  onMinerOutput(chunk) {
    this.minerBuffer += String(chunk || '')
    if (this.minerBuffer.length > 2 * 1024 * 1024) this.minerBuffer = this.minerBuffer.slice(-1024 * 1024)
    while (true) {
      const i = this.minerBuffer.indexOf('\n')
      if (i < 0) break
      const line = this.minerBuffer.slice(0, i).trim()
      this.minerBuffer = this.minerBuffer.slice(i + 1)
      const m = /hashrate=([0-9]+(?:\.[0-9]+)?)\s*H\/s/i.exec(line)
      if (m) { this.hashrate = Number(m[1]) || 0; this.emitStatus() }
      if (/error|failed|abort/i.test(line)) { this.lastError = line.slice(0, 300); this.emitStatus() }
    }
  }

  async configure(raw) {
    this.refreshDiscovery()
    const payoutAddress = safeAddress(raw?.payoutAddress)
    const threads = safeThreads(raw?.threads)
    const multiplier = Math.max(1, Math.min(1_000_000, Math.floor(Number(raw?.difficultyMultiplier) || RANDOMX_SHARE_DIFFICULTY_MULTIPLIER)))
    if (!payoutAddress) throw Object.assign(new Error('Payout address required'), { code: 'randomxPayoutInvalid' })
    const next = { instanceId: String(raw?.instanceId || '').slice(0, 128), payoutAddress, threads, workerTag: safeWorkerTag(raw?.workerTag), difficultyMultiplier: multiplier }
    const needsRestart = !this.config || this.config.payoutAddress !== next.payoutAddress || this.config.threads !== next.threads || this.config.workerTag !== next.workerTag || this.config.difficultyMultiplier !== next.difficultyMultiplier
    this.config = next
    if (!this.minerPath || !this.verifierPath) { this.lastError = !this.minerPath ? 'native-miner-not-found' : 'native-verifier-not-found'; this.emitStatus(); return this.status() }
    if (!this.minerFeatures.includes('contract-direct-coinbase-v2')) {
      this.stopMiner()
      this.lastError = 'managed-miner-direct-coinbase-v2-required'
      this.emitStatus({ immediate: true })
      return this.status()
    }
    this.lastError = ''
    await this.ensureServer()
    this.verifier.start()
    if (needsRestart || !this.miner) this.startMiner()
    this.emitStatus({ immediate: true })
    return this.status()
  }

  startMiner() {
    this.stopMiner()
    if (!this.minerPath || !this.port || !this.config) return
    const args = ['--pool', `127.0.0.1:${this.port}`, '--wallet', this.config.payoutAddress, '--worker', this.config.workerTag, '--threads', String(this.config.threads), '--pool-difficulty', String(this.config.difficultyMultiplier)]
    try {
      const child = spawn(this.minerPath, args, { stdio: ['ignore','pipe','pipe'], windowsHide: true, env: minimalNativeEnv() })
      this.miner = child
      this.startedAt = Date.now()
      child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => this.onMinerOutput(chunk))
      child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => this.onMinerOutput(chunk))
      child.once('exit', (code) => { if (this.miner !== child) return; this.miner = null; this.hashrate = 0; this.lastError = `byze-p2pool-miner-exit-${code ?? 'unknown'}`; this.emitStatus() })
      child.once('error', (error) => { if (this.miner !== child) return; this.miner = null; this.hashrate = 0; this.lastError = String(error?.message || error); this.emitStatus() })
    } catch (error) { this.miner = null; this.lastError = String(error?.message || error); this.emitStatus() }
  }

  stopMiner() {
    try { this.socket?.destroy() } catch {}
    this.socket = null
    try { this.miner?.kill('SIGTERM') } catch {}
    this.miner = null
    this.hashrate = 0
  }

  setJob(raw) {
    const job = normalizeJob(raw)
    if (!job) throw Object.assign(new Error('Invalid RandomX job'), { code: 'randomxJobInvalid' })
    this.job = job
    this.sendJob()
    this.emitStatus()
    return this.status()
  }

  async verify(header80) {
    if (!this.verifierPath) throw Object.assign(new Error('byze-rxhash unavailable'), { code: 'randomxVerifierUnavailable' })
    this.verifier.start()
    return this.verifier.verify(String(header80 || '').toLowerCase(), 90_000)
  }

  stop() {
    this.stopMiner()
    this.verifier.stop()
    try { this.server?.close() } catch {}
    this.server = null
    this.port = 0
    this.job = null
    this.config = null
    if (this.statusEmitTimer) { clearTimeout(this.statusEmitTimer); this.statusEmitTimer = null }
    this.emitStatus({ immediate: true })
  }
}

const supervisor = new Supervisor()

async function handle(message) {
  const id = String(message?.id || '')
  const action = String(message?.action || '')
  try {
    let result
    if (action === 'discover') result = supervisor.refreshDiscovery()
    else if (action === 'configure') result = await supervisor.configure(message.payload || {})
    else if (action === 'job') result = supervisor.setJob(message.payload || {})
    else if (action === 'verify') result = { hash: await supervisor.verify(message.payload?.header80) }
    else if (action === 'stop') { supervisor.stop(); result = { ok: true } }
    else throw Object.assign(new Error('Unsupported RandomX action'), { code: 'randomxActionBlocked' })
    post({ kind: 'response', id, ok: true, result })
  } catch (error) {
    post({ kind: 'response', id, ok: false, code: String(error?.code || 'randomxWorkerError'), error: String(error?.message || error || 'RandomX worker error').slice(0, 500) })
  }
}

if (process.parentPort) {
  process.parentPort.on('message', (event) => { const message = event?.data || {}; if (message.kind === 'call') void handle(message) })
  supervisor.emitStatus()
}

module.exports = { discoverBinary, safeThreads, normalizeJob, Supervisor, RxVerifier, minimalNativeEnv, MAX_RANDOMX_VERIFY_QUEUE, setNativeMessageHandler }
