'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const http=require('node:http')
const {callRelay, decodeParams}=require('../tools/byze-lab-remote-cli')

test('relay rejects mutating Core methods and no-token access without network',async()=>{
  const env={BYZE_LAB_RELAY_TOKEN:'x'.repeat(48)}
  for(const method of ['submitblock','signpoolblock','sendtoaddress',
                       'getwalletinfo','setban','stop','-rpcpassword=secret']) {
    await assert.rejects(callRelay({argv:[method],env}),/not permitted/)
  }
  await assert.rejects(callRelay({
    argv:['getblockchaininfo'],env:{}
  }),/authorization/)
  for(const url of ['http://1.2.3.4:18755/rpc','https://127.0.0.1:18755/rpc',
                    'http://127.0.0.1:18755/admin',
                    'http://localhost:18755/rpc']) {
    await assert.rejects(callRelay({argv:['getblockchaininfo'],env:{
      BYZE_LAB_RELAY_TOKEN:'x'.repeat(48),BYZE_LAB_RELAY_URL:url
    }}),/Unsupported local-only/)
  }
})

test('bridge translates BYZE CLI argument semantics without letting requests choose methods',()=>{
  assert.deepEqual(decodeParams('getblockhash',['20930']),[20930])
  assert.deepEqual(decodeParams('getblocktemplate',['{"rules":["segwit"]}']),
                   [{rules:['segwit']}])
  assert.deepEqual(decodeParams('getrawtransaction',['a'.repeat(64),'true','b'.repeat(64)]),
                   ['a'.repeat(64),true,'b'.repeat(64)])
  assert.throws(()=>decodeParams('getblockhash',['../etc/passwd']))
})

test('loopback authenticated relay returns a standard BYZE CLI JSON result',async()=>{
  const token='y'.repeat(48)
  const server=http.createServer((req,res)=>{
    assert.equal(req.method,'POST')
    assert.equal(req.url,'/rpc')
    assert.equal(req.headers.authorization,'Bearer '+token)
    let chunks=[]
    req.on('data',x=>chunks.push(x))
    req.on('end',()=>{
      const msg=JSON.parse(Buffer.concat(chunks).toString())
      assert.deepEqual(msg,{method:'getblockchaininfo',params:[]})
      res.writeHead(200,{'Content-Type':'application/json'})
      res.end(JSON.stringify({ok:true,result:{
        chain:'main',blocks:20930,headers:20930,initialblockdownload:false
      }}))
    })
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const port=server.address().port
    const response=await callRelay({
      argv:['getblockchaininfo'],env:{
        BYZE_LAB_RELAY_TOKEN:token,
        BYZE_LAB_RELAY_URL:'http://127.0.0.1:'+port+'/rpc'
      }
    })
    assert.equal(response.blocks,20930)
  }finally{await new Promise(resolve=>server.close(resolve))}
})
