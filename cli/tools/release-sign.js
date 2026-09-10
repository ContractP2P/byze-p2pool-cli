#!/usr/bin/env node
'use strict'
const fs=require('fs')
const path=require('path')
const crypto=require('crypto')
function arg(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:''}
const manifest=path.resolve(arg('--manifest')||'')
const key=path.resolve(arg('--private-key')||'')
const out=path.resolve(arg('--out')||`${manifest}.sig`)
if(!manifest||!key||!fs.existsSync(manifest)||!fs.existsSync(key)){console.error('Usage: node tools/release-sign.js --manifest release-manifest.json --private-key /offline/release-ed25519.pem [--out file.sig]');process.exit(2)}
const privateKey=crypto.createPrivateKey(fs.readFileSync(key))
if(privateKey.asymmetricKeyType!=='ed25519')throw new Error('Release key must be Ed25519')
const signature=crypto.sign(null,fs.readFileSync(manifest),privateKey)
fs.writeFileSync(out,signature.toString('base64')+'\n',{mode:0o644})
console.log(out)
