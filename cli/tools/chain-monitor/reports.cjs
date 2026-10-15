'use strict'
// Separate observed P2P activity from proven P2Pool block attribution.
const {policy,addressScript,formatByz}=require('./core.cjs')
const FEE_SCRIPT=addressScript(policy.feeAddress)
function abbreviateWallet(value) {
  const s=String(value||'')
  return /^byz1[a-z0-9]{18,100}$/.test(s) ? s.slice(0,10)+'...'+s.slice(-6) : 'unresolved'
}
function formatHashrate(value) {
  const n=Number(value)
  if(!Number.isFinite(n)||n<0)return 'unavailable'
  if(n>=1e9)return '~'+(n/1e9).toFixed(2)+' GH/s'
  if(n>=1e6)return '~'+(n/1e6).toFixed(2)+' MH/s'
  if(n>=1e3)return '~'+(n/1e3).toFixed(2)+' kH/s'
  return '~'+n.toFixed(1)+' H/s'
}
function normalizeActivity(raw, now=Date.now()) {
  if(!raw || raw.schema!==1 || raw.source!=='hyperswarm-partial')return null
  const t=Date.parse(raw.observedAt||'')
  if(!Number.isFinite(t)||t>now+30_000||now-t>120_000)return null
  const whole=x=>Number.isSafeInteger(x)&&x>=0&&x<=64
  if(!whole(raw.connectedPeers)||!whole(raw.validPresences)||!whole(raw.activeMiners)||
     !whole(raw.hashrateSamples)||raw.activeMiners>raw.validPresences||
     raw.validPresences>raw.connectedPeers||raw.hashrateSamples>raw.activeMiners||
     !Number.isFinite(raw.observedHashrateHps)||raw.observedHashrateHps<0||
     raw.observedHashrateHps>64*1e12)return null
  return raw
}
function activityReport({activity,now=Date.now()}) {
  const a=normalizeActivity(activity,now)
  // No public activity message without verified active presence and useful
  // recent hashrate. Missing coverage is not evidence of an empty pool.
  if(!a || a.activeMiners<1 || a.hashrateSamples<1 || a.observedHashrateHps<=0)return null
  // Discord formats this timestamp in each reader's local time zone.
  const timestamp='<t:'+Math.floor(Date.parse(a.observedAt)/1000)+':t>'
  return [
    '**BYZE P2Pool · Activity Report**',
    'Latest observation · '+timestamp,
    '',
    '**'+a.activeMiners+'** Active miners',
    '**'+formatHashrate(a.observedHashrateHps)+'** Hashrate'
  ].join('\n')
}
function percent(part,total) {
  if(total<=0n)return '0.00'
  const scaled=(part*10000n+total/2n)/total
  return (scaled/100n).toString()+'.'+(scaled%100n).toString().padStart(2,'0')
}
function blockReport(candidate,{verified=false,confirmations=0,maxRows=12,evidenceUrl=''}={}) {
  // Fee-address matching alone does NOT demonstrate P2Pool origin.
  if(!verified)return null
  if(!candidate?.feeApproxMatch || !/^[0-9a-f]{64}$/.test(String(candidate.hash||'')) ||
     !Number.isSafeInteger(candidate.height)||candidate.height<1 ||
     !Number.isSafeInteger(confirmations)||confirmations<6)return null
  const outputs=Array.isArray(candidate.outputs)?candidate.outputs:[]
  if(!outputs.length)return null
  let total=0n,fees=0n
  const payees=new Map()
  for(const x of outputs) {
    let sat
    try {sat=BigInt(String(x.sats))}catch{return null}
    if(sat<0n)return null
    total+=sat
    if(x.address===policy.feeAddress || x.script===FEE_SCRIPT) {fees+=sat;continue}
    if(sat===0n)continue
    const address=String(x.address||'')
    if(!/^byz1[a-z0-9]{18,100}$/.test(address))return null
    payees.set(address,(payees.get(address)||0n)+sat)
  }
  if(total<=0n || total!==BigInt(candidate.totalSats) ||
     fees!==BigInt(candidate.paidFeeSats) || !payees.size)return null
  const net=total-fees
  if([...payees.values()].reduce((sum,v)=>sum+v,0n)!==net)return null
  const rows=[...payees].sort((a,b)=>a[1]===b[1]?a[0].localeCompare(b[0]):a[1]>b[1]?-1:1)
  const count=Math.min(12,Math.max(1,Number(maxRows)||12))
  const shown=rows.slice(0,count)
  const table=['Wallet             % paid       BYZ','-------------------------------------------',
    ...shown.map(([wallet,amount]) =>
      abbreviateWallet(wallet).padEnd(19)+' '+percent(amount,net).padStart(6)+'% '+formatByz(amount.toString()).padStart(12))
  ]
  const omitted=rows.slice(count)
  if(omitted.length){
    const rest=omitted.reduce((sum,[,amount])=>sum+amount,0n)
    table.push('+'+omitted.length+' other outputs: '+percent(rest,net)+'% / '+formatByz(rest.toString())+' BYZ')
  }
  const fence=String.fromCharCode(96).repeat(3)
  const lines=[
    '**BYZE P2Pool · Block #'+candidate.height+' confirmed**',
    'Confirmations: **'+confirmations+'** · Paid addresses: **'+rows.length+'**',
    'Total coinbase: **'+formatByz(total.toString())+' BYZ**',
    'Miner payouts: **'+formatByz(net.toString())+' BYZ** · Pool fee: **'+formatByz(fees.toString())+' BYZ** ('+policy.feeBasisPoints/100+'%)',
    fence+'text',...table,fence,
    'Percentages are shares of this payout, not live hashrate.',
    'Chain evidence: https://explorer.byze.org/api/block/'+candidate.height,
    ...( /^https:\/\/github\.com\/ContractP2P\/byze-p2pool-cli\/(?:issues|pull)\/[1-9][0-9]*$/.test(evidenceUrl) ? ['PPLNS review evidence: '+evidenceUrl] : [] )
  ]
  const message=lines.join('\n')
  return message.length<=2000?message:null
}
module.exports={abbreviateWallet,formatHashrate,normalizeActivity,activityReport,blockReport}
