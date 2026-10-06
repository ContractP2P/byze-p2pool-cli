'use strict'

const { calculateDirectPayouts } = require('./p2pool-protocol')

const POOLSHARE_WINDOW = 20
const MAX_POOLSHARES = 2048
const MAX_POOLSHARE_ORPHANS = 512

function positiveBigInt(v) { try { const n = BigInt(String(v)); return n > 0n ? n : null } catch { return null } }
function normalizedEpoch(v) { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : -1 }

function validatePoolShareShape(share) {
  if (!share || share.kind !== 'pool-share' || !/^ps:[0-9a-f]{64}$/.test(String(share.poolShareId || ''))) return { ok:false, code:'miningPoolShareInvalid' }
  if (share.previousPoolShareId && !/^ps:[0-9a-f]{64}$/.test(String(share.previousPoolShareId))) return { ok:false, code:'miningPoolSharePreviousInvalid' }
  if (!/^(?:cp|gc):[0-9a-f]{64}$/.test(String(share.checkpointId || ''))) return { ok:false, code:'miningPoolShareCheckpointInvalid' }
  if (!/^[0-9a-f]{64}$/.test(String(share.byzePrevBlockHash || ''))) return { ok:false, code:'miningPoolShareTipInvalid' }
  if (!Number.isSafeInteger(share.byzeHeight) || share.byzeHeight<1) return {ok:false,code:'miningPoolShareHeightInvalid'}
  if (!positiveBigInt(share.work)) return { ok:false, code:'miningPoolShareWorkInvalid' }
  const weights = Object.entries(share.payoutWeights || {})
  if (!weights.length || weights.length > 400) return { ok:false, code:'miningPoolShareWeightsInvalid' }
  let sum = 0n
  for (const [address, work] of weights) {
    if (!/^[A-Za-z0-9:._-]{8,160}$/.test(String(address || ''))) return { ok:false, code:'miningPoolShareWeightsInvalid' }
    const n = positiveBigInt(work); if (!n) return { ok:false, code:'miningPoolShareWeightsInvalid' }; sum += n
  }
  if (sum !== positiveBigInt(share.work)) return { ok:false, code:'miningPoolShareWeightsMismatch' }
  return { ok:true, work:positiveBigInt(share.work), localWork:sum }
}

