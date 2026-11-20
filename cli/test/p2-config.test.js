'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path')
const {parseBootstrap,dhtOptions}=require('../src/dht-config')
const {loadPoolFeePolicy,OFFICIAL_POOL_FEE_ADDRESS}=require('../src/mining/pool-fee-policy')
const {checksumFor,validSignature,downloadCore,FINGERPRINT,ASSETS,TAG}=require('../tools/download-core')
test('explicit DHT configuration replaces bootstrap and known nodes without fallback',()=>{
 assert.deepEqual(dhtOptions(parseBootstrap(undefined)),{})
 assert.deepEqual(dhtOptions(parseBootstrap('none')),{bootstrap:[],nodes:[]})
 assert.deepEqual(dhtOptions(parseBootstrap('127.0.0.1:49737,seed.example:49738')),{bootstrap:['127.0.0.1:49737','seed.example:49738'],nodes:[]})
 for(const value of ['', ' ','localhost','localhost:0','localhost:65536','http://localhost:123','localhost:10,','--wallet',Array(10).fill('host:1').join(',')])assert.throws(()=>parseBootstrap(value))
})
test('official v0.3 Core downloads are pinned to GitHub release digests',()=>{
 assert.equal(TAG,'v0.3.0-stateless-pq')
 assert.equal(ASSETS['darwin-arm64'].sha256,'5693e22bf4cb9b51293f149852ff342e577de5fee6b422659c758c64cac75267')
 assert.equal(ASSETS['linux-x64'].sha256,'6278412d3376b653172bd2f4c84d21af513526feba30d9363b5f3efb2707e0c2')
 assert.equal(ASSETS['darwin-x64'].sha256,'af471b282c1f1d75ea3830c63332b7db78f91ed0ca7ba0895269e3c88f6a389c')
})

test('obsolete fee environment override cannot change official fee policy',()=>{
 assert.equal(loadPoolFeePolicy({env:{CONTRACT_BYZE_POOL_FEE_ADDRESS:'byz1other0000000'}}).feeAddress,OFFICIAL_POOL_FEE_ADDRESS)
})
test('Core verification requires an exact signed checksum and pinned key fingerprint',()=>{
 const asset=ASSETS['linux-x64']
 assert.equal(checksumFor(`${asset.sha256}  ${asset.name}\n`,asset.name),asset.sha256)
 assert.throws(()=>checksumFor(`${asset.sha256}  ${asset.name}\n${asset.sha256}  ${asset.name}`,asset.name))
 assert.throws(()=>checksumFor(`${asset.sha256}  ../${asset.name}`,asset.name))
 assert.equal(validSignature(`[GNUPG:] VALIDSIG ${FINGERPRINT} 2026-10-05 1 0 4 0 22 8 00 ${FINGERPRINT}`),true)
 assert.equal(validSignature(`[GNUPG:] GOODSIG ${FINGERPRINT}`),false)
 assert.equal(validSignature('[GNUPG:] VALIDSIG '+'F'.repeat(40)),false)
})
test('Core downloader refuses existing directories and removes incomplete verification output',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'byze-download-test-'))
 try{
  const keep=path.join(root,'wallet.dat');fs.writeFileSync(keep,'preserve')
  await assert.rejects(downloadCore({destination:root}),/EEXIST/)
  assert.equal(fs.readFileSync(keep,'utf8'),'preserve')
  const dest=path.join(root,'new'),asset=ASSETS['linux-x64']
  const fetchFile=async(url,file)=>fs.writeFileSync(file,url.endsWith('SHA256SUMS')?`${asset.sha256}  ${asset.name}\n`:'bad')
  await assert.rejects(downloadCore({destination:dest,platform:'linux-x64',fetchFile,run:()=>''}),/pinned release key/)
  assert.equal(fs.existsSync(dest),false)
  await assert.rejects(downloadCore({destination:dest,platform:'linux-x64',fetchFile,run:()=>`[GNUPG:] VALIDSIG ${FINGERPRINT}`}),/archive checksum mismatch/)
  assert.equal(fs.existsSync(dest),false)
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})

test('CLI executable version agrees with package and compatibility metadata',()=>{
 assert.equal(require('../src/byze-p2pool').APP_VERSION,require('../package.json').version)
 assert.equal(require('../COMPATIBILITY.json').cliVersion,require('../package.json').version)
})
