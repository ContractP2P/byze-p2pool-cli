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
    const proc=cp.spawnSync(process.execPath,[path.join(__dirname,'run.cjs')],{encoding:'utf8',timeout:10000,env:{...process.env,NODE_OPTIONS:`--require ${preload}`,MONITOR_DRY_RUN:'true',GITHUB_TOKEN:'',DISCORD_WEBHOOK_URL:'',BYZE_TIP_URL:'https://explorer.byze.org/test/tip',BYZE_BLOCK_URL_TEMPLATE:'https://explorer.byze.org/test/block/{id}',BYZE_EVIDENCE_FILE:evidence}})
    assert.equal(proc.status,0,proc.stderr)
    const report=JSON.parse(fs.readFileSync(evidence,'utf8'))
    assert.equal(report.candidates.length,1)
    assert.equal(report.candidates[0].height,90)
    assert.deepEqual(report.newCandidates,[(90).toString(16).padStart(64,'0')])
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
