#!/usr/bin/env node
'use strict'
const assert=require('node:assert/strict'),crypto=require('node:crypto'),DHT=require('hyperdht')
const {P2PTransport}=require('../src/byze-p2pool')
const {HistorySync}=require('../src/mining/history-sync')
const delay=ms=>new Promise(r=>setTimeout(r,ms))
async function main(){
 const port=35000+Math.floor(Math.random()*20000)
 const bootstrap=DHT.bootstrapper(port,'127.0.0.1',{bootstrap:[],nodes:[]})
 const topicHex=crypto.randomBytes(32).toString('hex'),nodes=[`127.0.0.1:${port}`]
 let a,b,client,server,received
 const id='ps:'+'ab'.repeat(32),packet={share:{poolShareId:id},checkpoint:{checkpointId:'cp:'+'cd'.repeat(32)},signerPeerKey:'ef'.repeat(32),signature:'test',proofs:Array.from({length:100},(_,i)=>({i,payload:'x'.repeat(2000)}))}
 try{
  await bootstrap.ready()
  a=new P2PTransport({seed:crypto.randomBytes(32),alias:'isolated-a',topicHex,bootstrap:nodes,onFrame:(p,f)=>{if(f.type==='mining-pool-share-page')void client.accept(p,f)}})
  b=new P2PTransport({seed:crypto.randomBytes(32),alias:'isolated-b',topicHex,bootstrap:nodes,onFrame:(p,f)=>{if(f.type==='mining-pool-share-request')server.serve(p,f)}})
  client=new HistorySync({send:(p,f)=>a.send(p,f),known:()=>false,getPacket:()=>null,receive:async(p,value)=>{received=value}})
  server=new HistorySync({send:(p,f)=>b.send(p,f),known:()=>false,getPacket:id=>packet,receive:async()=>{}})
  client.start();server.start()
  const deadline=Date.now()+45000
  await Promise.race([Promise.all([a.start(),b.start()]),delay(45000).then(()=>{throw Error('DHT startup timed out')})])
  while(Date.now()<deadline&&!a.connected(b.peerKey))await delay(100)
  assert.ok(a.connected(b.peerKey),'private DHT peers connected')
  client.request(b.peerKey,id)
  while(Date.now()<deadline&&!received)await delay(100)
  assert.deepEqual(received,packet)
  console.log('PASS: two peers discovered through local-only bootstrap and transferred a multi-page bundle.')
 }finally{client?.stop();server?.stop();await Promise.allSettled([a?.close(),b?.close()]);await bootstrap.destroy({force:true})}
}
if(require.main===module)main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})
