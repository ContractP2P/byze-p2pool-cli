'use strict'

const {splitPoolShareProofPacket,PoolShareProofAssembler}=require('./poolshare-proof-bundle')
const MAX_HISTORY_AGE_MS=30*24*60*60*1000
const idOK=id=>/^ps:[0-9a-f]{64}$/.test(id)
// One requested 48 KiB page per tick globally. No remote frame can grant historical validation.
class HistorySync {
  constructor({send,getPacket,known,receive,now=Date.now}) {
    Object.assign(this,{send,getPacket,known,receive,now})
    this.pending=new Map();this.allowed=new Map();this.served=new Map();this.pages=new Map()
    this.assembler=new PoolShareProofAssembler();this.lastGlobalServe=-Infinity
    this.timer=null
  }
  start(){if(!this.timer){this.timer=setInterval(()=>this.tick(),650);this.timer.unref?.()}}
  stop(){clearInterval(this.timer);this.timer=null;this.pending.clear();this.allowed.clear()}
  request(peer,id){
    if(!idOK(id)||this.known(id))return false
    const key=`${peer}:${id}`
    if(this.pending.has(key))return true
    if(this.pending.size>=16||[...this.pending.values()].filter(p=>p.peer===peer).length>=4)return false
    this.pending.set(key,{peer,id,cursor:0,at:this.now(),sentAt:null,retries:0});return true
  }
  tick(){
    const now=this.now()
    for(const [key,until] of this.allowed)if(until<now)this.allowed.delete(key)
    for(const [key,p] of this.pending){
      if(now-p.at>120000||this.known(p.id)){this.pending.delete(key);continue}
      if(p.sentAt!==null&&now-p.sentAt<5000)continue
      if(p.retries>=4){this.pending.delete(key);continue}
      if(this.send(p.peer,{v:12,type:'mining-pool-share-request',id:p.id,cursor:p.cursor})) {p.sentAt=now;p.retries++;this.pending.delete(key);this.pending.set(key,p)}
      break
    }
  }
  isRequested(peer,id){return (this.allowed.get(`${peer}:${id}`)||0)>this.now()}
  serve(peer,frame){
    const now=this.now(),id=String(frame.id||''),cursor=frame.cursor
    if(!idOK(id)||!Number.isSafeInteger(cursor)||cursor<0||cursor>=256)return false
    if(now-(this.served.get(peer)??-Infinity)<600||now-this.lastGlobalServe<40)return false
    // Charge before serialization, including unsuccessful requests.
    this.served.set(peer,now);this.lastGlobalServe=now
    while(this.served.size>128)this.served.delete(this.served.keys().next().value)
    const packet=this.getPacket(id);if(!packet)return false
    let pages=this.pages.get(id)
    if(!pages){const split=splitPoolShareProofPacket(packet);if(!split.ok)return false;pages=split.packets;this.pages.set(id,pages);while(this.pages.size>2)this.pages.delete(this.pages.keys().next().value)}
    if(!pages[cursor])return false
    return this.send(peer,{v:12,type:'mining-pool-share-page',id,cursor,packet:pages[cursor]})
  }
  async accept(peer,frame){
    const key=`${peer}:${frame.id}`,p=this.pending.get(key),meta=frame.packet?.proofBundle
    if(!p||p.sentAt===null||frame.cursor!==p.cursor||frame.packet?.share?.poolShareId!==p.id||meta?.chunkIndex!==p.cursor)return false
    const result=this.assembler.add(frame.packet,peer,this.now())
    if(!result.ok){this.pending.delete(key);return false}
    if(!result.complete){p.cursor++;p.sentAt=null;p.retries=0;return true}
    this.pending.delete(key);this.allowed.set(key,this.now()+300000)
    while(this.allowed.size>128)this.allowed.delete(this.allowed.keys().next().value)
    await this.receive(peer,result.packet)
    return true
  }
}
module.exports={HistorySync,MAX_HISTORY_AGE_MS}
