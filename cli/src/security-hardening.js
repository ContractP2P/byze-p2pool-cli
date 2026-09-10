'use strict'

const DEFAULTS={
  rateWindowMs:10_000,
  maxFramesPerWindow:120,
  maxBytesPerWindow:2*1024*1024,
  maxExpensiveFramesPerWindow:48,
  strikesToBlock:3,
  blockMs:60_000
}

function assertMainnetReady(info) {
  if (!info || typeof info !== 'object') return { ok:false, code:'byze-chain-info-missing' }
  if (String(info.chain || '') !== 'main') return { ok:false, code:'byze-mainnet-required', chain:String(info.chain || '') }
  if (info.initialblockdownload !== false) return { ok:false, code:'byze-node-not-synchronized' }
  const blocks = Number(info.blocks), headers = Number(info.headers)
  if (!Number.isFinite(blocks) || blocks < 0) return { ok:false, code:'byze-block-height-invalid' }
  if (Number.isFinite(headers) && headers - blocks > 2) return { ok:false, code:'byze-node-behind-headers', blocks, headers }
  return { ok:true, blocks, headers:Number.isFinite(headers) ? headers : blocks, chain:'main' }
}

class PeerRateLimiter {
  constructor({ windowMs=DEFAULTS.rateWindowMs, maxFrames=DEFAULTS.maxFramesPerWindow, maxBytes=DEFAULTS.maxBytesPerWindow, maxExpensive=DEFAULTS.maxExpensiveFramesPerWindow, strikesToBlock=DEFAULTS.strikesToBlock, blockMs=DEFAULTS.blockMs } = {}) {
    this.windowMs=windowMs; this.maxFrames=maxFrames; this.maxBytes=maxBytes; this.maxExpensive=maxExpensive; this.strikesToBlock=strikesToBlock; this.blockMs=blockMs
    this.byPeer=new Map(); this.blockedUntil=new Map()
  }
  isBlocked(peerKey, now=Date.now()) {
    const key=String(peerKey||'').toLowerCase(), until=Number(this.blockedUntil.get(key)||0)
    if (until<=now) { if(until)this.blockedUntil.delete(key); return false }
    return true
  }
  allow(peerKey,{bytes=0,type=''}={},now=Date.now()) {
    const key=String(peerKey||'').toLowerCase()
    if(this.isBlocked(key,now))return {ok:false,code:'peer-temporarily-blocked',blocked:true}
    let rec=this.byPeer.get(key)
    if(!rec||now-rec.startedAt>=this.windowMs){rec={startedAt:now,frames:0,bytes:0,expensive:0,strikes:Math.max(0,Number(rec?.strikes||0)-1)};this.byPeer.set(key,rec)}
    rec.frames+=1; rec.bytes+=Math.max(0,Number(bytes)||0)
    if(['mining-local-share','mining-cell-checkpoint','mining-pool-share'].includes(String(type||'')))rec.expensive+=1
    if(rec.frames<=this.maxFrames&&rec.bytes<=this.maxBytes&&rec.expensive<=this.maxExpensive)return {ok:true}
    rec.strikes+=1
    if(rec.strikes>=this.strikesToBlock){this.blockedUntil.set(key,now+this.blockMs);this.byPeer.delete(key);return {ok:false,code:'peer-rate-limit-blocked',blocked:true}}
    return {ok:false,code:'peer-rate-limited',blocked:false}
  }
}

class ValidationGate {
  constructor({maxGlobal=8,maxPerPeer=2,maxQueued=64,maxQueuedPerPeer=8}={}){this.maxGlobal=maxGlobal;this.maxPerPeer=maxPerPeer;this.maxQueued=maxQueued;this.maxQueuedPerPeer=maxQueuedPerPeer;this.active=0;this.activeByPeer=new Map();this.queue=[]}
  queuedFor(peerKey){return this.queue.reduce((n,row)=>n+(row.peerKey===peerKey?1:0),0)}
  canRun(peerKey){return this.active<this.maxGlobal&&Number(this.activeByPeer.get(peerKey)||0)<this.maxPerPeer}
  run(peerKey,task){peerKey=String(peerKey||'').toLowerCase();if(this.canRun(peerKey))return this.execute(peerKey,task);if(this.queue.length>=this.maxQueued||this.queuedFor(peerKey)>=this.maxQueuedPerPeer)return Promise.resolve({ok:false,code:'peer-validation-overloaded'});return new Promise((resolve)=>{this.queue.push({peerKey,task,resolve,queuedAt:Date.now()})})}
  async execute(peerKey,task){this.active+=1;this.activeByPeer.set(peerKey,Number(this.activeByPeer.get(peerKey)||0)+1);try{return await task()}finally{this.active=Math.max(0,this.active-1);const n=Math.max(0,Number(this.activeByPeer.get(peerKey)||1)-1);if(n)this.activeByPeer.set(peerKey,n);else this.activeByPeer.delete(peerKey);this.drain()}}
  drain(){for(let i=0;i<this.queue.length;){const row=this.queue[i];if(Date.now()-row.queuedAt>15_000){this.queue.splice(i,1);row.resolve({ok:false,code:'peer-validation-queue-timeout'});continue}if(!this.canRun(row.peerKey)){i+=1;continue}this.queue.splice(i,1);void this.execute(row.peerKey,row.task).then(row.resolve);}}
}

module.exports={DEFAULTS,assertMainnetReady,PeerRateLimiter,ValidationGate}
