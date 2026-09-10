'use strict'

const crypto = require('crypto')

const JOB_COMMITMENT_PROTOCOL = 'contract-byze-p2pool-job-commitment-v2'
const MAX_COINBASE_HEX_BYTES = 64 * 1024
const MAX_MERKLE_BRANCH = 32

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}
function sha256Hex(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function sha256d(buf) { return crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest() }
function hex64(value) { const t=String(value||'').toLowerCase(); return /^[0-9a-f]{64}$/.test(t)?t:'' }
function safeHex(value,{maxBytes=MAX_COINBASE_HEX_BYTES,minBytes=1}={}) { const t=String(value||'').toLowerCase(); return /^[0-9a-f]+$/.test(t)&&!(t.length%2)&&t.length/2>=minBytes&&t.length/2<=maxBytes?t:'' }
function safePplnsTip(value){const t=String(value||'');return t===''||/^ps:[0-9a-f]{64}$/.test(t)?t:null}
function positiveBigInt(value){try{const n=BigInt(String(value));return n>0n?n:null}catch{return null}}

function normalizeCommittedOutputs(outputs, coinbaseValue) {
  if(!Array.isArray(outputs)||!outputs.length||outputs.length>400)return {ok:false,code:'miningJobCommitmentOutputsInvalid'}
  const rows=[]; let sum=0n
  for(const row of outputs){
    const address=String(row?.address||'').trim()
    const sat=positiveBigInt(row?.satoshis)
    const script=safeHex(row?.script,{maxBytes:10_000})
    if(!/^[A-Za-z0-9:._-]{8,160}$/.test(address)||sat==null||!script)return {ok:false,code:'miningJobCommitmentOutputInvalid'}
    rows.push({address,satoshis:sat.toString(),script})
    sum+=sat
  }
  const reward=positiveBigInt(coinbaseValue)
  if(reward==null||sum!==reward)return {ok:false,code:'miningJobCommitmentConservation'}
  const sorted=[...rows].sort((a,b)=>a.address.localeCompare(b.address))
  if(JSON.stringify(sorted)!==JSON.stringify(rows))return {ok:false,code:'miningJobCommitmentOrderInvalid'}
  return {ok:true,outputs:rows,coinbaseValue:reward.toString()}
}

function buildJobCommitment({contractHash,poolId,cellId,templateHash,feePolicyHash,pplnsTipId='',coinbaseOutputs,coinbaseValue}){
  const contract=hex64(contractHash), template=hex64(templateHash), fee=hex64(feePolicyHash), tip=safePplnsTip(pplnsTipId)
  const pool=String(poolId||'').slice(0,96), cell=String(cellId||'').slice(0,96)
  if(!contract||!template||!fee||tip===null||!pool||!cell)return {ok:false,code:'miningJobCommitmentInvalid'}
  const normalized=normalizeCommittedOutputs(coinbaseOutputs,coinbaseValue); if(!normalized.ok)return normalized
  const base={protocol:JOB_COMMITMENT_PROTOCOL,contractHash:contract,poolId:pool,cellId:cell,templateHash:template,feePolicyHash:fee,pplnsTipId:tip,coinbaseValue:normalized.coinbaseValue,outputs:normalized.outputs}
  const jobCommitmentHash=sha256Hex(Buffer.from(`${JOB_COMMITMENT_PROTOCOL}\0commitment\0${canonical(base)}`))
  return {ok:true,...base,jobCommitmentHash}
}

function coinbaseMerkleBranch(otherTxids=[]){
  const txids=Array.isArray(otherTxids)?otherTxids:[]
  if(txids.length>5000)return {ok:false,code:'miningCoinbaseBranchTooManyTransactions'}
  let level=[Buffer.alloc(32),...txids.map((h)=>{const x=hex64(h);return x?Buffer.from(x,'hex').reverse():null})]
  if(level.some((x)=>!Buffer.isBuffer(x)||x.length!==32))return {ok:false,code:'miningCoinbaseBranchTxidInvalid'}
  let index=0; const branch=[]
  while(level.length>1){
    if(level.length%2)level.push(level[level.length-1])
    const sibling=level[index^1]
    branch.push(sibling.toString('hex'))
    const next=[]
    for(let i=0;i<level.length;i+=2)next.push(sha256d(Buffer.concat([level[i],level[i+1]])))
    index=Math.floor(index/2); level=next
    if(branch.length>MAX_MERKLE_BRANCH)return {ok:false,code:'miningCoinbaseBranchTooDeep'}
  }
  return {ok:true,branch}
}

function applyCoinbaseMerkleBranch(coinbaseTxidDisplayHex,branch){
  const txid=hex64(coinbaseTxidDisplayHex)
  if(!txid||!Array.isArray(branch)||branch.length>MAX_MERKLE_BRANCH)return ''
  let node=Buffer.from(txid,'hex').reverse()
  for(const raw of branch){const sibling=safeHex(raw,{maxBytes:32,minBytes:32});if(!sibling)return '';node=sha256d(Buffer.concat([node,Buffer.from(sibling,'hex')]))}
  return node.toString('hex')
}

function headerMerkleRootInternalHex(header80){const h=safeHex(header80,{maxBytes:80,minBytes:80});return h?Buffer.from(h,'hex').subarray(36,68).toString('hex'):''}

function decimalCoinsToSatoshis(value){
  if(typeof value==='number'&&!Number.isFinite(value))return null
  let s=typeof value==='number'?value.toFixed(8):String(value??'').trim()
  if(/e/i.test(s)){const n=Number(s);if(!Number.isFinite(n))return null;s=n.toFixed(8)}
  const m=s.match(/^(-?)(\d+)(?:\.(\d{0,8}))?$/);if(!m||m[1])return null
  try{return BigInt(m[2])*100000000n+BigInt((m[3]||'').padEnd(8,'0')||'0')}catch{return null}
}
function decodedVoutSatoshis(vout){
  for(const key of ['valueSat','value_sats','satoshis']){if(vout?.[key]!=null){try{return BigInt(String(vout[key]))}catch{}}}
  return decimalCoinsToSatoshis(vout?.value)
}
function decodedScript(vout){return safeHex(vout?.scriptPubKey?.hex||vout?.scriptpubkey||'',{maxBytes:10_000})}

function decodeScriptNumLE(bytes){if(!bytes.length)return 0n;const copy=Buffer.from(bytes);const neg=!!(copy[copy.length-1]&0x80);copy[copy.length-1]&=0x7f;let n=0n;for(let i=0;i<copy.length;i++)n|=BigInt(copy[i])<<(8n*BigInt(i));return neg?-n:n}
function coinbaseHeightFromDecoded(decoded){
  const hex=safeHex(decoded?.vin?.[0]?.coinbase,{maxBytes:10_000}); if(!hex)return null
  const b=Buffer.from(hex,'hex'); if(!b.length)return null
  let pos=0,len=0
  const op=b[pos++]
  if(op===0)return 0
  if(op>=0x51&&op<=0x60)return op-0x50
  if(op<0x4c)len=op
  else if(op===0x4c){if(pos>=b.length)return null;len=b[pos++]}
  else if(op===0x4d){if(pos+1>=b.length)return null;len=b[pos]|(b[pos+1]<<8);pos+=2}
  else return null
  if(len<0||pos+len>b.length)return null
  const n=decodeScriptNumLE(b.subarray(pos,pos+len)); return n>=0n&&n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):null
}

