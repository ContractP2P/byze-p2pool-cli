#!/usr/bin/env node
'use strict'
const fs=require('fs')
const path=require('path')
const crypto=require('crypto')
function arg(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:''}
const manifest=path.resolve(arg('--manifest')||'')
const signatureFile=path.resolve(arg('--signature')||'')
const key=path.resolve(arg('--public-key')||'')
if(!manifest||!signatureFile||!key||![manifest,signatureFile,key].every(fs.existsSync)){console.error('Usage: node tools/release-verify.js --manifest release-manifest.json --signature release-manifest.json.sig --public-key release-ed25519.pub.pem');process.exit(2)}
const publicKey=crypto.createPublicKey(fs.readFileSync(key))
if(publicKey.asymmetricKeyType!=='ed25519')throw new Error('Release public key must be Ed25519')
const sig=Buffer.from(String(fs.readFileSync(signatureFile,'utf8')).trim(),'base64')
const ok=crypto.verify(null,fs.readFileSync(manifest),publicKey,sig)
console.log(ok?'Release signature: OK':'Release signature: INVALID')
process.exitCode=ok?0:3
