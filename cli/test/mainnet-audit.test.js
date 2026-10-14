'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { toSats, scriptMatches } = require('../tools/audit-mainnet-coinbase')
const policy = require('../config/pool-policy.json')

test('auditor converts small scientific-notation coinbase outputs to exact satoshis', () => {
  assert.equal(toSats(1e-8), 1n)
  assert.equal(toSats(0.25), 25000000n)
  assert.equal(toSats(49.75), 4975000000n)
  assert.throws(() => toSats(-1))
  assert.throws(() => toSats(1e-10))
})

test('auditor matches fee by output script when Core omits address text', () => {
  const program = '5120' + 'ab'.repeat(32)
  assert.equal(scriptMatches({scriptPubKey:{hex:program}},policy.feeAddress,program),true)
  assert.equal(scriptMatches({scriptPubKey:{hex:program}},policy.feeAddress,'5120'+'cc'.repeat(32)),false)
})

test('auditor uses read-only mainnet RPC and flags fee-bearing coinbase as candidate, not proof', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'byze-audit-fixture-'))
  try {
    const mock = path.join(temp,'byze-cli')
    fs.writeFileSync(mock, `#!/usr/bin/env node
const method=process.argv[2]
if(method==='getblockchaininfo') console.log(JSON.stringify({chain:'main',initialblockdownload:false,blocks:10}))
else if(method==='validateaddress') console.log(JSON.stringify({isvalid:true,scriptPubKey:'5120'+'ab'.repeat(32)}))
else if(method==='getblockhash') console.log(JSON.stringify(process.argv[3]==='10'?'aa'.repeat(32):'bb'.repeat(32)))
else if(method==='getblock') {
 const time=process.argv[3]==='aa'.repeat(32)?Date.parse('2026-10-13T10:00:00Z')/1000:Date.parse('2026-10-12T10:00:00Z')/1000
 console.log(JSON.stringify({time,tx:[{txid:'cc'.repeat(32),vin:[{coinbase:'abcd'}],vout:[
   {n:0,value:49.75,scriptPubKey:{hex:'5120'+'cd'.repeat(32)}},
   {n:1,value:0.25,scriptPubKey:{hex:'5120'+'ab'.repeat(32)}}
 ]}]}))
} else { console.error('Unexpected RPC',method);process.exit(2) }
`,{mode:0o755})
    const script = path.join(__dirname,'../tools/audit-mainnet-coinbase.js')
    const run=spawnSync(process.execPath,[script,`--cli=${mock}`,'--from=2026-10-13','--to=2026-10-15','--max=100'],
      {encoding:'utf8',timeout:30000})
    assert.equal(run.status,0,run.stderr)
    const audit=JSON.parse(run.stdout)
    assert.equal(audit.scanned,1)
    assert.equal(audit.candidates.length,1)
    assert.equal(audit.candidates[0].paidFeeSats,'25000000')
    assert.equal(audit.candidates[0].approximateFeeMatch,true)
    assert.match(audit.scope,/DOES NOT certify/)
  }finally{fs.rmSync(temp,{recursive:true,force:true})}
})