async function verifyCoinbaseBinding({rpc,header80,coinbaseNoWitnessHex,merkleBranch,expectedCommitment,expectedHeight}){
  if(typeof rpc!=='function'||!expectedCommitment?.ok)return {ok:false,code:'miningCoinbaseBindingConfigInvalid'}
  const coinbaseHex=safeHex(coinbaseNoWitnessHex,{maxBytes:MAX_COINBASE_HEX_BYTES});if(!coinbaseHex)return {ok:false,code:'miningCoinbaseBindingCoinbaseInvalid'}
  const headerRoot=headerMerkleRootInternalHex(header80);if(!headerRoot)return {ok:false,code:'miningCoinbaseBindingHeaderInvalid'}
  if(!Array.isArray(merkleBranch)||merkleBranch.length>MAX_MERKLE_BRANCH)return {ok:false,code:'miningCoinbaseBindingBranchInvalid'}
  let decoded
  try{decoded=await rpc('decoderawtransaction',[coinbaseHex])}catch(error){return {ok:false,code:'miningCoinbaseBindingRpcFailed',error:String(error?.message||error)}}
  const txid=hex64(decoded?.txid);if(!txid)return {ok:false,code:'miningCoinbaseBindingTxidInvalid'}
  if(expectedHeight){const h=coinbaseHeightFromDecoded(decoded);if(h!==Number(expectedHeight))return {ok:false,code:'miningCoinbaseBindingHeightMismatch'}}

  const vouts=Array.isArray(decoded?.vout)?decoded.vout:[]
  const expected=expectedCommitment.outputs
  if(vouts.length!==expected.length+1)return {ok:false,code:'miningCoinbaseBindingOutputCountMismatch'}
  for(let i=0;i<expected.length;i++){
    const sat=decodedVoutSatoshis(vouts[i]), script=decodedScript(vouts[i])
    if(sat!==BigInt(expected[i].satoshis)||script!==expected[i].script)return {ok:false,code:'miningCoinbaseBindingOutputMismatch',index:i}
  }
  const witnessSat=decodedVoutSatoshis(vouts[vouts.length-1]), witnessScript=decodedScript(vouts[vouts.length-1])
  if(witnessSat!==0n||!/^6a24aa21a9ed[0-9a-f]{64}$/.test(witnessScript))return {ok:false,code:'miningCoinbaseBindingWitnessInvalid'}

  const total=expected.reduce((sum,row)=>sum+BigInt(row.satoshis),0n)
  if(total!==BigInt(expectedCommitment.coinbaseValue))return {ok:false,code:'miningCoinbaseBindingConservation'}
  const calculatedRoot=applyCoinbaseMerkleBranch(txid,merkleBranch)
  if(!calculatedRoot||calculatedRoot!==headerRoot)return {ok:false,code:'miningCoinbaseBindingMerkleMismatch'}
  return {ok:true,coinbaseTxid:txid,merkleRootInternal:calculatedRoot}
}

module.exports={
  JOB_COMMITMENT_PROTOCOL,MAX_COINBASE_HEX_BYTES,MAX_MERKLE_BRANCH,
  buildJobCommitment,normalizeCommittedOutputs,coinbaseMerkleBranch,applyCoinbaseMerkleBranch,
  headerMerkleRootInternalHex,verifyCoinbaseBinding,coinbaseHeightFromDecoded,decimalCoinsToSatoshis
}
