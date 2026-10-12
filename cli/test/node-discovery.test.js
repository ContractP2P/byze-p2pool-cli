'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {spawnSync} = require('node:child_process')
const {candidates,inspectNode,operatorGuidance} = require('../src/node-discovery')

function fixture(fn) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'p2pool-core-detect-'))
  try {return fn(root)} finally {fs.rmSync(root,{recursive:true,force:true})}
}
function mockCli(folder,basename='byze-cli') {
  const filename=path.join(folder,basename)
  fs.writeFileSync(filename,'#!/bin/sh\necho "{\"chain\":\"main\",\"initialblockdownload\":false,\"blocks\":1250,\"headers\":1250}"\n',{mode:0o700})
  fs.chmodSync(filename,0o700)
  return filename
}

test('select existing ready client, do not install/start any daemon, and keep locality unknown',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'p2pool-ready-'))
  try {
    const bin=mockCli(root)
    let probed=0
    const res=await inspectNode({
      explicit:bin,
      call:async (found,method)=>{
        probed++;assert.equal(found,bin);assert.equal(method,'getblockchaininfo')
        return {chain:'main',initialblockdownload:false,blocks:120,headers:120}
      }
    })
    assert.equal(res.status,'ready');assert.equal(res.path,bin)
    assert.equal(res.endpointLocality,'unknown')
    assert.equal(probed,1)
    assert.match(operatorGuidance(res),/No installation/)
  }finally{fs.rmSync(root,{recursive:true,force:true})}
})

test('explicit missing client never falls back to PATH or known local checkout',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'p2pool-node-explicit-'))
  try{
    const working=mockCli(root)
    const missing=path.join(root,'absent-byze-cli')
    const listed=candidates({explicit:missing,env:{PATH:root},home:root})
    assert.deepEqual(listed,[{path:missing,source:'explicit'}])
    const res=await inspectNode({explicit:missing,env:{PATH:root},
       call:async()=>{throw Error('must never make RPC calls')}})
    assert.equal(res.status,'client-missing')
    assert.equal(res.observations[0].path,missing)
    assert.notEqual(res.observations[0].path,working)
  }finally{fs.rmSync(root,{recursive:true,force:true})}
})

test('unhealthy Core and failed RPC are diagnosed but never considered ready',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'p2pool-node-unhealthy-'))
  try{
    const bin=mockCli(root)
    const bad=[
      {chain:'test',initialblockdownload:false,blocks:10,headers:10},
      {chain:'main',initialblockdownload:true,blocks:10,headers:10},
      {chain:'main',initialblockdownload:false,blocks:10,headers:100}
    ]
    for(const chain of bad) {
      const res=await inspectNode({explicit:bin,call:async()=>chain})
      assert.equal(res.status,'not-ready')
      assert.equal(res.observations[0].status,'not-ready')
      assert.match(operatorGuidance(res),/Repair or configure/)
    }
    const down=await inspectNode({explicit:bin,call:async()=>{throw Error('rpcpassword=DO_NOT_LEAK')}})
    assert.equal(down.status,'not-ready')
    assert.equal(down.observations[0].status,'rpc-unreachable')
    assert.doesNotMatch(JSON.stringify(down),/DO_NOT_LEAK/)
  }finally{fs.rmSync(root,{recursive:true,force:true})}
})

test('auto mode skips disconnected local client when another eligible Core client is ready',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'p2pool-node-auto-'))
  try{
    const first=path.join(root,'first'),second=path.join(root,'second')
    fs.mkdirSync(first);fs.mkdirSync(second)
    const old=mockCli(first),good=mockCli(second)
    const result=await inspectNode({
      env:{PATH:first+path.delimiter+second},home:path.join(root,'nohome'),
      call:async found=>{
        if(found===old)throw Error('not connected')
        if(found===good)return {chain:'main',initialblockdownload:false,blocks:100,headers:100}
        throw Error('unexpected file')
      }
    })
    assert.equal(result.status,'ready')
    assert.equal(result.path,good)
    assert.equal(result.observations.length,1)
  }finally{fs.rmSync(root,{recursive:true,force:true})}
})

test('real CLI --check-node diagnoses existing executable without wallet or prompt',()=>{
  if (process.platform==='win32') return
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'p2pool-node-cli-'))
  try{
    const cli=mockCli(root)
    const result=spawnSync(process.execPath,
      [path.join(__dirname,'..','src','byze-p2pool.js'),'--check-node','--byze-cli',cli],
      {encoding:'utf8',timeout:9000,env:{...process.env, BYZE_CLI:undefined}})
    assert.equal(result.status,0,result.stderr)
    assert.match(result.stdout,/BYZE_NODE_READY/)
    assert.match(result.stdout,/blocks: 1250/)
    assert.match(result.stdout,/Local\/remote daemon: unknown/)
  }finally{fs.rmSync(root,{recursive:true,force:true})}
})

test('no install/acquisition side effects for noninteractive --setup-core',()=>{
  if(process.platform==='win32')return
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'p2pool-node-setup-'))
  try{
    const home=path.join(root,'home')
    fs.mkdirSync(home)
    const result=spawnSync(process.execPath,
      [path.join(__dirname,'..','src','byze-p2pool.js'),'--setup-core','--byze-cli',path.join(root,'missing')],
      {encoding:'utf8',timeout:9000,env:{...process.env,HOME:home}})
    assert.notEqual(result.status,0)
    assert.match(result.stderr,/requires an interactive terminal/)
    assert.deepEqual(fs.readdirSync(home),[])
  }finally{fs.rmSync(root,{recursive:true,force:true})}
})
