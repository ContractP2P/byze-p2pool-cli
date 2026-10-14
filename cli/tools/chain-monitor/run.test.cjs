'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process')
test('dry-run processes a synthetic decoded chain and never posts or persists',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'byze-monitor-fixture-'))
  try{
    const preload=path.join(dir,'fetch.cjs'),evidence=path.join(dir,'evidence.json')
    fs.writeFileSync(preload, `global.fetch = async url => {
      const pathname = new URL(String(url)).pathname;
      if(pathname==='/test/tip') return new Response(JSON.stringify({chain:'main',blocks:100}),{status:200});
      const m=/^\\/test\\/block\\/(\\d+)$/.exec(pathname);
      if(!m) throw Error('Unexpected external request: '+pathname);
      const h=Number(m[1]);
      const fee=${JSON.stringify(require('../../config/pool-policy.json').feeAddress)};
      const vout=h===90?[{value:0.25,scriptPubKey:{address:fee}},{value:49.75,scriptPubKey:{address:'other'}}]:[{value:50,scriptPubKey:{address:'other'}}];
      return new Response(JSON.stringify({height:h,hash:h.toString(16).padStart(64,'0'),time:1792000000,tx:[{txid:'b'.repeat(64),vin:[{coinbase:'01'}],vout}]}),{status:200});
    }`)
    const proc=cp.spawnSync(process.execPath,['--require',preload,path.join(__dirname,'run.cjs')],{encoding:'utf8',timeout:10000,env:{...process.env,NODE_OPTIONS:'',MONITOR_DRY_RUN:'true',GITHUB_TOKEN:'',DISCORD_WEBHOOK_URL:'',BYZE_TIP_URL:'https://explorer.byze.org/test/tip',BYZE_BLOCK_URL_TEMPLATE:'https://explorer.byze.org/test/block/{id}',BYZE_EVIDENCE_FILE:evidence}})
    assert.equal(proc.status,0,proc.stderr)
    const report=JSON.parse(fs.readFileSync(evidence,'utf8'))
    assert.equal(report.candidates.length,1)
    assert.equal(report.candidates[0].height,90)
    assert.deepEqual(report.newCandidates,[(90).toString(16).padStart(64,'0')])
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
})

test('manual force_activity sends a live activity report despite hourly deduplication',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'byze-monitor-force-fixture-'))
  try {
    const preload=path.join(dir,'fetch.cjs'),messages=path.join(dir,'messages.jsonl')
    const activity=path.join(dir,'activity.json')
    const state={schema:1,lastHeight:100,blocks:{},seen:[],lastReportAt:0,lastActivityAt:Date.now(),publishedBlocks:[]}
    fs.writeFileSync(activity,JSON.stringify({schema:1,source:'hyperswarm-partial',
      observedAt:new Date().toISOString(),connectedPeers:1,validPresences:1,activeMiners:1,
      hashrateSamples:1,observedHashrateHps:2860}))
    fs.writeFileSync(preload,`const fs=require('node:fs');
      const issueBody='<!-- byze-p2pool-chain-monitor-state-v1 -->\\n'+JSON.stringify(${JSON.stringify(state)});
      global.fetch=async (url,opts={})=>{
        const u=new URL(String(url)),method=opts.method||'GET';
        if(u.hostname==='discord.com'&&method==='POST'){
          fs.appendFileSync(${JSON.stringify(messages)},String(opts.body)+'\\n');
          return new Response(null,{status:204});
        }
        if(u.hostname==='api.github.com'){
          if(u.pathname.endsWith('/issues')&&method==='GET')
            return new Response(JSON.stringify([{number:24,title:'BYZE P2Pool chain-monitor state (automated)',body:issueBody}]),{status:200});
          if(u.pathname.endsWith('/issues/24')&&method==='PATCH')
            return new Response(JSON.stringify({number:24}),{status:200});
        }
        if(u.pathname==='/test/tip')
          return new Response(JSON.stringify({chain:'main',blocks:100}),{status:200});
        const m=/^\\/test\\/block\\/(\\d+)$/.exec(u.pathname);
        if(!m)throw Error('Unexpected URL '+u.pathname);
        const h=Number(m[1]);
        return new Response(JSON.stringify({height:h,hash:h.toString(16).padStart(64,'0'),
          time:1792000000,tx:[{txid:'b'.repeat(64),vin:[{coinbase:'01'}],
          vout:[{value:50,scriptPubKey:{address:'other'}}]}]}),{status:200});
      };`)
    const env={...process.env,NODE_OPTIONS:'',MONITOR_DRY_RUN:'false',MONITOR_FORCE_ACTIVITY:'false',
      GITHUB_TOKEN:'test-token',GITHUB_REPOSITORY:'ContractP2P/byze-p2pool-cli',
      DISCORD_WEBHOOK_URL:'https://discord.com/api/webhooks/123/test-token',
      BYZE_TIP_URL:'https://explorer.byze.org/test/tip',
      BYZE_BLOCK_URL_TEMPLATE:'https://explorer.byze.org/test/block/{id}',
      BYZE_ACTIVITY_FILE:activity}
    const run=(vars)=>cp.spawnSync(process.execPath,['--require',preload,path.join(__dirname,'run.cjs')],
      {encoding:'utf8',timeout:10000,env:{...env,...vars}})
    const normal=run({})
    assert.equal(normal.status,0,normal.stderr)
    assert.equal(fs.existsSync(messages),false,'hourly dedup must remain active')
    const forced=run({MONITOR_FORCE_ACTIVITY:'true'})
    assert.equal(forced.status,0,forced.stderr)
    const sent=fs.readFileSync(messages,'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(sent.length,1)
    assert.match(sent[0].content,/\*\*1\*\* Active miners/)
    assert.match(sent[0].content,/\*\*~2\.86 kH\/s\*\* Hashrate/)
    assert.deepEqual(sent[0].allowed_mentions,{parse:[]})
    const dry=run({MONITOR_FORCE_ACTIVITY:'true',MONITOR_DRY_RUN:'true'})
    assert.equal(dry.status,0,dry.stderr)
    assert.equal(fs.readFileSync(messages,'utf8').trim().split('\n').length,1,'dry run must not post')
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
