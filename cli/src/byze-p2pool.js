#!/usr/bin/env node
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync, execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const readline = require('readline/promises')
const { stdin, stdout } = require('process')
const Hyperswarm = require('hyperswarm')
const DHT = require('hyperdht')
const b4a = require('b4a')

const {
  canonical,
  localShareSigningPayload,
  buildGlobalEpochCheckpoint,
  buildPoolShare,
  electCellRelays,
  calculateDirectPayouts
} = require('./mining/p2pool-protocol')
const {
  DEFAULT_TTL_MS,
  presenceSigningPayload,
  validatePresenceShape,
  membershipSeed,
  isDeterministicCellId,
  assignLiveCells
} = require('./mining/p2pool-membership')
const {
  RANDOMX_PROOF_MODE,
  RANDOMX_SHARE_DIFFICULTY_MULTIPLIER,
  sanitizeGbtTemplate,
  randomxTemplateHash,
  randomxJobId,
  proofEnvelopeSigningPayload,
  buildRandomxLocalShare,
  validateRandomxEnvelope,
  randomxCheckpoint
} = require('./mining/p2pool-randomx')
const COORDINATION_PROOF_MODE = 'coordination-test-v1'
const { POOLSHARE_WINDOW, PoolShareChain } = require('./mining/poolshare-chain')
const {
  MAX_CELL_CHECKPOINT_PROOFS,
  cellCheckpointSigningPayload,
  validateCellCheckpointPacketShape,
  splitCellCheckpointPacket,
  CellCheckpointProofAssembler
} = require('./mining/cell-checkpoint-bundle')
const {
  MAX_POOLSHARE_PROOFS
} = require('./mining/poolshare-proof-bundle')
const { normalizePlan: normalizeDirectCoinbasePlan, resolveScripts: resolveDirectCoinbaseScripts } = require('./mining/direct-coinbase')
const { fitTemplateWeight } = require('./mining/block-weight')
const { PayoutAddressValidator, TRANSIENT_PAYOUT_CODES } = require('./mining/payout-address')
const { publishQuantumBlock } = require('./mining/byze-block-publisher')
const { createPoolFeePolicy, DEFAULT_POOL_FEE_BASIS_POINTS } = require('./mining/pool-fee-policy')
const { Supervisor, setNativeMessageHandler } = require('./mining/native-bridge')
const { buildJobCommitment, verifyCoinbaseBinding } = require('./mining/mining-job-commitment')
const { satoshisToByze, sumPayoutFromVouts } = require('./reward-telemetry')
const { ANSI, color, launchPresentation, statusLine, rewardCelebration } = require('./console-ui')
const { assertMainnetReady, PeerRateLimiter, ValidationGate } = require('./security-hardening')

const APP_VERSION = require('../package.json').version
const CONTRACT_ID = 'org.contract.byze-p2pool'
const CONTRACT_VERSION = '0.1.3'
const CONTRACT_SOURCE_HASH = '0ba509a74eb5f475ce41f152349fe49a7d19e4fbd6c14c1833632c61681a0b66'
const BUILTIN_PUBLISHER_KEY = '77a412df63379feff5e8a0cdef364b10377d7fcd0d2753f6000b48bf5b4e523e'
const POOL_ID = 'byze-main-p2pool-v1'
const SECURITY_GENERATION = 'coinbase-binding-v2-global-epoch-v6'
const CELL_MAX_MEMBERS = 20
const WORK_EPOCH_MS = 60_000
const RELAY_TERM_MS = 10 * 60_000
const RELAY_BACKUPS = 2
const RELAY_FAILOVER_GRACE_MS = 12_000
const GLOBAL_AGGREGATION_GRACE_MS = 30_000
const MAX_CELL_CHECKPOINT_CACHE = 512
const PRESENCE_HEARTBEAT_MS = 20_000
const PRESENCE_TTL_MS = Math.max(90_000, DEFAULT_TTL_MS)
const MAX_FRAME_BYTES = 256 * 1024
const P2P_MAX_PEERS = 64
const P2P_RATE_WINDOW_MS = 10_000
const P2P_MAX_FRAMES_PER_WINDOW = 120
const P2P_MAX_BYTES_PER_WINDOW = 2 * 1024 * 1024
const P2P_MAX_EXPENSIVE_FRAMES_PER_WINDOW = 48
const P2P_RATE_STRIKES_TO_BLOCK = 3
const P2P_BLOCK_MS = 60_000
const MAX_POOL_PACKET_CACHE = 64
const MAX_LIVE_SHARE_AGE_MS = 4 * 60_000
const PRE_PRESENCE_GRACE_MS = 5_000
const MAX_PRE_PRESENCE_FRAMES_PER_PEER = 24
const MAX_PRE_PRESENCE_FRAMES_TOTAL = 256
const DEFERRED_CONTEXT_TTL_MS = 120_000
const DEFERRED_CONTEXT_RETRY_MS = 2_000
const MAX_DEFERRED_CONTEXT_ITEMS = 128
// Verdicts that describe this node's momentary state, not the share: retry instead of rejecting.
const DEFERRABLE_CODES = new Set(['consensus-context-unknown','pplns-context-unknown',...TRANSIENT_PAYOUT_CODES])

