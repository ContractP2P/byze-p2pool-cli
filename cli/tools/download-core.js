#!/usr/bin/env node
'use strict'

const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto')
const {execFileSync}=require('child_process')
const TAG='v0.3.0-stateless-pq'
const FINGERPRINT='9F11E836EB4B7F464ADBB1E7AC11CA674828CAE1'
const BASE=`https://github.com/powhermes/byze/releases/download/${TAG}/`
const ASSETS={
 'linux-x64':{name:'byze-core-linux-x86_64.tar.gz',sha256:'6278412d3376b653172bd2f4c84d21af513526feba30d9363b5f3efb2707e0c2'},
 'darwin-arm64':{name:'byze-core-macos-arm64.zip',sha256:'5693e22bf4cb9b51293f149852ff342e577de5fee6b422659c758c64cac75267'},
 'darwin-x64':{name:'byze-core-macos-x86_64.zip',sha256:'af471b282c1f1d75ea3830c63332b7db78f91ed0ca7ba0895269e3c88f6a389c'},
 'win32-x64':{name:'byze-core-windows-x86_64.zip',sha256:'2d106213a3a287b810665aadd86d0757f045b62c300c7811e3facf3aac961465'}
}
function checksumFor(text,name){
 const matches=String(text).split(/\r?\n/).map(line=>/^([0-9a-f]{64}) [ *](\S+)$/.exec(line)).filter(m=>m&&m[2]===name)
 if(matches.length!==1)throw new Error('Missing or duplicate archive checksum')
 return matches[0][1]
}
function validSignature(status){
 return String(status).split(/\r?\n/).some(line=>{
  const fields=line.trim().split(/\s+/)
  return fields[0]==='[GNUPG:]'&&fields[1]==='VALIDSIG'&&(fields[2]===FINGERPRINT||fields[11]===FINGERPRINT)
 })
}
async function download(url,file,maxBytes){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),180000)
 let handle
 try{
  const response=await fetch(url,{signal:controller.signal})
  if(!response.ok||!response.url.startsWith('https://'))throw new Error('Core download failed')
  if(Number(response.headers.get('content-length'))>maxBytes)throw new Error('Core download exceeds size limit')
  handle=await fs.promises.open(file,'wx',0o600)
  let bytes=0
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>maxBytes)throw new Error('Core download exceeds size limit');await handle.writeFile(chunk)}
 }finally{clearTimeout(timer);await handle?.close()}
}
async function downloadCore({destination,platform=`${process.platform}-${process.arch}`,fetchFile=download,run=execFileSync}={}){
 const asset=ASSETS[platform]
 if(!asset)throw new Error(`Unsupported Core platform: ${platform}`)
 if(!destination)throw new Error('Use --dest with a new directory (parent must exist)')
 const dest=path.resolve(destination)
 // Exclusive directory creation prevents replacing an existing node or download.
 fs.mkdirSync(dest,{mode:0o700})
 let home
 try{
  home=fs.mkdtempSync(path.join(os.tmpdir(),'byze-core-gpg-'));fs.chmodSync(home,0o700)
  const gpg=args=>run('gpg',['--no-options','--homedir',home,'--batch','--no-autostart','--no-auto-key-retrieve',...args],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']})
  gpg(['--version'])
  for(const name of ['SHA256SUMS','SHA256SUMS.asc','byze-release-signing-key.asc'])await fetchFile(BASE+name,path.join(dest,name),65536)
  const keyring=path.join(home,'release.gpg')
  gpg(['--dearmor','--output',keyring,path.join(dest,'byze-release-signing-key.asc')])
  const status=gpg(['--no-default-keyring','--keyring',keyring,'--trust-model','always','--status-fd','1','--verify',path.join(dest,'SHA256SUMS.asc'),path.join(dest,'SHA256SUMS')])
  if(!validSignature(status))throw new Error('Checksum signature does not match the pinned release key')
  if(checksumFor(fs.readFileSync(path.join(dest,'SHA256SUMS'),'utf8'),asset.name)!==asset.sha256)throw new Error('Signed checksum differs from pinned v0.3.0 archive')
  const partial=path.join(dest,asset.name+'.partial')
  await fetchFile(BASE+asset.name,partial,64*1024*1024)
  const hash=crypto.createHash('sha256')
  for await(const chunk of fs.createReadStream(partial))hash.update(chunk)
  if(hash.digest('hex')!==asset.sha256)throw new Error('Core archive checksum mismatch')
  fs.renameSync(partial,path.join(dest,asset.name))
  return {archive:path.join(dest,asset.name),sha256:asset.sha256,tag:TAG,fingerprint:FINGERPRINT}
 }catch(error){fs.rmSync(dest,{recursive:true,force:true});throw error}
 finally{if(home)fs.rmSync(home,{recursive:true,force:true})}
}
async function main(){
 const args=process.argv.slice(2)
 if(args.includes('--help')){console.log('Usage: npm run core:download -- --dest NEW_DIRECTORY [--platform linux-x64|darwin-arm64|darwin-x64|win32-x64]\nRequires GnuPG. Downloads and verifies v0.3.0; does not extract, start or replace a node.');return}
 let destination,platform
 for(let i=0;i<args.length;i+=2){if(!args[i+1]||args[i+1].startsWith('--'))throw Error('Missing option value');if(args[i]==='--dest')destination=args[i+1];else if(args[i]==='--platform')platform=args[i+1];else throw Error('Unknown option')}
 const result=await downloadCore({destination,platform});console.log(`Verified ${result.tag}: ${result.archive}\nSHA-256: ${result.sha256}\nGPG: ${result.fingerprint}`)
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1})
module.exports={TAG,FINGERPRINT,ASSETS,checksumFor,validSignature,downloadCore}
