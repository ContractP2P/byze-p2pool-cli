'use strict'

const MAX_CHAIN_LAG = 6
function proofAnchor(proof) {
  const height = proof?.height, header = String(proof?.header80 || '').toLowerCase()
  const previousBlockHash = String(proof?.previousBlockHash || '').toLowerCase()
  if (!Number.isSafeInteger(height) || height < 1 || !/^[0-9a-f]{160}$/.test(header) || !/^[0-9a-f]{64}$/.test(previousBlockHash)) return null
  if (Buffer.from(header.slice(8,72), 'hex').reverse().toString('hex') !== previousBlockHash) return null
  return { height, previousBlockHash, bits:Buffer.from(header.slice(144,152),'hex').reverse().toString('hex') }
}
function poolAnchor(proofs) {
  if (!Array.isArray(proofs) || !proofs.length) return null
  const anchors = proofs.map(p => proofAnchor(p?.proof))
  if (anchors.some(a => !a)) return null
  anchors.sort((a,b) => b.height-a.height || a.previousBlockHash.localeCompare(b.previousBlockHash))
  if (anchors[0].height-anchors.at(-1).height > MAX_CHAIN_LAG) return null
  const atHeight = new Map()
  for (const a of anchors) {
    if (atHeight.has(a.height) && atHeight.get(a.height) !== a.previousBlockHash) return null
    atHeight.set(a.height,a.previousBlockHash)
  }
  return anchors[0]
}
class ChainContextValidator {
  constructor(rpc) { this.rpc=rpc; this.cache=new Map(); this.snapshot=null; this.pending=null }
  async view() {
    if (this.snapshot && Date.now()-this.snapshot.at < 250) return this.snapshot.info
    if (!this.pending) this.pending=Promise.resolve().then(()=>this.rpc('getblockchaininfo',[])).then(info=>{
      if (!Number.isSafeInteger(info?.blocks) || !/^[0-9a-f]{64}$/.test(info?.bestblockhash || '')) throw new Error('chain unavailable')
      if (this.snapshot?.info.bestblockhash !== info.bestblockhash) this.cache.clear()
      this.snapshot={info,at:Date.now()}; return info
    }).finally(()=>{this.pending=null})
    return this.pending
  }
  async validate(proof, template, {historical=false}={}) {
    const anchor=proofAnchor(proof)
    if (!anchor) return {ok:false,code:'consensus-context-invalid'}
    try {
      const view=await this.view(), {height,previousBlockHash:prev,bits}=anchor
      if (height>view.blocks+1 || (!historical && height<view.blocks+1-MAX_CHAIN_LAG)) return {ok:false,code:'consensus-height-out-of-range'}
      const key=`${view.bestblockhash}:${height}:${prev}:${bits}`
      if (this.cache.has(key)) return this.cache.get(key)
      const expectedPrev=height===view.blocks+1 ? view.bestblockhash : String(await this.rpc('getblockhash',[height-1])).toLowerCase()
      if (prev!==expectedPrev) return {ok:false,code:'previous-block-mismatch'}
      let expectedBits
      if (height===view.blocks+1) {
        if (template?.height!==height || template.previousblockhash!==prev) return {ok:false,code:'consensus-context-unknown'}
        expectedBits=template.bits
      } else {
        const blockHash=await this.rpc('getblockhash',[height])
        expectedBits=(await this.rpc('getblockheader',[blockHash])).bits
      }
      const result=String(expectedBits).toLowerCase()===bits ? {ok:true} : {ok:false,code:'bits-mismatch'}
      if (result.ok) { this.cache.set(key,result); while(this.cache.size>128)this.cache.delete(this.cache.keys().next().value) }
      return result
    } catch { return {ok:false,code:'consensus-context-unknown'} }
  }
}
module.exports={MAX_CHAIN_LAG,proofAnchor,poolAnchor,ChainContextValidator}