const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function sha256Hex(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function safeAlias(value) { return String(value || '').replace(/[\r\n\0]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 48) || 'Miner' }
function safeAddress(value) { const s = String(value || '').replace(/[\r\n\0\s]/g, '').slice(0, 160); return /^[A-Za-z0-9:._-]{8,160}$/.test(s) ? s : '' }
function validPeerKey(value) { return /^[0-9a-f]{64}$/.test(String(value || '').toLowerCase()) }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)) }
function formatHps(value) {
  let n = Math.max(0, Number(value) || 0)
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GH/s`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MH/s`
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)} kH/s`
  return `${n.toFixed(1)} H/s`
}
function short(value, left = 10, right = 8) { const s = String(value || ''); return s.length > left + right + 3 ? `${s.slice(0,left)}...${s.slice(-right)}` : s }
function localClock() { const d=new Date(); return [d.getHours(),d.getMinutes(),d.getSeconds()].map((n)=>String(n).padStart(2,'0')).join(':') }
function log(...args) { console.log(localClock(), ...args) }
function warn(...args) { console.error(localClock(), 'WARN', ...args) }

function privateKeyFromSeed(seed) {
  return crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' })
}
function sign(seed, payload) {
  return crypto.sign(null, Buffer.from(canonical(payload)), privateKeyFromSeed(seed)).toString('base64')
}
function verify(peerKey, payload, signature) {
  try {
    if (!validPeerKey(peerKey)) return false
    const sig = Buffer.from(String(signature || ''), 'base64')
    if (sig.length !== 64) return false
    const publicKey = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(peerKey, 'hex')]), format: 'der', type: 'spki' })
    return crypto.verify(null, Buffer.from(canonical(payload)), publicKey, sig)
  } catch { return false }
}

function argMap(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) { out._.push(token); continue }
    const key = token.slice(2)
    if (['help','version','dry-run','no-submit'].includes(key)) { out[key] = true; continue }
    out[key] = argv[i + 1]; i += 1
  }
  return out
}
function help() {
  console.log(`BYZE P2Pool CLI ${APP_VERSION}\n\nUsage:\n  byze-p2pool --alias Eric --wallet byz1... --threads 8\n\nOptions:\n  --alias NAME          Alias announced to the P2P pool\n  --wallet ADDRESS      Public BYZE payout address\n  --threads N           RandomX CPU threads (1..logical CPUs)\n  --byze-cli PATH       Path to byze-cli if auto-detection fails\n  --native-dir PATH     Managed directory containing byze-p2pool-miner and byze-rxhash\n  --bootstrap NODES     HOST:PORT[,HOST:PORT], or none; replaces public DHT seeds\n  --policy PATH         Pool policy file (default: config/pool-policy.json)\n  --no-submit           Never submit a found block (diagnostic)\n  --dry-run             Check node, policy and binaries without mining\n  --version             Show version and exit
  --help                Show help\n\nNo P2P profile is created on disk. The P2P identity is temporary.`)
}

function executable(file) {
  if (!file) return false
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false }
}
function which(name) {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding:'utf8', timeout:1500, windowsHide:true })
    return String(r.stdout || '').split(/\r?\n/).map((x)=>x.trim()).find(executable) || ''
  } catch { return '' }
}
function detectByzeCli(explicit = '') {
  const exe = process.platform === 'win32' ? 'byze-cli.exe' : 'byze-cli'
  const candidates = [
    explicit,
    process.env.BYZE_CLI,
    which(exe),
    path.join(os.homedir(), 'ldev', 'byze', 'build', 'bin', exe),
    path.join(os.homedir(), 'byze', 'build', 'bin', exe),
    path.join(os.homedir(), 'Downloads', 'byze', 'build', 'bin', exe),
    process.platform === 'win32' ? path.join(os.homedir(), 'ldev', 'byze', 'build', 'bin', 'Release', exe) : ''
  ].filter(Boolean)
  return candidates.find(executable) || ''
}
function encodeCliArg(value) {
  if (value === null || typeof value === 'object' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  return String(value)
}
class ByzeCli {
  constructor(binary) { this.binary = binary }
  async call(method, params = [], { timeout = 30_000, parse = true } = {}) {
    const args = [String(method), ...params.map(encodeCliArg)]
    let result
    try {
      result = await execFileAsync(this.binary, args, { encoding:'utf8', timeout, windowsHide:true, maxBuffer:32 * 1024 * 1024 })
    } catch (error) {
      const detail = String(error?.stderr || error?.stdout || error?.message || error).trim()
      throw Object.assign(new Error(`${method}: ${detail}`), { code:'byzeRpcError' })
    }
    const text = String(result.stdout || '').trim()
    if (!parse) return text
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }
  }
}

function loadPolicy(policyPath) {
  const raw = JSON.parse(fs.readFileSync(policyPath, 'utf8'))
  const policy = createPoolFeePolicy({ poolId: raw.poolId, feeAddress: raw.feeAddress, feeBasisPoints: raw.feeBasisPoints })
  if (!policy.ok) throw new Error(`Invalid pool policy: ${policy.code}`)
  if (policy.poolId !== POOL_ID || Number(policy.feeBasisPoints) !== DEFAULT_POOL_FEE_BASIS_POINTS) throw new Error('Policy is incompatible with byze-main-p2pool-v1 / 0.5%.')
  return policy
}

function uuidInstance() { return `cfi1:${crypto.randomUUID()}` }

const {parseBootstrap,dhtOptions}=require('./dht-config')

class P2PTransport {
  constructor({ seed, alias, topicHex, onFrame, onPeerChange, bootstrap }) {
    this.seed = seed
    this.alias = alias
    this.topic = Buffer.from(topicHex, 'hex')
    this.onFrame = onFrame
    this.onPeerChange = onPeerChange
    this.peers = new Map()
    this.dht = new DHT(dhtOptions(bootstrap))
    this.rateLimiter = new PeerRateLimiter()
    this.swarm = new Hyperswarm({ seed, dht:this.dht, maxPeers:P2P_MAX_PEERS, maxParallel:8 })
    this.peerKey = b4a.toString(this.swarm.keyPair.publicKey, 'hex').toLowerCase()
    this.discovery = null
    this.refreshTimer = null
    this.installHandlers()
  }
  installHandlers() {
    this.swarm.on('connection', (conn, info) => {
      const remote = info?.publicKey || conn.remotePublicKey
      if (!remote) return
      const peerKey = b4a.toString(remote, 'hex').toLowerCase()
      if (!validPeerKey(peerKey) || peerKey === this.peerKey || this.rateLimiter.isBlocked(peerKey)) { try { conn.destroy() } catch {}; return }
      const old = this.peers.get(peerKey)
      if (old?.conn && old.conn !== conn && !old.conn.destroyed) { try { old.conn.destroy() } catch {} }
      const peer = { conn, peerKey, buffer:'', alias:'Contact', connectedAt:Date.now(), ready:false }
      this.peers.set(peerKey, peer)
      this.send(peerKey, { v:4, type:'hello', alias:this.alias, inboundMode:'invite', byzeAddress:'', byzeAddressScope:'', shareEncryptionPublicKey:'', shareSigningPublicKey:'', ts:Date.now() })
      conn.on('data', (chunk) => this.consume(peer, chunk))
      conn.on('error', () => {})
      conn.once('close', () => {
        if (this.peers.get(peerKey)?.conn !== conn) return
        this.peers.delete(peerKey)
        this.onPeerChange?.(peerKey, false)
      })
      this.onPeerChange?.(peerKey, true)
    })
  }
  consume(peer, chunk) {
    peer.buffer += b4a.toString(chunk)
    if (Buffer.byteLength(peer.buffer, 'utf8') > MAX_FRAME_BYTES) { peer.buffer=''; try { peer.conn.destroy() } catch {}; return }
    while (true) {
      const i = peer.buffer.indexOf('\n')
      if (i < 0) break
      const raw = peer.buffer.slice(0,i); peer.buffer = peer.buffer.slice(i+1)
      if (!raw || Buffer.byteLength(raw,'utf8') > MAX_FRAME_BYTES) continue
      let frame
      try { frame = JSON.parse(raw) } catch {
        const limited=this.rateLimiter.allow(peer.peerKey,{bytes:Buffer.byteLength(raw,'utf8'),type:'invalid-json'})
        if(limited.blocked){try{peer.conn.destroy()}catch{}};
        continue
      }
      const limited=this.rateLimiter.allow(peer.peerKey,{bytes:Buffer.byteLength(raw,'utf8'),type:frame?.type})
      if(!limited.ok){if(limited.blocked){try{peer.conn.destroy()}catch{}};continue}
      if (frame?.type === 'hello') {
        peer.alias = safeAlias(frame.alias || 'Contact'); peer.ready = true; continue
      }
      if (['mining-presence','mining-local-share','mining-cell-checkpoint','mining-pool-share','mining-pool-share-request','mining-pool-share-inventory','mining-pool-share-page'].includes(frame?.type)) {
        this.onFrame?.(peer.peerKey, frame)
      }
    }
  }
  async start() {
    this.discovery = this.swarm.join(this.topic, { server:true, client:true, limit:P2P_MAX_PEERS })
    await this.discovery.flushed?.()
    await this.discovery.refresh?.({ server:true, client:true })
    await this.swarm.flush()
    this.refreshTimer = setInterval(() => {
      Promise.resolve(this.discovery?.refresh?.({server:true,client:true})).then(()=>this.swarm.flush()).catch(()=>{})
    }, 15_000)
    this.refreshTimer.unref?.()
  }
  send(peerKey, frame) {
    const peer = this.peers.get(String(peerKey || '').toLowerCase())
    if (!peer?.conn || peer.conn.destroyed) return false
    try { const data=b4a.from(`${JSON.stringify(frame)}\n`);if(data.length>MAX_FRAME_BYTES||Number(peer.conn.writableLength||0)+data.length>512*1024)return false;peer.conn.write(data);return true } catch { return false }
  }
  broadcast(frame, filter = null) {
    let n=0
    for (const [key, peer] of this.peers) {
      if (!peer?.conn || peer.conn.destroyed || (filter && !filter(key, peer))) continue
      if (this.send(key, frame)) n += 1
    }
    return n
  }
  connected(peerKey) { const p=this.peers.get(peerKey); return !!p?.conn && !p.conn.destroyed }
  async close() {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    try { await this.discovery?.destroy?.() } catch {}
    for (const p of this.peers.values()) try { p.conn.destroy() } catch {}
    try { await this.swarm.destroy() } catch {}
    try { await this.dht.destroy() } catch {}
  }
}

const {poolAnchor,ChainContextValidator}=require('./mining/chain-context')
const {HistorySync,MAX_HISTORY_AGE_MS}=require('./mining/history-sync')

class MinerApp {
  constructor(opts) {
    this.bootstrap = opts.bootstrap
    this.alias = opts.alias
    this.payoutAddress = opts.wallet
    this.threads = opts.threads
    this.policy = opts.policy
    this.byze = opts.byze
    this.submitBlocks = !opts.noSubmit
    this.seed = crypto.randomBytes(32)
    this.instanceId = uuidInstance()
    this.transport = null
    this.peerKey = ''
    this.remotePresence = new Map()
    this.localSeq = 0
    this.liveShares = new Map()
    this.shareSlots = new Map()
    this.poolChain = new PoolShareChain({ maxShares:512, window:POOLSHARE_WINDOW, maxOrphans:128 })
    this.poolPackets = new Map()
    this.cellCheckpointPackets = new Map()
    this.publishedCellCheckpoints = new Map()
    this.promotedEpochs = new Map()
    this.cellAssembler = new CellCheckpointProofAssembler({ maxBundles:24, maxBytes:16*1024*1024, ttlMs:120_000 })
    this.supervisor = new Supervisor()
    this.workerState = this.supervisor.status()
    this.lastTemplate = null
    this.lastTemplateHash = ''
    this.currentJob = null
    this.directPlan = null
    this.jobContexts = new Map()
    this.payoutValidator = opts.payoutValidator || new PayoutAddressValidator((m,p) => this.byze.call(m,p,{timeout:10_000}), { warn })
    this.lastGbtAt = 0
    this.running = false
    this.acceptedLocal = 0
    this.acceptedRemote = 0
    this.rejectedRemote = 0
    this.droppedStaleRemote = 0
    this.acceptedRemotePoolShares = 0
    this.rejectedRemotePoolShares = 0
    this.lastRemoteRejectCode = ''
    this.lastRemoteRejectShareId = ''
    this.remoteOutcomeIds = new Map()
    this.compatIgnoredRemote = 0
    this.lastStatsAt = 0
    this.uiReady = false
    this.timers = []
    this.chainContext = new ChainContextValidator((m,p)=>this.byze.call(m,p,{timeout:10000}))
    this.history = new HistorySync({send:(peer,frame)=>!!this.remotePoolPeer(peer)&&this.transport.send(peer,frame),getPacket:id=>this.poolPackets.get(id),known:id=>this.poolChain.byId.has(id),receive:(peer,packet)=>this.onFrame(peer,{type:'mining-pool-share',packet},{requestedHistory:true})})
    this.randomxVerifyInflight = new Map()
    this.pendingLocalShareIds = new Set()
    this.pendingPoolShareIds = new Set()
    this.prePresenceFrames = new Map()
    this.deferredLocalShares = new Map()
    this.deferredPoolShares = new Map()
    this.missingTipRequestAt = new Map()
    this.retryingDeferred = false
    this.validationGate = new ValidationGate()
    this.presenceGate = new ValidationGate({maxGlobal:8,maxPerPeer:1})
    this.sessionStartHeight = 0
    this.lastRewardScanHeight = 0
    this.rewardScanBusy = false
    this.rewardBlocks = new Map()
    this.sessionRewardSatoshis = 0n
    this.sessionRewardBlockCount = 0
    this.lastReward = null
    this.payoutScriptHex = ''
    this.rewardScannerSupported = true
  }

  discoveryTopic() {
    return sha256Hex(Buffer.from(`contract-mining\0${CONTRACT_SOURCE_HASH}\0${POOL_ID}\0${this.policy.policyHash}\0${SECURITY_GENERATION}`))
  }

  selfPresence(now = Date.now(), state='MINING') {
    this.localSeq = Math.max(this.localSeq + 1, Math.floor(now))
    const payload = presenceSigningPayload({
      securityGeneration:SECURITY_GENERATION, peerKey:this.peerKey, alias:this.alias, instanceId:this.instanceId,
      contractId:CONTRACT_ID, version:CONTRACT_VERSION, publisherKey:BUILTIN_PUBLISHER_KEY,
      sourceHash:CONTRACT_SOURCE_HASH, poolId:POOL_ID, payoutAddress:this.payoutAddress,
      feePolicyHash:this.policy.policyHash, feeBasisPoints:this.policy.feeBasisPoints, feeAddress:this.policy.feeAddress,
      miningState:state, updatedAt:now, expiresAt:now+(state==='LEFT'?30_000:PRESENCE_TTL_MS), seq:this.localSeq
    })
    const telemetry = { hashrateHps:Math.min(1e12, Math.max(0, Number(this.workerState.hashrate)||0)), observedAt:now }
    return { ...payload, telemetry, signature:sign(this.seed,payload) }
  }

  broadcastPresence(state='MINING') {
    const announcement = this.selfPresence(Date.now(), state)
    return this.transport.broadcast({ v:9, type:'mining-presence', announcement })
  }

  async acceptPresence(transportPeerKey, announcement) {
    const peerKey = String(transportPeerKey || '').toLowerCase()
    const checked = validatePresenceShape(announcement, { now:Date.now(), expectedPeerKey:peerKey })
    if (!checked.ok) return checked
    const p = checked.payload
    if (p.securityGeneration !== SECURITY_GENERATION) return {ok:false,code:'miningProtocolUpgradeRequired'}
    if (p.contractId!==CONTRACT_ID || p.version!==CONTRACT_VERSION || p.publisherKey!==BUILTIN_PUBLISHER_KEY || p.sourceHash!==CONTRACT_SOURCE_HASH || p.poolId!==POOL_ID) return {ok:false,code:'contract-mismatch'}
    if (p.feePolicyHash!==this.policy.policyHash || Number(p.feeBasisPoints)!==Number(this.policy.feeBasisPoints) || p.feeAddress!==this.policy.feeAddress) return {ok:false,code:'fee-policy-mismatch'}
    if (!verify(peerKey,p,announcement.signature)) return {ok:false,code:'signature-invalid'}
    const prior=this.remotePresence.get(peerKey)
    if (prior && (p.seq < prior.payload.seq || (p.seq===prior.payload.seq && p.updatedAt<=prior.payload.updatedAt))) return {ok:true,ignored:true}
    if (p.miningState==='LEFT') { this.remotePresence.delete(peerKey); return {ok:true,left:true,payload:p,firstSeen:false} }
    const addressCheck = await this.payoutValidator.validate(p.payoutAddress)
    if (!addressCheck.ok) return addressCheck
    // RPC validation yields: a newer heartbeat may have arrived meanwhile.
    const latest = this.remotePresence.get(peerKey)
    if (latest && (p.seq < latest.payload.seq || (p.seq === latest.payload.seq && p.updatedAt <= latest.payload.updatedAt))) return {ok:true,ignored:true}
    if (p.expiresAt <= Date.now()) return {ok:false,code:'miningPresenceExpired'}
    const firstSeen = !latest
    this.remotePresence.set(peerKey,{payload:p,telemetry:this.safeTelemetry(announcement.telemetry),receivedAt:Date.now()})
    if (firstSeen) setImmediate(()=>this.syncPoolHistory(peerKey))
    return {ok:true,payload:p,firstSeen}
  }

  safeTelemetry(raw) {
    const now=Date.now(), observedAt=Math.max(0,Math.floor(Number(raw?.observedAt)||0)), hashrateHps=Math.max(0,Math.min(1e12,Number(raw?.hashrateHps)||0))
    return observedAt && observedAt<=now+60_000 && now-observedAt<=30_000 ? {observedAt,hashrateHps} : {observedAt:0,hashrateHps:0}
  }

  members(now=Date.now()) {
    const rows=[{peerKey:this.peerKey,alias:this.alias,instanceId:this.instanceId,payoutAddress:this.payoutAddress,miningState:'MINING',updatedAt:now,local:true,transportConnected:true,hashrateHps:Number(this.workerState.hashrate)||0,hashrateObservedAt:now}]
    for (const [peerKey,rec] of [...this.remotePresence]) {
      const p=rec.payload
      if (!p || p.expiresAt<=now || p.miningState==='LEFT') { this.remotePresence.delete(peerKey); continue }
      if (p.contractId!==CONTRACT_ID || p.version!==CONTRACT_VERSION || p.publisherKey!==BUILTIN_PUBLISHER_KEY || p.sourceHash!==CONTRACT_SOURCE_HASH || p.poolId!==POOL_ID) continue
      const t=this.safeTelemetry(rec.telemetry)
      rows.push({peerKey,alias:p.alias,instanceId:p.instanceId,payoutAddress:p.payoutAddress,miningState:p.miningState,updatedAt:p.updatedAt,local:false,transportConnected:this.transport.connected(peerKey),hashrateHps:t.hashrateHps,hashrateObservedAt:t.observedAt})
    }
    const unique=new Map(); for(const r of rows){const prev=unique.get(r.peerKey); if(!prev||r.updatedAt>=prev.updatedAt)unique.set(r.peerKey,r)}
    return [...unique.values()]
  }

  live(now=Date.now()) {
    const members=this.members(now)
    const assigned=assignLiveCells({members,contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID,maxMembers:CELL_MAX_MEMBERS})
    if(!assigned.ok)return null
    const cellId=assigned.byPeer[this.peerKey]||''
    const cell=assigned.cells.find(c=>c.id===cellId)||null
    const epoch=Math.floor(now/WORK_EPOCH_MS), relayTerm=Math.floor(now/RELAY_TERM_MS)
    const eligible=(cell?.members||[]).filter(m=>['JOINED','MINING','PAUSED'].includes(String(m.miningState||'').toUpperCase()))
    const relay=eligible.length?electCellRelays({members:eligible,cellId,epoch:relayTerm,seed:membershipSeed({contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID}),backups:RELAY_BACKUPS}):null
    return {cellId,cellIndex:cell?.index||0,members:cell?.members||[],poolOnlineCount:members.length,epoch,relay:relay?.ok?{primary:relay.primary,backups:relay.backups}:{primary:'',backups:[]}}
  }

  remotePoolPeer(peerKey, now=Date.now()) {
    const p=this.remotePresence.get(String(peerKey||'').toLowerCase())?.payload
    return !!p && p.expiresAt>now && p.sourceHash===CONTRACT_SOURCE_HASH && p.poolId===POOL_ID && p.feePolicyHash===this.policy.policyHash && ['JOINED','MINING','PAUSED'].includes(String(p.miningState||'').toUpperCase())
  }

  pruneShares(now=Date.now()) {
    for(const [id,rec] of this.liveShares){ if(!rec?.share || now-Number(rec.share.createdAt||0)>MAX_LIVE_SHARE_AGE_MS){this.liveShares.delete(id); if(rec?.share)this.shareSlots.delete(this.slotKey(rec.share))} }
  }
  slotKey(s){return [s?.contractHash||'',s?.poolId||'',s?.cellId||'',Number(s?.epoch||0),s?.minerPeerId||'',s?.nonce||''].join(':')}
  storeShare(packet,{local=false}={}){
    const s=packet?.share; if(!s?.shareId)return {ok:false}
    this.pruneShares(); const key=this.slotKey(s), existing=this.shareSlots.get(key)
    if(existing&&existing!==s.shareId)return {ok:false,code:'duplicate-nonce'}
    if(this.liveShares.has(s.shareId))return {ok:true,duplicate:true}
    this.liveShares.set(s.shareId,{...clone(packet),local,receivedAt:Date.now()}); this.shareSlots.set(key,s.shareId); return {ok:true}
  }

  async validateConsensusContext(proof, options={}) {
    return this.chainContext.validate(proof,this.lastTemplate,options)
  }

  async verifyRandomxHash(header80, expectedHash) {
    const header=String(header80||'').toLowerCase(), expected=String(expectedHash||'').toLowerCase()
    if(!/^[0-9a-f]{160}$/.test(header)||!/^[0-9a-f]{64}$/.test(expected))return {ok:false,code:'randomx-proof-invalid'}
    let pending=this.randomxVerifyInflight.get(header)
    if(!pending){
      pending=Promise.resolve().then(()=>this.supervisor.verify(header))
      this.randomxVerifyInflight.set(header,pending)
      pending.finally(()=>{if(this.randomxVerifyInflight.get(header)===pending)this.randomxVerifyInflight.delete(header)}).catch(()=>{})
    }
    try{
      const actual=String(await pending||'').toLowerCase()
      return /^[0-9a-f]{64}$/.test(actual)&&actual===expected ? {ok:true,hash:actual} : {ok:false,code:'randomx-hash-mismatch'}
    }catch(error){return {ok:false,code:error?.code||'randomx-verifier-unavailable'}}
  }

  async acceptLocalShare(peerKey, packet) {
    if(!this.remotePoolPeer(peerKey)||!packet?.share||typeof packet.signature!=='string')return {ok:false,code:'share-unauthorized'}
    const rawShareId=String(packet.share.shareId||'')
    if(/^ls:[0-9a-f]{64}$/.test(rawShareId)){
      if(this.liveShares.has(rawShareId))return {ok:true,duplicate:true}
      if(this.pendingLocalShareIds.has(rawShareId))return {ok:true,duplicate:true,pending:true}
      this.pendingLocalShareIds.add(rawShareId)
    }
    try{
      if(String(packet.share.minerPeerId||'').toLowerCase()!==peerKey)return {ok:false,code:'share-peer-mismatch'}
      const shareCellId=String(packet.share.cellId||'')
      if(!isDeterministicCellId({cellId:shareCellId,contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID}))return {ok:false,code:'share-cell-invalid'}
      const member=this.members().find(m=>m.peerKey===peerKey); if(!member||String(member.miningState).toUpperCase()!=='MINING')return {ok:false,code:'share-member-invalid'}
      if(packet.proofMode!==RANDOMX_PROOF_MODE)return {ok:false,code:'share-proof-mode-invalid'}
      const checked=validateRandomxEnvelope(packet,{expectedPeerId:peerKey,expectedPayoutAddress:member.payoutAddress,expectedContractHash:CONTRACT_SOURCE_HASH,expectedPoolId:POOL_ID,expectedCellId:shareCellId,epochMs:WORK_EPOCH_MS,now:Date.now(),allowPreviousEpoch:true})
      if(!checked.ok)return checked
      if(!verify(peerKey,proofEnvelopeSigningPayload(packet),packet.signature))return {ok:false,code:'share-signature-invalid'}
      const context=await this.validateConsensusContext(checked.proof); if(!context.ok)return context
      const binding=await this.verifyShareCoinbaseBinding(checked); if(!binding.ok)return binding
      const existing=this.liveShares.get(checked.payload.shareId)
      if(!existing){const verified=await this.verifyRandomxHash(checked.proof.header80,checked.payload.powHash); if(!verified.ok)return {ok:false,code:verified.code==='randomx-hash-mismatch'?'share-randomx-hash-mismatch':verified.code}}
      return this.storeShare({...packet,share:checked.payload},{local:false})
    } finally {
      if(/^ls:[0-9a-f]{64}$/.test(rawShareId))this.pendingLocalShareIds.delete(rawShareId)
    }
  }

  sendLocalPacket(packet, targets=null) {
    const live=this.live(); if(!live)return 0
    const peerKeys=targets||live.members.map((m)=>m.peerKey)
    let n=0
    for(const peerKey of peerKeys){if(peerKey===this.peerKey||!this.transport.connected(peerKey)||!this.remotePoolPeer(peerKey))continue; if(this.transport.send(peerKey,{v:10,type:'mining-local-share',packet}))n++}
    return n
  }

  rebroadcastRecentLocalShares(){
    const live=this.live(); if(!live?.cellId)return 0
    const globalPeers=[...this.transport.peers.keys()].filter((peerKey)=>this.remotePoolPeer(peerKey))
    let sent=0
    for(const rec of this.liveShares.values()){
      const s=rec?.share
      if(!rec?.local||!s||s.contractHash!==CONTRACT_SOURCE_HASH||s.poolId!==POOL_ID||Number(s.epoch)<Number(live.epoch)-1)continue
      const targets=s.cellId===live.cellId?null:globalPeers
      sent += this.sendLocalPacket({proofMode:rec.proofMode,share:rec.share,proof:rec.proof,signature:rec.signature},targets)
    }
    return sent
  }

  async handleNative(message) {
    if(message?.kind==='status'){this.workerState={...this.workerState,...message.status}; return}
    if(message?.kind==='log'){if(message.message)warn('native:',message.message); return}
    if(message?.kind!=='share')return
    const raw=message.candidate, now=Math.max(1,Math.floor(Number(raw?.foundAt)||Date.now())), live=this.live(now)
    if(!live?.cellId||!this.currentJob||raw.jobId!==this.currentJob.id||String(raw.templateHash).toLowerCase()!==this.lastTemplateHash)return
    const built=buildRandomxLocalShare({contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID,cellId:live.cellId,epoch:live.epoch,minerPeerId:this.peerKey,payoutAddress:this.payoutAddress,jobId:raw.jobId,nonce:raw.nonce,powHash:raw.powHash,createdAt:now,shareTarget:raw.shareTarget})
    if(!built.ok)return
    const proof={header80:String(raw.header80||'').toLowerCase(),networkTarget:String(raw.networkTarget||'').toLowerCase(),shareTarget:String(raw.shareTarget||'').toLowerCase(),previousBlockHash:String(raw.previousBlockHash||'').toLowerCase(),templateHash:String(raw.templateHash||'').toLowerCase(),height:Math.max(1,Math.floor(Number(raw.height)||0)),difficultyMultiplier:Math.max(1,Math.floor(Number(raw.difficultyMultiplier)||RANDOMX_SHARE_DIFFICULTY_MULTIPLIER)),blockCandidate:raw.blockCandidate===true,jobCommitmentHash:String(raw.jobCommitmentHash||'').toLowerCase(),feePolicyHash:String(raw.feePolicyHash||'').toLowerCase(),pplnsTipId:String(raw.pplnsTipId||''),coinbaseValue:String(raw.coinbaseValue||''),coinbaseNoWitnessHex:String(raw.coinbaseNoWitnessHex||'').toLowerCase(),coinbaseMerkleBranch:Array.isArray(raw.coinbaseMerkleBranch)?raw.coinbaseMerkleBranch.map(String):[]}
    const unsigned={proofMode:RANDOMX_PROOF_MODE,share:built.share,proof}
    const checked=validateRandomxEnvelope({...unsigned,signature:'pending'},{expectedPeerId:this.peerKey,expectedPayoutAddress:this.payoutAddress,expectedContractHash:CONTRACT_SOURCE_HASH,expectedPoolId:POOL_ID,expectedCellId:live.cellId,epochMs:WORK_EPOCH_MS,now,allowPreviousEpoch:true})
    if(!checked.ok)return
    const binding=await this.verifyShareCoinbaseBinding(checked); if(!binding.ok){warn('local share coinbase binding rejected',binding.code);return}
    const packet={...unsigned,signature:sign(this.seed,proofEnvelopeSigningPayload(unsigned))}
    const stored=this.storeShare(packet,{local:true}); if(!stored.ok||stored.duplicate)return
    this.acceptedLocal += 1; this.sendLocalPacket(packet)
    if(proof.blockCandidate)void this.publishCandidate(raw,checked)
    if(proof.blockCandidate&&this.uiReady)log('🎯 BLOCK CANDIDATE',short(built.share.shareId,8,6),`share #${this.acceptedLocal}`)
  }

  poolShareSigningPayload(share){return {protocol:share?.protocol||'',kind:'pool-share',poolShareId:String(share?.poolShareId||''),contractHash:String(share?.contractHash||''),poolId:String(share?.poolId||''),cellId:String(share?.cellId||''),checkpointId:String(share?.checkpointId||''),previousPoolShareId:String(share?.previousPoolShareId||''),byzeHeight:Number(share?.byzeHeight||0),byzePrevBlockHash:String(share?.byzePrevBlockHash||''),work:String(share?.work||''),payoutWeights:share?.payoutWeights||{}}}
  relayTermForWorkEpoch(epoch){return Math.floor((Math.max(0,Number(epoch)||0)*WORK_EPOCH_MS)/RELAY_TERM_MS)}
  recordRemoteOutcome(kind, packet, outcome, code='') {
    const id=String(kind==='pool'?packet?.share?.poolShareId:packet?.share?.shareId||'')
    if(!id)return false
    const key=`${kind}:${id}:${outcome}`
    if(this.remoteOutcomeIds.has(key))return false
    this.remoteOutcomeIds.set(key,Date.now()); while(this.remoteOutcomeIds.size>2048)this.remoteOutcomeIds.delete(this.remoteOutcomeIds.keys().next().value)
    if(outcome==='accepted'){if(kind==='pool')this.acceptedRemotePoolShares++;else this.acceptedRemote++}
    else if(outcome==='stale')this.droppedStaleRemote++
    else if(outcome==='rejected'){if(kind==='pool')this.rejectedRemotePoolShares++;else this.rejectedRemote++}
    if(outcome!=='accepted'){this.lastRemoteRejectCode=String(code||outcome);this.lastRemoteRejectShareId=id}
    return true
  }
  cachePoolPacket(packet){const id=String(packet?.share?.poolShareId||''); if(!/^ps:[0-9a-f]{64}$/.test(id))return; this.poolPackets.delete(id); this.poolPackets.set(id,clone(packet)); while(this.poolPackets.size>MAX_POOL_PACKET_CACHE)this.poolPackets.delete(this.poolPackets.keys().next().value)}
  cacheCellCheckpointPacket(packet){
    const id=String(packet?.checkpoint?.checkpointId||'')
    if(!/^cp:[0-9a-f]{64}$/.test(id))return false
    this.cellCheckpointPackets.delete(id)
    this.cellCheckpointPackets.set(id,clone(packet))
    while(this.cellCheckpointPackets.size>MAX_CELL_CHECKPOINT_CACHE)this.cellCheckpointPackets.delete(this.cellCheckpointPackets.keys().next().value)
    return true
  }

  sendPoolPacket(packet, targets=null){
    const keys=targets||[...this.transport.peers.keys()].filter(k=>this.remotePoolPeer(k))
    let sent=false
    for(const peer of keys)if(this.transport.send(peer,{v:12,type:'mining-pool-share-inventory',id:packet?.share?.poolShareId}))sent=true
    return sent
  }
  sendCellCheckpointPacket(packet, targets=null){
    const split=splitCellCheckpointPacket(packet)
    if(!split.ok){warn('CellCheckpoint cannot be broadcast',split.code);return false}
    const keys=targets||[...this.transport.peers.keys()].filter(k=>this.remotePoolPeer(k))
    let sent=false
    for(const chunk of split.packets)for(const k of keys)if(this.transport.send(k,{v:12,type:'mining-cell-checkpoint',packet:chunk}))sent=true
    return sent
  }
  syncPoolHistory(peerKey){
    if(!this.remotePoolPeer(peerKey))return
    const packet=this.poolPackets.get(this.poolChain.bestId)
    if(packet)this.sendPoolPacket(packet,[peerKey])
  }

  precheckRelay(packet,checkpoint,proofs,signer,previousPoolShareId,{historical=false}={}){
    if(!checkpoint)return {ok:false,code:'relay-checkpoint-invalid'}
    if(!Array.isArray(proofs)||!proofs.length||proofs.length>MAX_POOLSHARE_PROOFS)return {ok:false,code:'relay-proof-count-invalid'}
    const contributors=[]
    for(const pp of proofs){
      const checked=validateRandomxEnvelope(pp,{expectedContractHash:checkpoint.contractHash,expectedPoolId:checkpoint.poolId,now:Date.now(),epochMs:WORK_EPOCH_MS,maxAgeMs:historical?MAX_HISTORY_AGE_MS:180000,aggregate:true})
      if(!checked.ok)return checked
      if(checked.payload.epoch!==checkpoint.epoch||String(checked.proof.pplnsTipId||'')!==String(previousPoolShareId||'')||!verify(checked.payload.minerPeerId,proofEnvelopeSigningPayload(pp),pp.signature))return {ok:false,code:'relay-proof-signature-invalid'}
      contributors.push(checked.payload.minerPeerId)
    }
    const relay=electCellRelays({members:[...new Set(contributors)],cellId:checkpoint.cellId,epoch:this.relayTermForWorkEpoch(checkpoint.epoch),seed:membershipSeed({contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID}),backups:RELAY_BACKUPS})
    return relay?.ok&&[relay.primary,...relay.backups].includes(signer)?{ok:true}:{ok:false,code:'relay-unauthorized'}
  }

  async verifyCellProof(pp,{contractHash,poolId,cellId,epoch,previousPoolShareId,historical=false}){
    if(pp?.proofMode!==RANDOMX_PROOF_MODE||!pp.share||!pp.proof||!pp.signature)return {ok:false,code:'cell-checkpoint-proof-invalid'}
    const rs=pp.share
    const checked=validateRandomxEnvelope(pp,{expectedPeerId:rs.minerPeerId,expectedPayoutAddress:rs.payoutAddress,expectedContractHash:contractHash,expectedPoolId:poolId,expectedCellId:cellId,epochMs:WORK_EPOCH_MS,now:Date.now(),allowPreviousEpoch:true,aggregate:true,maxAgeMs:historical?MAX_HISTORY_AGE_MS:180000})
    if(!checked.ok||Number(checked.payload.epoch)!==Number(epoch))return {ok:false,code:checked.code||'cell-checkpoint-proof-invalid'}
    if(!verify(String(checked.payload.minerPeerId).toLowerCase(),proofEnvelopeSigningPayload(pp),pp.signature))return {ok:false,code:'cell-checkpoint-proof-signature-invalid'}
    const context=await this.validateConsensusContext(checked.proof,{historical}); if(!context.ok)return context
    const binding=await this.verifyShareCoinbaseBinding(checked,{expectedPplnsTipId:String(previousPoolShareId||'')}); if(!binding.ok)return binding
    const cached=this.liveShares.get(checked.payload.shareId)
    const same=cached?.proofMode===RANDOMX_PROOF_MODE&&cached?.signature===pp.signature&&JSON.stringify(cached?.proof||{})===JSON.stringify(checked.proof||{})
    if(!same){
      const verifiedHash=await this.verifyRandomxHash(checked.proof.header80,checked.payload.powHash)
      if(!verifiedHash.ok)return {ok:false,code:verifiedHash.code==='randomx-hash-mismatch'?'cell-checkpoint-randomx-invalid':verifiedHash.code}
    }
    return {ok:true,payload:checked.payload}
  }

  async verifyCellCheckpointPacket(packet){
    const shape=validateCellCheckpointPacketShape(packet); if(!shape.ok)return shape
    const checkpoint=shape.checkpoint, signer=shape.signerPeerKey
    if(checkpoint.contractHash!==CONTRACT_SOURCE_HASH||checkpoint.poolId!==POOL_ID)return {ok:false,code:'cell-checkpoint-contract-mismatch'}
    if(!verify(signer,shape.signingPayload,packet.signature))return {ok:false,code:'cell-checkpoint-signature-invalid'}
    if(shape.previousPoolShareId&&!this.poolChain.byId.has(shape.previousPoolShareId))return {ok:false,code:'pplns-context-unknown',missingTip:shape.previousPoolShareId}
    const authorized=this.precheckRelay(packet,checkpoint,shape.proofs,signer,shape.previousPoolShareId);if(!authorized.ok)return authorized
    const verified=[]
    for(const pp of shape.proofs){
      const result=await this.verifyCellProof(pp,{contractHash:checkpoint.contractHash,poolId:checkpoint.poolId,cellId:checkpoint.cellId,epoch:checkpoint.epoch,previousPoolShareId:shape.previousPoolShareId})
      if(!result.ok)return result
      verified.push(result.payload)
    }
    const rebuilt=randomxCheckpoint({contractHash:checkpoint.contractHash,poolId:checkpoint.poolId,cellId:checkpoint.cellId,epoch:Number(checkpoint.epoch||0),shares:verified})
    if(!rebuilt.ok||rebuilt.checkpoint.checkpointId!==checkpoint.checkpointId||String(rebuilt.checkpoint.totalWork)!==String(checkpoint.totalWork)||JSON.stringify(rebuilt.checkpoint.workByPayout)!==JSON.stringify(checkpoint.workByPayout||{}))return {ok:false,code:'cell-checkpoint-proof-mismatch'}
    const contributors=[...new Set(verified.map(x=>String(x.minerPeerId).toLowerCase()).filter(validPeerKey))]
    const relay=electCellRelays({members:contributors,cellId:checkpoint.cellId,epoch:this.relayTermForWorkEpoch(checkpoint.epoch),seed:membershipSeed({contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID}),backups:RELAY_BACKUPS})
    if(!relay?.ok||![relay.primary,...relay.backups].includes(signer))return {ok:false,code:'cell-checkpoint-relay-unauthorized'}
    return {ok:true,checkpoint:rebuilt.checkpoint,proofs:shape.proofs,contributors,signerPeerKey:signer,previousPoolShareId:shape.previousPoolShareId}
  }

  async acceptCellCheckpoint(peerKey,packet){
    if(!this.remotePoolPeer(peerKey)||!packet?.checkpoint)return {ok:false,code:'cell-checkpoint-unauthorized'}
    const id=String(packet.checkpoint.checkpointId||'')
    if(this.cellCheckpointPackets.has(id))return {ok:true,duplicate:true}
    const verified=await this.verifyCellCheckpointPacket(packet); if(!verified.ok)return verified
    const normalized={checkpoint:clone(verified.checkpoint),previousPoolShareId:verified.previousPoolShareId,proofs:clone(verified.proofs),signerPeerKey:verified.signerPeerKey,signature:String(packet.signature||'')}
    this.cacheCellCheckpointPacket(normalized)
    this.sendCellCheckpointPacket(normalized)
    return {ok:true,checkpoint:verified.checkpoint}
  }

  async verifyPoolProofBundle(packet,{historical=false}={}){
    const share=packet?.share,checkpoint=packet?.checkpoint,proofs=Array.isArray(packet?.proofs)?packet.proofs:[]
    if(!share||!checkpoint||checkpoint.checkpointId!==share.checkpointId||checkpoint.contractHash!==share.contractHash||checkpoint.poolId!==share.poolId||checkpoint.cellId!==share.cellId)return {ok:false,code:'poolshare-checkpoint-invalid'}
    if(!proofs.length||proofs.length>MAX_POOLSHARE_PROOFS)return {ok:false,code:'poolshare-proof-count-invalid'}
    const previousPoolShareId=String(share.previousPoolShareId||'')
    const verified=[]
    const groups=new Map()
    for(const pp of proofs){
      const cellId=String(pp?.share?.cellId||'')
      const result=await this.verifyCellProof(pp,{contractHash:share.contractHash,poolId:share.poolId,cellId,epoch:Number(checkpoint.epoch||0),previousPoolShareId,historical})
      if(!result.ok)return {ok:false,code:result.code||'poolshare-proof-invalid',missingTip:result.missingTip}
      verified.push(result.payload)
      if(!groups.has(cellId))groups.set(cellId,[])
      groups.get(cellId).push(result.payload)
    }

    let rebuiltCheckpoint
    if(checkpoint.kind==='global-epoch-checkpoint'){
      const cellCheckpoints=[]
      for(const [cellId,rows] of [...groups.entries()].sort(([a],[b])=>a.localeCompare(b))){
        const rebuilt=randomxCheckpoint({contractHash:share.contractHash,poolId:share.poolId,cellId,epoch:Number(checkpoint.epoch||0),shares:rows})
        if(!rebuilt.ok)return {ok:false,code:'poolshare-cell-proof-mismatch'}
        cellCheckpoints.push(rebuilt.checkpoint)
      }
      const global=buildGlobalEpochCheckpoint({contractHash:share.contractHash,poolId:share.poolId,epoch:Number(checkpoint.epoch||0),cellCheckpoints})
      if(!global.ok)return global
      rebuiltCheckpoint=global.checkpoint
    } else {
      const cellId=share.cellId
      const rows=groups.get(cellId)||[]
      const rebuilt=randomxCheckpoint({contractHash:share.contractHash,poolId:share.poolId,cellId,epoch:Number(checkpoint.epoch||0),shares:rows})
      if(!rebuilt.ok)return {ok:false,code:'poolshare-proof-mismatch'}
      rebuiltCheckpoint=rebuilt.checkpoint
    }
    if(rebuiltCheckpoint.checkpointId!==checkpoint.checkpointId||String(rebuiltCheckpoint.totalWork)!==String(share.work)||JSON.stringify(rebuiltCheckpoint.workByPayout)!==JSON.stringify(share.payoutWeights||{}))return {ok:false,code:'poolshare-proof-mismatch'}
    if(checkpoint.kind==='global-epoch-checkpoint'&&JSON.stringify(rebuiltCheckpoint.checkpointIds)!==JSON.stringify(checkpoint.checkpointIds||[]))return {ok:false,code:'poolshare-global-checkpoint-mismatch'}
    const anchor=poolAnchor(proofs)
    if(!anchor||share.byzeHeight!==anchor.height||share.byzePrevBlockHash!==anchor.previousBlockHash)return {ok:false,code:'poolshare-anchor-mismatch'}
    const rebuiltShare=buildPoolShare({checkpoint:rebuiltCheckpoint,previousPoolShareId,byzeHeight:anchor.height,byzePrevBlockHash:anchor.previousBlockHash})
    if(!rebuiltShare.ok||rebuiltShare.poolShare.poolShareId!==share.poolShareId)return {ok:false,code:'poolshare-id-mismatch'}
    return {ok:true,checkpoint:rebuiltCheckpoint,minerPeerIds:[...new Set(verified.map(x=>String(x.minerPeerId).toLowerCase()).filter(validPeerKey))]}
  }

  async acceptPoolShare(peerKey,packet){
    if(!this.remotePoolPeer(peerKey)||!packet?.share)return {ok:false,code:'poolshare-unauthorized'}
    const share=packet.share, id=String(share.poolShareId||''), signer=String(packet.signerPeerKey||peerKey).toLowerCase()
    if(/^ps:[0-9a-f]{64}$/.test(id)){
      if(this.poolChain.byId.has(id)||this.poolChain.orphans.has(id)||this.poolPackets.has(id))return {ok:true,duplicate:true}
      if(this.pendingPoolShareIds.has(id))return {ok:true,duplicate:true,pending:true}
      this.pendingPoolShareIds.add(id)
    }
    try{
      if(share.contractHash!==CONTRACT_SOURCE_HASH||share.poolId!==POOL_ID||!validPeerKey(signer)||!verify(signer,this.poolShareSigningPayload(share),packet.signature))return {ok:false,code:'poolshare-signature-invalid'}
      const historical=this.history.isRequested(peerKey,id)
      const authorized=this.precheckRelay(packet,packet.checkpoint,packet.proofs,signer,share.previousPoolShareId,{historical});if(!authorized.ok)return authorized
      const proof=await this.verifyPoolProofBundle(packet,{historical}); if(!proof.ok)return proof
      const relay=electCellRelays({members:proof.minerPeerIds,cellId:share.cellId,epoch:this.relayTermForWorkEpoch(proof.checkpoint.epoch),seed:membershipSeed({contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID}),backups:RELAY_BACKUPS})
      if(!relay?.ok||![relay.primary,...relay.backups].includes(signer))return {ok:false,code:'poolshare-relay-unauthorized'}
      const normalized={...clone(packet),signerPeerKey:signer}
      const added=this.poolChain.add(share,{signerPeerKey:signer,receivedAt:Date.now(),checkpointEpoch:proof.checkpoint.epoch}); if(!added.ok)return added
      this.cachePoolPacket(normalized)
      if(added.orphan){this.requestMissingPplnsTip(peerKey,{missingTip:added.missingParent}); return {ok:true,orphan:true}}
      if(added.bestChanged){
        if(added.reorg&&this.uiReady)log('↻ PPLNS reorg',short(added.oldBestId,8,6),'→',short(added.bestId,8,6))
        setImmediate(()=>void this.refreshJob(true).catch(e=>warn('PPLNS refresh:',e.message)))
      }
      if(!added.duplicate&&!historical)this.sendPoolPacket(normalized)
      return {ok:true,duplicate:!!added.duplicate,bestChanged:!!added.bestChanged,reorg:!!added.reorg}
    } finally {
      if(/^ps:[0-9a-f]{64}$/.test(id))this.pendingPoolShareIds.delete(id)
    }
  }

  closedEpochProofGroups(epoch,expectedTipId){
    const groups=new Map()
    for(const r of this.liveShares.values()){
      if(r?.proofMode!==RANDOMX_PROOF_MODE||r.share?.contractHash!==CONTRACT_SOURCE_HASH||r.share?.poolId!==POOL_ID||Number(r.share?.epoch)!==Number(epoch)||String(r.proof?.pplnsTipId||'')!==String(expectedTipId||''))continue
      const cellId=String(r.share.cellId||'')
      if(!cellId)continue
      if(!groups.has(cellId))groups.set(cellId,[])
      groups.get(cellId).push({proofMode:RANDOMX_PROOF_MODE,share:clone(r.share),proof:clone(r.proof),signature:r.signature})
    }
    for(const rows of groups.values())rows.sort((a,b)=>String(a.share.shareId).localeCompare(String(b.share.shareId)))
    return groups
  }

  maybePublishCellCheckpoints(){
    const now=Date.now(),currentEpoch=Math.floor(now/WORK_EPOCH_MS),closed=currentEpoch-1
    if(closed<0||this.deferredLocalShares.size||this.deferredPoolShares.size)return 0
    const previousPoolShareId=this.poolChain.tipBeforeEpoch(closed)
    const groups=this.closedEpochProofGroups(closed,previousPoolShareId)
    const elapsed=Math.max(0,now-currentEpoch*WORK_EPOCH_MS)
    let published=0
    for(const [cellId,proofs] of groups){
      if(!proofs.length||proofs.length>MAX_CELL_CHECKPOINT_PROOFS)continue
      const rebuilt=randomxCheckpoint({contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID,cellId,epoch:closed,shares:proofs.map(p=>p.share)})
      if(!rebuilt.ok||BigInt(rebuilt.checkpoint.totalWork||0)<=0n||proofs.length!==Number(rebuilt.checkpoint.shareCount||0))continue
      const contributors=[...new Set(proofs.map(p=>String(p.share.minerPeerId).toLowerCase()).filter(validPeerKey))]
      const relay=electCellRelays({members:contributors,cellId,epoch:this.relayTermForWorkEpoch(closed),seed:membershipSeed({contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID}),backups:RELAY_BACKUPS})
      if(!relay?.ok)continue
      const order=[relay.primary,...relay.backups],idx=order.indexOf(this.peerKey)
      if(idx<0||elapsed<idx*RELAY_FAILOVER_GRACE_MS)continue
      const unsigned={checkpoint:rebuilt.checkpoint,previousPoolShareId,proofs,signerPeerKey:this.peerKey}
      const signature=sign(this.seed,cellCheckpointSigningPayload(unsigned))
      const packet={...unsigned,signature}
      const key=`${rebuilt.checkpoint.checkpointId}:${this.peerKey}`
      if(this.publishedCellCheckpoints.has(key))continue
      this.publishedCellCheckpoints.set(key,now)
      while(this.publishedCellCheckpoints.size>1024)this.publishedCellCheckpoints.delete(this.publishedCellCheckpoints.keys().next().value)
      this.cacheCellCheckpointPacket(packet)
      this.sendCellCheckpointPacket(packet)
      published++
    }
    return published
  }

  globalCellCandidates(epoch,previousPoolShareId){
    const byCell=new Map()
    for(const packet of this.cellCheckpointPackets.values()){
      const cp=packet?.checkpoint
      if(!cp||Number(cp.epoch)!==Number(epoch)||String(packet.previousPoolShareId||'')!==String(previousPoolShareId||''))continue
      const prior=byCell.get(cp.cellId)
      const work=BigInt(String(cp.totalWork||0)),priorWork=prior?BigInt(String(prior.checkpoint.totalWork||0)):0n
      if(!prior||work>priorWork||(work===priorWork&&String(cp.checkpointId).localeCompare(String(prior.checkpoint.checkpointId))<0))byCell.set(cp.cellId,packet)
    }
    return [...byCell.values()].sort((a,b)=>String(a.checkpoint.cellId).localeCompare(String(b.checkpoint.cellId)))
  }

  async maybePromotePoolShare(){
    this.maybePublishCellCheckpoints()
    const now=Date.now(),currentEpoch=Math.floor(now/WORK_EPOCH_MS),closed=currentEpoch-1
    if(closed<0||this.deferredLocalShares.size||this.deferredPoolShares.size)return
    const previousPoolShareId=this.poolChain.tipBeforeEpoch(closed)
    const cellPackets=this.globalCellCandidates(closed,previousPoolShareId)
    if(!cellPackets.length)return
    const global=buildGlobalEpochCheckpoint({contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID,epoch:closed,cellCheckpoints:cellPackets.map(p=>p.checkpoint)})
    if(!global.ok)return
    const proofs=[],seen=new Set()
    for(const packet of cellPackets)for(const pp of packet.proofs||[]){
      const id=String(pp?.share?.shareId||'')
      if(!id||seen.has(id))continue
      seen.add(id); proofs.push(clone(pp))
    }
    proofs.sort((a,b)=>String(a.share.shareId).localeCompare(String(b.share.shareId)))
    if(!proofs.length||proofs.length>MAX_POOLSHARE_PROOFS)return
    const contributors=[...new Set(proofs.map(p=>String(p.share.minerPeerId).toLowerCase()).filter(validPeerKey))]
    const relay=electCellRelays({members:contributors,cellId:global.checkpoint.cellId,epoch:this.relayTermForWorkEpoch(closed),seed:membershipSeed({contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID}),backups:RELAY_BACKUPS})
    if(!relay?.ok)return
    const order=[relay.primary,...relay.backups],idx=order.indexOf(this.peerKey)
    if(idx<0)return
    const elapsed=Math.max(0,now-currentEpoch*WORK_EPOCH_MS)
    if(elapsed<GLOBAL_AGGREGATION_GRACE_MS+idx*RELAY_FAILOVER_GRACE_MS)return
    const anchor=poolAnchor(proofs);if(!anchor)return
    for(const pp of proofs)if(!(await this.validateConsensusContext(pp.proof)).ok)return
    const tip=anchor.previousBlockHash,height=anchor.height
    const built=buildPoolShare({checkpoint:global.checkpoint,previousPoolShareId,byzeHeight:height,byzePrevBlockHash:tip}); if(!built.ok)return
    if(this.poolChain.byId.has(built.poolShare.poolShareId))return
    const mark=`${closed}:${global.checkpoint.checkpointId}:${this.peerKey}`
    if(this.promotedEpochs.has(mark))return
    const signature=sign(this.seed,this.poolShareSigningPayload(built.poolShare))
    const added=this.poolChain.add(built.poolShare,{local:true,signerPeerKey:this.peerKey,receivedAt:now,checkpointEpoch:closed}); if(!added.ok)return
    if(added.bestChanged)setImmediate(()=>void this.refreshJob(true).catch(e=>warn('PPLNS refresh:',e.message)))
    this.promotedEpochs.set(mark,built.poolShare.poolShareId)
    while(this.promotedEpochs.size>1024)this.promotedEpochs.delete(this.promotedEpochs.keys().next().value)
    const packet={share:built.poolShare,checkpoint:clone(global.checkpoint),proofs,signature,signerPeerKey:this.peerKey}; this.cachePoolPacket(packet); this.sendPoolPacket(packet)
  }

  async directPayoutScript(address,state=null){
    const checked = await this.payoutValidator.validate(address)
    if(state&&!checked.ok&&TRANSIENT_PAYOUT_CODES.has(checked.code))state.transient=checked.code
    return checked.ok ? {scriptPubKey:checked.scriptPubKey} : null
  }
  payoutForTip(reward,tipId,payoutAddress){
    const value=BigInt(String(reward||0))
    if(tipId)return this.poolChain.payoutPlanAt(tipId,value,400,this.policy)
    return calculateDirectPayouts({poolShares:[{kind:'pool-share',poolShareId:'ps:'+ '0'.repeat(64),work:'1',payoutWeights:{[payoutAddress]:'1'}}],rewardSatoshis:value,maxOutputs:400,feeAddress:this.policy.feeAddress,feeBasisPoints:this.policy.feeBasisPoints})
  }
  async buildDirectPlan(reward,{tipId=this.poolChain.bestId||'',payoutAddress=this.payoutAddress}={}){
    const payout=this.payoutForTip(reward,tipId,payoutAddress); if(!payout?.ok)return {ok:false,code:payout?.code||'payout-unavailable'}
    const normalized=normalizeDirectCoinbasePlan(payout.outputs,BigInt(String(reward||0)),400); if(!normalized.ok)return normalized
    const state={transient:null}
    const resolved=await resolveDirectCoinbaseScripts(normalized,(a)=>this.directPayoutScript(a,state))
    if(!resolved.ok&&state.transient)return {ok:false,code:state.transient}
    return resolved.ok?{...resolved,feeSatoshis:payout.feeSatoshis,minerSatoshis:payout.minerSatoshis,pplnsTipId:String(tipId||'')}:resolved
  }
  async expectedCommitmentForProof(proof,payoutAddress,cellId,shareEpoch=null,options={}){
    if(String(proof?.feePolicyHash||'')!==this.policy.policyHash)return {ok:false,code:'fee-policy-mismatch'}
    const tip=String(proof?.pplnsTipId||'')
    if(tip&&!this.poolChain.byId.has(tip))return {ok:false,code:'pplns-context-unknown',missingTip:tip}
    const branchBound=Object.prototype.hasOwnProperty.call(options||{},'expectedPplnsTipId')
    if(shareEpoch!=null){
      const expectedTip=branchBound?String(options.expectedPplnsTipId||''):this.poolChain.tipBeforeEpoch(shareEpoch)
      if(expectedTip!==tip)return {ok:false,code:branchBound?'pplns-tip-branch-mismatch':'pplns-tip-stale-fork',expectedTip,actualTip:tip}
    }
    const plan=await this.buildDirectPlan(proof.coinbaseValue,{tipId:tip,payoutAddress})
    if(!plan.ok)return plan
    const commitment=buildJobCommitment({contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID,cellId,templateHash:proof.templateHash,feePolicyHash:this.policy.policyHash,pplnsTipId:tip,coinbaseOutputs:plan.outputs,coinbaseValue:proof.coinbaseValue})
    if(!commitment.ok)return commitment
    if(commitment.jobCommitmentHash!==proof.jobCommitmentHash)return {ok:false,code:'miningJobCommitmentMismatch'}
    return {ok:true,commitment,plan}
  }
  async verifyShareCoinbaseBinding(checked,options={}){
    // Check the share recipient even when the historical PPLNS plan does not pay it yet.
    const addressCheck = await this.payoutValidator.validate(checked.payload.payoutAddress)
    if (!addressCheck.ok) return addressCheck
    const expected=await this.expectedCommitmentForProof(checked.proof,checked.payload.payoutAddress,checked.payload.cellId,checked.payload.epoch,options); if(!expected.ok)return expected
    return verifyCoinbaseBinding({rpc:(m,p=[])=>this.byze.call(m,p,{timeout:15_000}),header80:checked.proof.header80,coinbaseNoWitnessHex:checked.proof.coinbaseNoWitnessHex,merkleBranch:checked.proof.coinbaseMerkleBranch,expectedCommitment:expected.commitment,expectedHeight:checked.proof.height})
  }

  async coinbaseForBlock(hash){
    let block=await this.byze.call('getblock',[hash,2],{timeout:15_000})
    if(!block||typeof block!=='object')return null
    const first=Array.isArray(block.tx)?block.tx[0]:null
    if(first&&typeof first==='object')return {block,tx:first}
    if(typeof first==='string'&&first){
      const tx=await this.byze.call('getrawtransaction',[first,true,hash],{timeout:15_000}).catch(()=>null)
      if(tx&&typeof tx==='object')return {block,tx}
    }
    return null
  }

  async blockRewardForMe(height){
    const hash=String(await this.byze.call('getblockhash',[height],{timeout:10_000})||'').toLowerCase()
    if(!/^[0-9a-f]{64}$/.test(hash))return null
    const data=await this.coinbaseForBlock(hash)
    if(!data?.tx)return {height,hash,satoshis:0n,time:Number(data?.block?.time||0)}
    const satoshis=sumPayoutFromVouts(data.tx.vout,this.payoutAddress,this.payoutScriptHex)
    return {height,hash,satoshis,time:Number(data.block?.time||0)}
  }

  applyRewardRecord(record){
    const prior=this.rewardBlocks.get(record.height)
    if(prior&&prior.hash===record.hash)return false
    if(prior?.satoshis>0n){this.sessionRewardSatoshis-=prior.satoshis;this.sessionRewardBlockCount=Math.max(0,this.sessionRewardBlockCount-1)}
    this.rewardBlocks.set(record.height,record)
    if(record.satoshis>0n){
      this.sessionRewardSatoshis+=record.satoshis; this.sessionRewardBlockCount++
      this.lastReward=record
      if(this.uiReady){
        const banner=rewardCelebration({amountByze:satoshisToByze(record.satoshis),height:record.height,sessionByze:satoshisToByze(this.sessionRewardSatoshis),alias:this.alias})
        console.log('\n'+color(banner,ANSI.green)+'\n')
      }
    }
    return true
  }

  async scanRewards(){
    if(this.rewardScanBusy||!this.rewardScannerSupported)return
    this.rewardScanBusy=true
    try{
      const info=await this.byze.call('getblockchaininfo',[],{timeout:10_000})
      const tip=Math.max(0,Math.floor(Number(info?.blocks)||0))
      if(!this.sessionStartHeight){this.sessionStartHeight=tip;this.lastRewardScanHeight=tip;return}
      for(const h of [...this.rewardBlocks.keys()])if(h>tip){const r=this.rewardBlocks.get(h);if(r?.satoshis>0n){this.sessionRewardSatoshis-=r.satoshis;this.sessionRewardBlockCount=Math.max(0,this.sessionRewardBlockCount-1)}this.rewardBlocks.delete(h)}
      const normalFrom=Math.max(this.sessionStartHeight+1,this.lastRewardScanHeight+1)
      const recheckFrom=Math.max(this.sessionStartHeight+1,Math.min(this.lastRewardScanHeight,tip)-2)
      const from=Math.min(normalFrom,recheckFrom)
      for(let h=from;h<=tip;h++){const r=await this.blockRewardForMe(h);if(r)this.applyRewardRecord(r)}
      this.lastRewardScanHeight=Math.max(this.sessionStartHeight,tip)
    }catch(e){
      if(/method not found|unknown command|not found/i.test(String(e?.message||e))){this.rewardScannerSupported=false;warn('reward tracking is unavailable on this byze-cli build; mining continues.')}
    }finally{this.rewardScanBusy=false}
  }

  async refreshJob(force=false){
    let raw
    try{raw=await this.byze.call('getblocktemplate',[{rules:['segwit']}],{timeout:15_000})}catch{raw=await this.byze.call('getblocktemplate',[],{timeout:15_000})}
    const sanitized=sanitizeGbtTemplate(raw); if(!sanitized.ok)throw new Error(`invalid getblocktemplate: ${sanitized.code}`)
    this.lastTemplate=clone(sanitized.template)
    const live=this.live(); if(!live?.cellId)return false
    const pplnsTipId=this.poolChain.tipBeforeEpoch(live.epoch)
    this.directPlan=await this.buildDirectPlan(sanitized.template.coinbasevalue,{tipId:pplnsTipId,payoutAddress:this.payoutAddress}).catch(e=>({ok:false,code:e.message}))
    if(!this.directPlan?.ok)throw new Error(`direct coinbase unavailable: ${this.directPlan?.code||'unknown'}`)
    let fitted = fitTemplateWeight(sanitized.template, this.directPlan.outputs)
    while (fitted.removed) {
      sanitized.template = fitted.template
      // Removing transactions removes their fees too; rebuild every payout and commitment.
      this.directPlan = await this.buildDirectPlan(sanitized.template.coinbasevalue,{tipId:pplnsTipId,payoutAddress:this.payoutAddress})
      if (!this.directPlan?.ok) throw new Error(`adjusted direct coinbase unavailable: ${this.directPlan?.code||'unknown'}`)
      fitted = fitTemplateWeight(sanitized.template, this.directPlan.outputs)
    }
    sanitized.template = fitted.template
    sanitized.template.coinbaseoutputs=this.directPlan.outputs.map(r=>({address:r.address,value:r.satoshis,script:r.script})); sanitized.template.directCoinbaseCommitment=this.directPlan.commitment; sanitized.templateHash=randomxTemplateHash(sanitized.template)
    const commitment=buildJobCommitment({contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID,cellId:live.cellId,templateHash:sanitized.templateHash,feePolicyHash:this.policy.policyHash,pplnsTipId,coinbaseOutputs:this.directPlan.outputs,coinbaseValue:sanitized.template.coinbasevalue})
    if(!commitment.ok)throw new Error(`job commitment unavailable: ${commitment.code}`)
    const id=randomxJobId({contractHash:CONTRACT_SOURCE_HASH,poolId:POOL_ID,cellId:live.cellId,templateHash:sanitized.templateHash,difficultyMultiplier:RANDOMX_SHARE_DIFFICULTY_MULTIPLIER}); if(!id)return false
    const job={id,templateHash:sanitized.templateHash,template:sanitized.template,jobCommitmentHash:commitment.jobCommitmentHash,feePolicyHash:this.policy.policyHash,pplnsTipId}
    this.jobContexts.set(id,{commitment,plan:this.directPlan,createdAt:Date.now()}); while(this.jobContexts.size>32)this.jobContexts.delete(this.jobContexts.keys().next().value)
    if(!force&&this.currentJob?.id===job.id&&this.lastTemplateHash===job.templateHash)return true
    this.supervisor.setJob(job); this.currentJob=job; this.lastTemplateHash=job.templateHash; this.lastGbtAt=Date.now()
    return true
  }

  queuePrePresence(peerKey, frame){
    peerKey=String(peerKey||'').toLowerCase()
    if(!validPeerKey(peerKey)||!this.transport?.connected(peerKey))return false
    const now=Date.now(), prior=(this.prePresenceFrames.get(peerKey)||[]).filter(x=>now-x.at<=PRE_PRESENCE_GRACE_MS)
    let total=0; for(const rows of this.prePresenceFrames.values())total+=rows.length
    if(prior.length>=MAX_PRE_PRESENCE_FRAMES_PER_PEER||total>=MAX_PRE_PRESENCE_FRAMES_TOTAL)return false
    prior.push({at:now,frame:clone(frame)})
    this.prePresenceFrames.set(peerKey,prior)
    setTimeout(()=>{
      const rows=(this.prePresenceFrames.get(peerKey)||[]).filter(x=>Date.now()-x.at<=PRE_PRESENCE_GRACE_MS)
      if(rows.length)this.prePresenceFrames.set(peerKey,rows); else this.prePresenceFrames.delete(peerKey)
    },PRE_PRESENCE_GRACE_MS+50).unref?.()
    return true
  }

  drainPrePresence(peerKey){
    peerKey=String(peerKey||'').toLowerCase()
    const rows=this.prePresenceFrames.get(peerKey)||[]
    this.prePresenceFrames.delete(peerKey)
    if(!rows.length)return 0
    setImmediate(async()=>{
      for(const row of rows){
        if(Date.now()-row.at>PRE_PRESENCE_GRACE_MS)continue
        await this.onFrame(peerKey,row.frame,{fromGraceQueue:true})
      }
    })
    return rows.length
  }

  requestMissingPplnsTip(peerKey,result){
    const id=String(result?.missingTip||'')
    peerKey=String(peerKey||'').toLowerCase()
    if(!/^ps:[0-9a-f]{64}$/.test(id)||!this.remotePoolPeer(peerKey))return false
    const key=`${peerKey}:${id}`,now=Date.now(),last=Number(this.missingTipRequestAt.get(key)||0)
    if(now-last<2_000)return false
    this.missingTipRequestAt.set(key,now)
    while(this.missingTipRequestAt.size>256)this.missingTipRequestAt.delete(this.missingTipRequestAt.keys().next().value)
    return this.history.request(peerKey,id)
  }

  deferContext(kind, peerKey, packet){
    const isPool=kind==='pool', id=String(isPool?packet?.share?.poolShareId:packet?.share?.shareId||'')
    const valid=isPool?/^ps:[0-9a-f]{64}$/.test(id):/^ls:[0-9a-f]{64}$/.test(id)
    if(!valid)return false
    const map=isPool?this.deferredPoolShares:this.deferredLocalShares
    const prior=map.get(id)
    map.set(id,{peerKey:String(peerKey||'').toLowerCase(),packet:clone(packet),firstSeen:prior?.firstSeen||Date.now(),retryAt:Date.now()+DEFERRED_CONTEXT_RETRY_MS})
    while(map.size>MAX_DEFERRED_CONTEXT_ITEMS)map.delete(map.keys().next().value)
    return true
  }

  async retryDeferredContext(){
    if(this.retryingDeferred)return
    this.retryingDeferred=true
    try{
      const now=Date.now()
      for(const [id,rec] of [...this.deferredLocalShares]){
        if(now<rec.retryAt)continue
        if(now-rec.firstSeen>DEFERRED_CONTEXT_TTL_MS){this.deferredLocalShares.delete(id); warn('deferred share expired',short(id,8,6)); continue}
        const r=await this.validationGate.run(rec.peerKey,()=>this.acceptLocalShare(rec.peerKey,rec.packet))
        if(r.ok){this.deferredLocalShares.delete(id); if(!r.duplicate)this.recordRemoteOutcome('local',rec.packet,'accepted'); continue}
        if(DEFERRABLE_CODES.has(r.code)){if(r.code==='pplns-context-unknown')this.requestMissingPplnsTip(rec.peerKey,r);rec.retryAt=Date.now()+DEFERRED_CONTEXT_RETRY_MS; continue}
        this.deferredLocalShares.delete(id)
        if(r.code==='pplns-tip-stale-fork'){this.recordRemoteOutcome('local',rec.packet,'stale',r.code);continue}
        this.recordRemoteOutcome('local',rec.packet,'rejected',r.code); warn('deferred share rejected',r.code)
      }
      for(const [id,rec] of [...this.deferredPoolShares]){
        if(now<rec.retryAt)continue
        if(now-rec.firstSeen>DEFERRED_CONTEXT_TTL_MS){this.deferredPoolShares.delete(id); warn('deferred PoolShare expired',short(id,8,6)); continue}
        const r=await this.validationGate.run(rec.peerKey,()=>this.acceptPoolShare(rec.peerKey,rec.packet))
        if(r.ok){this.deferredPoolShares.delete(id); if(!r.duplicate)this.recordRemoteOutcome('pool',rec.packet,'accepted'); continue}
        if(DEFERRABLE_CODES.has(r.code)){if(r.code==='pplns-context-unknown')this.requestMissingPplnsTip(rec.peerKey,r);rec.retryAt=Date.now()+DEFERRED_CONTEXT_RETRY_MS; continue}
        this.deferredPoolShares.delete(id)
        if(r.code==='pplns-tip-stale-fork'){this.recordRemoteOutcome('pool',rec.packet,'stale',r.code);continue}
        this.recordRemoteOutcome('pool',rec.packet,'rejected',r.code); warn('deferred PoolShare rejected',r.code)
      }
    }finally{this.retryingDeferred=false}
  }

  async publishCandidate(raw,checked=null){
    if(!this.submitBlocks){warn('Block candidate found but --no-submit is enabled.');return}
    if(this.deferredLocalShares.size||this.deferredPoolShares.size){warn('Block candidate held: PPLNS chain-context synchronization is in progress.');return}
    const ctx=this.jobContexts.get(String(raw?.jobId||''))
    if(!raw?.blockHex||raw.blockCandidate!==true||!raw.directCoinbaseCommitted||!ctx?.commitment||raw.directCoinbaseCommitment!==ctx.plan?.commitment||raw.jobCommitmentHash!==ctx.commitment.jobCommitmentHash){warn('Block candidate cannot be submitted: bound PPLNS coinbase is not committed.');return}
    if(checked){const binding=await verifyCoinbaseBinding({rpc:(m,p=[])=>this.byze.call(m,p,{timeout:15_000}),header80:checked.proof.header80,coinbaseNoWitnessHex:checked.proof.coinbaseNoWitnessHex,merkleBranch:checked.proof.coinbaseMerkleBranch,expectedCommitment:ctx.commitment,expectedHeight:checked.proof.height});if(!binding.ok){warn('Block candidate coinbase binding rejected:',binding.code);return}}
    const candidate={...raw,previousBlockHash:raw.previousBlockHash||this.lastTemplate?.previousblockhash||''}
    let chainInfo
    try{chainInfo=await this.byze.call('getblockchaininfo',[],{timeout:10_000})}catch(e){warn('Block candidate held: unable to confirm mainnet synchronization.');return}
    const ready=assertMainnetReady(chainInfo)
    if(!ready.ok){warn('Block candidate held:',ready.code);return}
    const result=await publishQuantumBlock({rpc:async(method,params=[])=>this.byze.call(method,params,{timeout:30_000}),candidate,allowSubmit:true,expectedNetwork:'main',validateProposal:true})
    if(result.ok){
      if(this.uiReady)log('🔥 BYZE BLOCK SUBMITTED',`#${raw.height}`,short(raw.powHash,10,8))
      setTimeout(()=>void this.scanRewards(),800)
    } else warn('Block not submitted:',result.code||'',result.reason||'')
    setTimeout(()=>this.refreshJob(true).catch(()=>{}),500)
  }

  async onFrame(peerKey,frame,{fromGraceQueue=false,requestedHistory=false}={}){
    try{
      if(frame.type==='mining-presence'){
        const r=await this.presenceGate.run(peerKey,()=>this.acceptPresence(peerKey,frame.announcement))
        if(r.ok&&!r.ignored){
          if(r.left) log('peer left',short(peerKey,10,6),r.payload?.alias||'')
          else if(r.firstSeen){if(this.uiReady)log('➕ miner joined the pool',r.payload?.alias||short(peerKey,10,6)); this.rebroadcastRecentLocalShares(); this.drainPrePresence(peerKey)}
        }
        return
      }
      if(!fromGraceQueue&&!this.remotePoolPeer(peerKey)&&['mining-local-share','mining-cell-checkpoint','mining-pool-share'].includes(frame.type)){
        if(this.queuePrePresence(peerKey,frame))return
      }
      if(!this.remotePoolPeer(peerKey))return
      if(frame.type==='mining-local-share'){
        if(frame.packet?.proofMode===COORDINATION_PROOF_MODE){this.compatIgnoredRemote++; return}
        const r=await this.validationGate.run(peerKey,()=>this.acceptLocalShare(peerKey,frame.packet))
        if(r.ok&&!r.duplicate)this.recordRemoteOutcome('local',frame.packet,'accepted')
        else if(!r.ok&&DEFERRABLE_CODES.has(r.code)){if(r.code==='pplns-context-unknown')this.requestMissingPplnsTip(peerKey,r);this.deferContext('local',peerKey,frame.packet)}
        else if(!r.ok&&['peer-validation-overloaded','peer-validation-queue-timeout'].includes(r.code))return
        else if(!r.ok&&r.code==='pplns-tip-stale-fork')this.recordRemoteOutcome('local',frame.packet,'stale',r.code)
        else if(!r.ok){this.recordRemoteOutcome('local',frame.packet,'rejected',r.code);warn('Remote share rejected',r.code,short(frame.packet?.share?.shareId,8,6))}
        return
      }
      if(frame.type==='mining-cell-checkpoint'){
        const assembled=this.cellAssembler.add(frame.packet,peerKey)
        if(!assembled.ok){warn('CellCheckpoint chunk rejected',assembled.code);return}
        if(!assembled.complete)return
        const r=await this.validationGate.run(peerKey,()=>this.acceptCellCheckpoint(peerKey,assembled.packet))
        if(!r.ok&&['peer-validation-overloaded','peer-validation-queue-timeout'].includes(r.code))return
        if(!r.ok&&r.code==='pplns-context-unknown')this.requestMissingPplnsTip(peerKey,r)
        else if(!r.ok)warn('CellCheckpoint rejected',r.code)
        return
      }
      if(frame.type==='mining-pool-share'){
        if(!requestedHistory)return
        const assembled={ok:true,complete:true,packet:frame.packet}; if(!assembled.ok)return; if(!assembled.complete)return
        const r=await this.validationGate.run(peerKey,()=>this.acceptPoolShare(peerKey,assembled.packet))
        if(r.ok&&!r.duplicate)this.recordRemoteOutcome('pool',assembled.packet,'accepted')
        else if(!r.ok&&DEFERRABLE_CODES.has(r.code)){if(r.code==='pplns-context-unknown')this.requestMissingPplnsTip(peerKey,r);this.deferContext('pool',peerKey,assembled.packet); return}
        else if(!r.ok&&['peer-validation-overloaded','peer-validation-queue-timeout'].includes(r.code))return
        else if(!r.ok&&r.code==='pplns-tip-stale-fork')this.recordRemoteOutcome('pool',assembled.packet,'stale',r.code)
        else if(!r.ok){this.recordRemoteOutcome('pool',assembled.packet,'rejected',r.code);warn('PoolShare rejected',r.code)}
        return
      }
      if(frame.type==='mining-pool-share-inventory'){this.history.request(peerKey,String(frame.id||''));return}
      if(frame.type==='mining-pool-share-page'){await this.history.accept(peerKey,frame);return}
      if(frame.type==='mining-pool-share-request'){
        if(!this.remotePoolPeer(peerKey))return
        this.history.serve(peerKey,frame);return
      }
    }catch(e){warn('P2P frame:',e.code||e.message||e)}
  }

  stats(){
    if(!this.uiReady)return
    const live=this.live(),chain=this.poolChain.snapshot(),poolMembers=this.members()
    const poolHps=poolMembers.filter(m=>String(m.miningState).toUpperCase()==='MINING'&&m.hashrateObservedAt&&Date.now()-m.hashrateObservedAt<=20_000).reduce((sum,m)=>sum+Math.max(0,Number(m.hashrateHps)||0),0)
    const pendingCtx=this.deferredLocalShares.size+this.deferredPoolShares.size
    const line=statusLine({
      time:localClock(),
      localHashrate:formatHps(this.workerState.hashrate),
      minerCount:poolMembers.length,
      poolHashrate:`~${formatHps(poolHps)}`,
      localShares:this.acceptedLocal,
      remoteAccepted:this.acceptedRemote,
      remotePending:pendingCtx,
      remoteRejected:this.rejectedRemote,
      droppedStale:this.droppedStaleRemote,
      forkCount:chain.forkCount,
      reorgCount:chain.reorgCount,
      sessionByze:satoshisToByze(this.sessionRewardSatoshis),
      lastRejectCode:this.lastRemoteRejectCode
    })
    console.log(color(line,ANSI.cyan))
  }

  async start(){
    setNativeMessageHandler((m)=>void this.handleNative(m))
    const topic=this.discoveryTopic()
    this.transport=new P2PTransport({bootstrap:this.bootstrap,seed:this.seed,alias:this.alias,topicHex:topic,onFrame:(k,f)=>void this.onFrame(k,f),onPeerChange:(k,on)=>{if(on)setTimeout(()=>{this.broadcastPresence(); this.rebroadcastRecentLocalShares()},80)}})
    this.peerKey=this.transport.peerKey
    const selfTest=this.selfPresence(); if(!verify(this.peerKey,presenceSigningPayload(selfTest),selfTest.signature))throw new Error('The temporary P2P key does not match the signing key.')
    this.history.start()
    await this.transport.start()
    const status=await this.supervisor.configure({instanceId:this.instanceId,payoutAddress:this.payoutAddress,threads:this.threads,workerTag:`cli-${this.alias}`,difficultyMultiplier:RANDOMX_SHARE_DIFFICULTY_MULTIPLIER})
    this.workerState={...this.workerState,...status}
    if(!status.minerAvailable)throw new Error('Managed byze-p2pool-miner not found or failed integrity verification.')
    if(!status.verifierAvailable)throw new Error('Managed byze-rxhash not found or failed integrity verification.')
    if(!status.directCoinbaseSupported)throw new Error('Incompatible managed miner: contract-direct-coinbase-v2 is required.')
    try{
      const info=await this.byze.call('getblockchaininfo',[],{timeout:10_000})
      this.sessionStartHeight=Math.max(0,Math.floor(Number(info?.blocks)||0)); this.lastRewardScanHeight=this.sessionStartHeight
      const rewardScript=await this.directPayoutScript(this.payoutAddress)
      this.payoutScriptHex=String(rewardScript?.scriptPubKey||'').toLowerCase()
    }catch{}
    await this.refreshJob(true)
    this.running=true; this.broadcastPresence()
    this.timers.push(setInterval(()=>this.broadcastPresence(),PRESENCE_HEARTBEAT_MS))
    this.timers.push(setInterval(()=>void this.refreshJob().catch(e=>warn('GBT:',e.message)),10_000))
    this.timers.push(setInterval(()=>void this.maybePromotePoolShare().catch(e=>warn('PoolShare:',e.message)),1_500))
    this.timers.push(setInterval(()=>this.rebroadcastRecentLocalShares(),5_000))
    this.timers.push(setInterval(()=>this.pruneShares(),10_000))
    this.timers.push(setInterval(()=>{for(const peer of this.transport.peers.keys())this.syncPoolHistory(peer)},20_000))
    this.timers.push(setInterval(()=>void this.retryDeferredContext(),DEFERRED_CONTEXT_RETRY_MS))
    this.timers.push(setInterval(()=>void this.scanRewards(),5_000))
    this.timers.push(setInterval(()=>this.stats(),10_000))
    for(const t of this.timers)t.unref?.()
    let chainInfo={}
    try{chainInfo=await this.byze.call('getblockchaininfo',[],{timeout:10_000})||{}}catch{}
    const intro=launchPresentation({
      version:APP_VERSION,
      alias:this.alias,
      peerKey:short(this.peerKey,14,10),
      wallet:short(this.payoutAddress,18,12),
      poolId:POOL_ID,
      feeBasisPoints:this.policy.feeBasisPoints,
      threads:this.threads,
      nodeChain:chainInfo.chain||'?',
      nodeHeight:chainInfo.blocks||this.currentJob?.template?.height||0,
      topic:short(topic,18,12)
    })
    this.uiReady=true
    console.log('\n'+color(intro,ANSI.bold+ANSI.cyan)+'\n')
    this.stats()
  }

  async stop(){
    if(!this.running&& !this.transport)return
    this.history.stop()
    this.running=false
    for(const t of this.timers)clearInterval(t); this.timers=[]
    try{this.broadcastPresence('LEFT'); await sleep(150)}catch{}
    try{this.supervisor.stop()}catch{}
    try{await this.transport?.close()}catch{}
    this.seed.fill(0)
    log('clean shutdown; temporary P2P identity destroyed.')
  }
}

