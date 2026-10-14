#!/usr/bin/env node
'use strict'
// Read-only P2P membership sampler: no wallet, BYZE Core RPC, mining, or HTTP callback to miners.
const crypto=require('node:crypto')
const fs=require('node:fs')
const path=require('node:path')
const {presenceSigningPayload,validatePresenceShape,canonical}=require('../../src/mining/p2pool-membership')
const {createPoolFeePolicy}=require('../../src/mining/pool-fee-policy')
const ID=require('../../src/byze-p2pool.js') // import existing public network constants; no miner is started
const rawPolicy=require('../../config/pool-policy.json')
const ED25519_SPKI_PREFIX=Buffer.from('302a300506032b6570032100','hex')
const MAX_FRAME_BYTES=256*1024
const MAX_PEERS=64
const policy=createPoolFeePolicy(rawPolicy)
if(!policy.ok || policy.poolId!==ID.POOL_ID)throw Error('Invalid observer fee policy')

function verifyPresence(peerKey,announcement,now=Date.now()) {
  const checked=validatePresenceShape(announcement,{now,expectedPeerKey:peerKey})
  if(!checked.ok)return null
  const p=checked.payload
  if(p.securityGeneration!==ID.SECURITY_GENERATION ||
     p.contractId!==ID.CONTRACT_ID || p.version!==ID.CONTRACT_VERSION ||
     p.publisherKey!==ID.BUILTIN_PUBLISHER_KEY ||
     p.sourceHash!==ID.CONTRACT_SOURCE_HASH || p.poolId!==ID.POOL_ID ||
     p.feePolicyHash!==policy.policyHash || p.feeAddress!==policy.feeAddress ||
     p.feeBasisPoints!==policy.feeBasisPoints)return null
  try {
    const sig=Buffer.from(String(announcement.signature||''),'base64')
    if(sig.length!==64)return null
    const pub=crypto.createPublicKey({key:Buffer.concat([ED25519_SPKI_PREFIX,Buffer.from(peerKey,'hex')]),format:'der',type:'spki'})
    if(!crypto.verify(null,Buffer.from(canonical(p)),pub,sig))return null
  }catch{return null}
  const telemetry=announcement.telemetry||{}
  const observedAt=Number(telemetry.observedAt)
  const hps=Number(telemetry.hashrateHps)
  const recent=Number.isSafeInteger(observedAt)&&observedAt<=now+30_000&&now-observedAt<=20_000
  const safeHps=recent&&Number.isFinite(hps)&&hps>=0&&hps<=1e12?hps:null
  return {peerKey,seq:p.seq,updatedAt:p.updatedAt,expiresAt:p.expiresAt,
    miningState:p.miningState,hashrateHps:safeHps}
}
function snapshot(records,peers,now=Date.now()) {
  const current=[...records.values()].filter(r=>r.expiresAt>now && r.updatedAt>=now-120_000)
  const active=current.filter(r=>r.miningState==='MINING')
  const known=active.filter(r=>r.hashrateHps!==null)
  return {schema:1,source:'hyperswarm-partial',observedAt:new Date(now).toISOString(),
    connectedPeers:peers.size,validPresences:current.length,activeMiners:active.length,
    hashrateSamples:known.length,observedHashrateHps:known.reduce((s,r)=>s+r.hashrateHps,0)}
}
async function observe({durationMs=45_000}={}) {
  const Hyperswarm=require('hyperswarm')
  const DHT=require('hyperdht')
  const {dhtOptions,parseBootstrap}=require('../../src/dht-config')
  const bootstrap=process.env.BYZE_P2P_BOOTSTRAP===undefined?undefined:parseBootstrap(process.env.BYZE_P2P_BOOTSTRAP)
  const dht=new DHT(dhtOptions(bootstrap))
  const swarm=new Hyperswarm({seed:crypto.randomBytes(32),dht,maxPeers:MAX_PEERS,maxParallel:8})
  const topic=crypto.createHash('sha256').update(
    'contract-mining\0'+ID.CONTRACT_SOURCE_HASH+'\0'+ID.POOL_ID+'\0'+policy.policyHash+'\0'+ID.SECURITY_GENERATION).digest()
  const peers=new Set(),records=new Map()
  swarm.on('connection',(conn,info)=>{
    const peerKey=Buffer.from(info?.publicKey||conn.remotePublicKey||[]).toString('hex')
    if(!/^[0-9a-f]{64}$/.test(peerKey) || peers.size>=MAX_PEERS){conn.destroy();return}
    peers.add(peerKey)
    let buffer='',frames=0
    conn.on('error',()=>{})
    conn.on('data',chunk=>{
      buffer+=chunk.toString('utf8')
      if(Buffer.byteLength(buffer,'utf8')>MAX_FRAME_BYTES){conn.destroy();return}
      while(buffer.includes('\n')){
        const end=buffer.indexOf('\n'),raw=buffer.slice(0,end)
        buffer=buffer.slice(end+1)
        if(++frames>250){conn.destroy();return}
        if(!raw||raw.length>MAX_FRAME_BYTES)continue
        let frame
        try{frame=JSON.parse(raw)}catch{continue}
        if(frame?.type!=='mining-presence')continue
        const entry=verifyPresence(peerKey,frame.announcement)
        if(!entry)continue
        const prev=records.get(peerKey)
        if(!prev || entry.seq>prev.seq || (entry.seq===prev.seq&&entry.updatedAt>prev.updatedAt)){
          if(entry.miningState==='LEFT')records.delete(peerKey)
          else records.set(peerKey,entry)
        }
      }
    })
    // The public mining protocol sends presence to newly connected peers.
    conn.write(JSON.stringify({v:4,type:'hello',alias:'P2PoolObserver',inboundMode:'invite',
      byzeAddress:'',byzeAddressScope:'',shareEncryptionPublicKey:'',
      shareSigningPublicKey:'',ts:Date.now()})+'\n')
  })
  try {
    const discovery=swarm.join(topic,{client:true,server:true,limit:MAX_PEERS})
    await Promise.race([discovery.flushed(),new Promise((_,reject)=>setTimeout(()=>reject(Error('DHT discovery timed out')),15000))])
    await new Promise(resolve=>setTimeout(resolve,durationMs))
    return snapshot(records,peers)
  }finally{
    await swarm.destroy().catch(()=>{})
    await dht.destroy().catch(()=>{})
  }
}
async function main(){
  const result=await observe()
  const destination=process.env.BYZE_ACTIVITY_FILE
  if(!destination)throw Error('BYZE_ACTIVITY_FILE is required')
  fs.mkdirSync(path.dirname(destination),{recursive:true})
  fs.writeFileSync(destination,JSON.stringify(result)+'\n',{mode:0o600})
  console.log('P2P observation: '+JSON.stringify(result))
}
if(require.main===module)main().catch(e=>{console.error('P2POOL_ACTIVITY_OBSERVER_FAILED:',e.message);process.exitCode=1})
module.exports={verifyPresence,snapshot,observe}