class PoolShareChain {
  constructor({ maxShares = MAX_POOLSHARES, window = POOLSHARE_WINDOW, maxOrphans = MAX_POOLSHARE_ORPHANS } = {}) {
    this.maxShares = Math.max(64, Math.min(8192, Number(maxShares)||MAX_POOLSHARES))
    this.window = Math.max(1, Math.min(256, Number(window)||POOLSHARE_WINDOW))
    this.maxOrphans = Math.max(16, Math.min(2048, Number(maxOrphans)||MAX_POOLSHARE_ORPHANS))
    this.byId = new Map()
    this.orphans = new Map()
    this.childrenByMissingParent = new Map()
    this.checkpointToShareIds = new Map()
    this.epochToShareIds = new Map()
    this.bestId = ''
    this.reorgCount = 0
    this.lastReorg = null
  }
  indexNode(node) {
    const id = String(node?.share?.poolShareId || '')
    const checkpointId = String(node?.share?.checkpointId || '')
    const epoch = normalizedEpoch(node?.checkpointEpoch)
    if (checkpointId && id) {
      if (!this.checkpointToShareIds.has(checkpointId)) this.checkpointToShareIds.set(checkpointId, new Set())
      this.checkpointToShareIds.get(checkpointId).add(id)
    }
    if (epoch >= 0 && id) {
      if (!this.epochToShareIds.has(epoch)) this.epochToShareIds.set(epoch, new Set())
      this.epochToShareIds.get(epoch).add(id)
    }
  }
  unindexNode(node) {
    const id = String(node?.share?.poolShareId || '')
    const checkpointId = String(node?.share?.checkpointId || '')
    const epoch = normalizedEpoch(node?.checkpointEpoch)
    const cpSet = this.checkpointToShareIds.get(checkpointId)
    cpSet?.delete(id); if (cpSet && !cpSet.size) this.checkpointToShareIds.delete(checkpointId)
    const epochSet = this.epochToShareIds.get(epoch)
    epochSet?.delete(id); if (epochSet && !epochSet.size) this.epochToShareIds.delete(epoch)
  }
  rememberOrphan(share, meta = {}) {
    const id = String(share.poolShareId)
    if (this.orphans.has(id)) return { ok:true, orphan:true, duplicate:true }
    const parent = String(share.previousPoolShareId || '')
    const record = { share:JSON.parse(JSON.stringify(share)), meta:{ ...meta }, receivedAt:Number(meta.receivedAt||Date.now()) }
    this.orphans.set(id, record)
    if (!this.childrenByMissingParent.has(parent)) this.childrenByMissingParent.set(parent, new Set())
    this.childrenByMissingParent.get(parent).add(id)
    while (this.orphans.size > this.maxOrphans) {
      const oldest=[...this.orphans.entries()].sort((a,b)=>a[1].receivedAt-b[1].receivedAt)[0]
      if (!oldest) break
      this.dropOrphan(oldest[0])
    }
    return { ok:true, orphan:true, missingParent:parent }
  }
  dropOrphan(id) {
    const rec=this.orphans.get(id); if (!rec) return
    this.orphans.delete(id)
    const parent=String(rec.share.previousPoolShareId||'')
    const set=this.childrenByMissingParent.get(parent)
    set?.delete(id); if (set && !set.size) this.childrenByMissingParent.delete(parent)
  }
  betterTip(id, cumulativeWork) {
    if (!this.bestId) return true
    const best = this.byId.get(this.bestId)
    if (!best) return true
    return cumulativeWork > best.cumulativeWork || (cumulativeWork === best.cumulativeWork && String(id).localeCompare(this.bestId) < 0)
  }
  addOne(share, meta = {}) {
    const checked = validatePoolShareShape(share); if (!checked.ok) return checked
    const id = String(share.poolShareId)
    if (this.byId.has(id)) return { ok:true, duplicate:true, node:this.byId.get(id) }
    if (this.orphans.has(id)) return { ok:true, duplicate:true, orphan:true }
    const prev = share.previousPoolShareId ? this.byId.get(share.previousPoolShareId) : null
    if (share.previousPoolShareId && !prev) return this.rememberOrphan(share, meta)
    if (prev && (prev.share.contractHash !== share.contractHash || prev.share.poolId !== share.poolId)) return { ok:false, code:'miningPoolShareChainMismatch' }
    if (prev && Number(share.byzeHeight||0) < Number(prev.share.byzeHeight||0)-6) return { ok:false, code:'miningPoolShareHeightRegression' }
    const checkpointEpoch = normalizedEpoch(meta.checkpointEpoch)
    const previousEpoch = normalizedEpoch(prev?.checkpointEpoch)
    if (prev && checkpointEpoch >= 0 && previousEpoch >= 0 && checkpointEpoch <= previousEpoch) return { ok:false, code:'miningPoolShareEpochRegression', checkpointEpoch, previousEpoch }
    const cumulativeWork = (prev?.cumulativeWork || 0n) + checked.work
    const height = (prev?.height || 0) + 1
    const node = { share:JSON.parse(JSON.stringify(share)), cumulativeWork, height, receivedAt:Number(meta.receivedAt||Date.now()), local:!!meta.local, signerPeerKey:String(meta.signerPeerKey||''), checkpointEpoch }
    this.byId.set(id, node)
    this.indexNode(node)
    if (this.betterTip(id, cumulativeWork)) this.bestId = id
    return { ok:true, node }
  }
  add(share, meta = {}) {
    const oldBestId = this.bestId
    const first = this.addOne(share, meta)
    if (!first.ok || first.orphan || first.duplicate) return { ...first, bestId:this.bestId, oldBestId, bestChanged:false, reorg:false, attachedIds:[] }
    const attachedIds=[]
    const queue=[String(share.poolShareId)]
    while(queue.length){
      const parentId=queue.shift()
      const ids=[...(this.childrenByMissingParent.get(parentId)||[])].sort()
      this.childrenByMissingParent.delete(parentId)
      for(const id of ids){
        const rec=this.orphans.get(id); if(!rec)continue
        this.orphans.delete(id)
        const result=this.addOne(rec.share,rec.meta)
        if(result.ok&&!result.orphan&&!result.duplicate){attachedIds.push(id);queue.push(id)}
      }
    }
    const bestChanged = oldBestId !== this.bestId
    const reorg = !!oldBestId && bestChanged && !this.isAncestor(oldBestId, this.bestId)
    if (reorg) {
      this.reorgCount += 1
      this.lastReorg = { from:oldBestId, to:this.bestId, at:Date.now(), commonAncestor:this.commonAncestor(oldBestId,this.bestId) }
    }
    this.prune()
    return { ...first, bestId:this.bestId, oldBestId, bestChanged, reorg, attachedIds }
  }
  isAncestor(ancestorId, descendantId) {
    const ancestor=String(ancestorId||''), descendant=String(descendantId||'')
    if(!ancestor||!descendant)return false
    let node=this.byId.get(descendant), guard=0
    while(node&&guard++<=this.byId.size+1){
      if(node.share.poolShareId===ancestor)return true
      node=node.share.previousPoolShareId?this.byId.get(node.share.previousPoolShareId):null
    }
    return false
  }
  commonAncestor(aId,bId){
    const seen=new Set(); let a=this.byId.get(String(aId||'')),guard=0
    while(a&&guard++<=this.byId.size+1){seen.add(a.share.poolShareId);a=a.share.previousPoolShareId?this.byId.get(a.share.previousPoolShareId):null}
    let b=this.byId.get(String(bId||''));guard=0
    while(b&&guard++<=this.byId.size+1){if(seen.has(b.share.poolShareId))return b.share.poolShareId;b=b.share.previousPoolShareId?this.byId.get(b.share.previousPoolShareId):null}
    return ''
  }
  prune() {
    if (this.byId.size <= this.maxShares) return
    const canonical = new Set(this.bestWindow(this.maxShares).map(s => s.poolShareId))
    const extras=[...this.byId.entries()].filter(([id])=>!canonical.has(id)).sort((a,b)=>Number(b[1].receivedAt||0)-Number(a[1].receivedAt||0))
    const keep=new Set(canonical)
    for(const [id] of extras){if(keep.size>=this.maxShares)break;keep.add(id)}
    for (const [id,node] of [...this.byId.entries()]) if (!keep.has(id)) { this.byId.delete(id); this.unindexNode(node) }
  }
  tipBeforeEpoch(epoch) {
    const target=Math.floor(Number(epoch))
    if(!Number.isFinite(target)||target<0)return ''
    let node=this.bestId?this.byId.get(this.bestId):null
    while(node){
      if(normalizedEpoch(node.checkpointEpoch)>=0&&node.checkpointEpoch<target)return node.share.poolShareId
      node=node.share.previousPoolShareId?this.byId.get(node.share.previousPoolShareId):null
    }
    return ''
  }
  canonicalShareForEpoch(epoch) {
    const target=normalizedEpoch(epoch); if(target<0)return ''
    let node=this.bestId?this.byId.get(this.bestId):null
    while(node){
      const e=normalizedEpoch(node.checkpointEpoch)
      if(e===target)return node.share.poolShareId
      if(e>=0&&e<target)return ''
      node=node.share.previousPoolShareId?this.byId.get(node.share.previousPoolShareId):null
    }
    return ''
  }
  canonicalCheckpointShareId(checkpointId) {
    const target=String(checkpointId||''); if(!target)return ''
    let node=this.bestId?this.byId.get(this.bestId):null
    while(node){if(String(node.share.checkpointId||'')===target)return node.share.poolShareId;node=node.share.previousPoolShareId?this.byId.get(node.share.previousPoolShareId):null}
    return ''
  }
  windowFrom(tipId, limit = this.window) {
    const id=String(tipId||'')
    const out=[]; let node=id?this.byId.get(id):null
    while (node && out.length < limit) { out.push(node.share); node=node.share.previousPoolShareId?this.byId.get(node.share.previousPoolShareId):null }
    return out
  }
  bestWindow(limit = this.window) { return this.windowFrom(this.bestId, limit) }
  recentShares(limit = 64) { return this.bestWindow(Math.max(1, Math.min(256, Number(limit)||64))).reverse() }
  payoutPlanAt(tipId, rewardSatoshis, maxOutputs = 400, feePolicy = null) {
    const id=String(tipId||'')
    if(!/^ps:[0-9a-f]{64}$/.test(id)||!this.byId.has(id)) return {ok:false,code:'miningPayoutTipUnknown'}
    const shares = this.windowFrom(id, this.window)
    if (!shares.length) return { ok:false, code:'miningPayoutNoPoolShares' }
    return calculateDirectPayouts({ poolShares:shares, rewardSatoshis, maxOutputs, feeAddress:feePolicy?.feeAddress || '', feeBasisPoints:Number(feePolicy?.feeBasisPoints || 0) })
  }
  payoutPlan(rewardSatoshis, maxOutputs = 400, feePolicy = null) {
    if(!this.bestId)return {ok:false,code:'miningPayoutNoPoolShares'}
    return this.payoutPlanAt(this.bestId,rewardSatoshis,maxOutputs,feePolicy)
  }
  snapshot() {
    const best = this.bestId ? this.byId.get(this.bestId) : null
    const parentIds=new Set([...this.byId.values()].map(n=>String(n.share.previousPoolShareId||'')).filter(Boolean))
    const tips=[...this.byId.keys()].filter(id=>!parentIds.has(id)).sort()
    return { bestPoolShareId:this.bestId, chainHeight:best?.height||0, canonicalEpoch:normalizedEpoch(best?.checkpointEpoch), cumulativeWork:String(best?.cumulativeWork||0n), window:this.window, windowCount:this.bestWindow(this.window).length, stored:this.byId.size, orphanCount:this.orphans.size, forkTips:tips.length, forkCount:Math.max(0,tips.length-(this.bestId?1:0)), reorgCount:this.reorgCount, lastReorg:this.lastReorg?{...this.lastReorg}:null }
  }
}

module.exports = { POOLSHARE_WINDOW, MAX_POOLSHARES, MAX_POOLSHARE_ORPHANS, validatePoolShareShape, PoolShareChain }