async function interactiveOptions(args){
  const rl=readline.createInterface({input:stdin,output:stdout})
  try{
    if(!args.alias)args.alias=await rl.question('Miner alias: ')
    if(!args.wallet)args.wallet=await rl.question('BYZE payout address: ')
    if(!args.threads){const def=Math.max(1,Math.min(4,Number(os.availableParallelism?.()||os.cpus().length||1))); args.threads=await rl.question(`Number of threads [${def}] : `)||String(def)}
  } finally { rl.close() }
  return args
}

async function main(){
  let args=argMap(process.argv.slice(2)); if(args.version){console.log(APP_VERSION);return} if(args.help){help();return}
  if(!args.alias||!args.wallet||!args.threads)args=await interactiveOptions(args)
  const alias=safeAlias(args.alias), wallet=safeAddress(args.wallet), maxThreads=Math.max(1,Number(os.availableParallelism?.()||os.cpus().length||1)), threads=Math.max(1,Math.min(maxThreads,Math.floor(Number(args.threads)||1)))
  if(!wallet)throw new Error('Invalid BYZE address.')
  if(Object.prototype.hasOwnProperty.call(args,'bootstrap')&&args.bootstrap===undefined)throw new Error('--bootstrap requires a value')
  const bootstrap=parseBootstrap(args.bootstrap)
  const cliPath=detectByzeCli(args['byze-cli']); if(!cliPath)throw new Error('byze-cli not found. Use --byze-cli PATH.')
  if(args['miner-dir'])throw new Error('--miner-dir was removed: BYZE P2Pool never uses or patches an external byze-miner checkout. Use --native-dir for a managed P2Pool bundle.')
  if(args['native-dir'])process.env.BYZE_P2POOL_NATIVE_DIR=path.resolve(args['native-dir'])
  const policyPath=path.resolve(args.policy||path.join(__dirname,'..','config','pool-policy.json')), policy=loadPolicy(policyPath)
  const byze=new ByzeCli(cliPath)
  const chain=await byze.call('getblockchaininfo',[],{timeout:10_000})
  const ready=assertMainnetReady(chain)
  if(!ready.ok)throw new Error(`BYZE node is not ready for the public mainnet pool (${ready.code}).`)
  const payoutValidator = new PayoutAddressValidator((m,p) => byze.call(m,p,{timeout:10_000}), { warn })
  for (const [label,address] of [['payout',wallet],['fee',policy.feeAddress]]) {
    const checked = await payoutValidator.validate(address, { local: label === 'payout' })
    if (!checked.ok) throw new Error(`BYZE ${label} address rejected: ${checked.code}`)
  }
  if(args['dry-run']){
    console.log(`\nBYZE P2Pool CLI ${APP_VERSION} — dry-run`)
    console.log(`DHT seeds  : ${bootstrap===undefined?'public defaults':bootstrap.length?bootstrap.join(', '):'none (isolated)'}`)
    console.log(`Node       : OK (main, height ${chain.blocks}, synchronized)`)
    console.log(`Alias      : ${alias}`)
    console.log(`Payout     : ${wallet}`)
    console.log(`Threads    : ${threads}/${maxThreads}`)
    console.log(`Pool       : ${policy.poolId}`)
    console.log(`Fee        : ${(Number(policy.feeBasisPoints)/100).toFixed(2)} % -> ${policy.feeAddress}`)
    console.log(`Policy hash: ${policy.policyHash}`)
    console.log(`byze-cli   : ${cliPath}\n`)
    const native=new Supervisor(); const ns=native.refreshDiscovery()
    console.log(`P2Pool miner: ${ns.minerAvailable ? 'OK' : 'NOT FOUND / INVALID'}`)
    console.log(`RX verifier : ${ns.verifierAvailable ? 'OK' : 'NOT FOUND / INVALID'}`)
    console.log(`multioutput: ${ns.directCoinbaseSupported ? 'OK' : 'INCOMPATIBLE'}`)
    native.stop()
    if(!ns.minerAvailable||!ns.verifierAvailable||!ns.directCoinbaseSupported)throw new Error('Native prerequisites are incomplete; see README.md.')
    console.log('Dry-run OK. No mining or P2P networking started.');return
  }
  const app=new MinerApp({alias,wallet,threads,policy,byze,payoutValidator,bootstrap,noSubmit:!!args['no-submit']})
  let stopping=false
  const stop=async()=>{if(stopping)return; stopping=true; await app.stop(); process.exit(0)}
  process.on('SIGINT',()=>void stop()); process.on('SIGTERM',()=>void stop())
  await app.start()
  await new Promise(()=>{})
}

if (require.main === module) {
  main().catch((error)=>{console.error(`ERROR: ${error?.message||error}`); process.exitCode=1})
}

module.exports = {
  SECURITY_GENERATION, APP_VERSION, CONTRACT_ID, CONTRACT_VERSION, CONTRACT_SOURCE_HASH, BUILTIN_PUBLISHER_KEY, POOL_ID,
  sha256Hex, sign, verify, detectByzeCli, loadPolicy, assertMainnetReady, PeerRateLimiter, ValidationGate, ByzeCli, P2PTransport, MinerApp
}
