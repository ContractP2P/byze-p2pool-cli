#!/usr/bin/env node
'use strict'
// An executable byze-cli-shaped transport over the *strictly read-only*
// Mac operator relay. No Core cookie or wallet credentials are copied into VM.
const http = require('node:http')

const METHODS = new Set([
  'getblockchaininfo', 'getbestblockhash', 'getblockhash', 'getblockheader',
  'getblock', 'getrawtransaction', 'getblocktemplate', 'decoderawtransaction',
  'validateaddress', 'getaddressinfo'
])

function decodeParams(method, args) {
  return args.map((x, i) => {
    if (method === 'getblocktemplate' && i === 0) return JSON.parse(x)
    if (method === 'getblockhash' && i === 0) {
      if (!/^\d{1,8}$/.test(x)) throw Error('Bad block height')
      return Number(x)
    }
    if (method === 'getblock' && i === 1) {
      if (!/^[012]$/.test(x)) throw Error('Bad verbosity')
      return Number(x)
    }
    if (method === 'getrawtransaction' && i === 1) {
      if (x !== 'true') throw Error('Bad transaction verbosity')
      return true
    }
    return x
  })
}

async function callRelay({argv = process.argv.slice(2), env = process.env} = {}) {
  const [method, ...args] = argv
  if (!METHODS.has(method)) throw Error('RPC method not permitted by lab bridge')
  const token = env.BYZE_LAB_RELAY_TOKEN || ''
  if (token.length < 32 || token.length > 256) throw Error('Missing lab bridge authorization')
  const url = new URL(env.BYZE_LAB_RELAY_URL || 'http://100.96.0.1:18755/rpc')
  // This is deliberately a host-local encrypted-SSH-tunnel service only,
  // never arbitrary HTTP(S) destinations, URLs or public node access.
  if (url.protocol !== 'http:' || !['100.96.0.1', '127.0.0.1'].includes(url.hostname) ||
      url.pathname !== '/rpc' || url.search || url.hash ||
      !/^\d+$/.test(url.port) || Number(url.port) < 1024 ||
      Number(url.port) > 65535 || url.username || url.password) {
    throw Error('Unsupported local-only RPC bridge URL')
  }
  const body = JSON.stringify({method, params:decodeParams(method, args)})
  if (Buffer.byteLength(body) > 65536) throw Error('Lab bridge request size exceeded')
  return await new Promise((resolve, reject) => {
    const req = http.request(url, {
      method:'POST', timeout:30000,
      headers: {
        'Content-Type':'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + token
      }
    }, (res) => {
      let bytes=0, chunks=[]
      res.on('data', b => {
        bytes += b.length
        if (bytes > 24*1024*1024) { req.destroy(Error('Lab bridge response too large')); return }
        chunks.push(b)
      })
      res.on('end', () => {
        try {
          const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (res.statusCode !== 200 || !payload || payload.ok !== true ||
              !Object.prototype.hasOwnProperty.call(payload,'result')) {
            throw Error('Read-only Core relay refused request')
          }
          resolve(payload.result)
        } catch (_) { reject(Error('Invalid Core relay response')) }
      })
    })
    req.on('timeout', () => req.destroy(Error('RPC relay deadline exceeded')))
    req.on('error', () => reject(Error('RPC relay unavailable')))
    req.end(body)
  })
}

if (require.main === module) {
  callRelay().then(data => {
    process.stdout.write(JSON.stringify(data) + '\n')
  }).catch(err => {
    // Never display bearer token, Core cookie, or raw backend stderr.
    process.stderr.write('BYZE_LAB_RPC_ERROR: ' + err.message + '\n')
    process.exitCode=1
  })
}
module.exports={METHODS,decodeParams,callRelay}
