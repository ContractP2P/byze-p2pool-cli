'use strict'
// Discover a usable BYZE Core RPC *client*, not necessarily a local daemon.
// Never downloads, installs or starts a daemon, and never touches wallet data.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { assertMainnetReady } = require('./security-hardening')

function executable(file) {
  if (typeof file !== 'string' || !file.trim()) return false
  try {
    const stat = fs.statSync(file)
    fs.accessSync(file, fs.constants.X_OK)
    return stat.isFile()
  } catch { return false }
}

function candidates({explicit, env=process.env, home=os.homedir(),
                     platform=process.platform, pathValue=env.PATH || ''}={}) {
  const binary = platform === 'win32' ? 'byze-cli.exe' : 'byze-cli'
  // An explicitly selected client must never silently fall back to another
  // binary, especially one with a different RPC config or wallet.
  if (explicit !== undefined) return [{path:String(explicit),source:'explicit'}]
  if (env.BYZE_CLI !== undefined) return [{path:String(env.BYZE_CLI),source:'BYZE_CLI'}]
  const result = []
  const seen = new Set()
  const add = (value,source) => {
    if (!value || seen.has(path.resolve(value))) return
    seen.add(path.resolve(value))
    result.push({path:value,source})
  }
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    // Ignore empty PATH components (current directory) when searching RPC clients.
    if (!path.isAbsolute(dir)) continue
    add(path.join(dir,binary),'PATH')
  }
  for (const suffix of [
    ['ldev','byze','build','bin'],
    ['byze','build','bin'],
    ['Downloads','byze','build','bin'],
    ...(platform === 'win32' ? [['ldev','byze','build','bin','Release']] : [])
  ]) add(path.join(home,...suffix,binary),'known-path')
  return result
}

async function inspectNode({explicit,env,home,platform,pathValue,call,
                             readiness=assertMainnetReady}={}) {
  if (typeof call !== 'function') throw new TypeError('RPC probe required')
  const entries = candidates({explicit,env,home,platform,pathValue})
  const observations=[]
  let available = 0
  for (const entry of entries) {
    if (!executable(entry.path)) {
      if (entry.source === 'explicit' || entry.source === 'BYZE_CLI') {
        observations.push({...entry,status:'client-missing'})
      }
      continue
    }
    available += 1
    try {
      const info = await call(entry.path,'getblockchaininfo')
      const checked = readiness(info)
      if (checked.ok) return {
        status:'ready',path:entry.path,source:entry.source,chain:checked.chain,
        blocks:checked.blocks,headers:checked.headers,observations,
        // byze-cli may be pointed at a remote node via config or RPC flags.
        endpointLocality:'unknown'
      }
      observations.push({...entry,status:'not-ready',code:checked.code})
    } catch(error) {
      // Never echo stderr: it may contain RPC URLs/credentials.
      observations.push({...entry,status:'rpc-unreachable',
                         code:error?.code === 'ETIMEDOUT' ? 'timeout' : 'rpc-error'})
    }
    if (entry.source === 'explicit' || entry.source === 'BYZE_CLI') break
  }
  return {
    status:available ? 'not-ready' : 'client-missing',
    observations,endpointLocality:'unknown'
  }
}

function operatorGuidance(result) {
  if (result.status === 'ready') {
    return 'Existing BYZE Core endpoint is healthy. No installation or node startup required.'
  }
  if (result.status === 'client-missing') {
    return 'No usable byze-cli executable found. Specify --byze-cli PATH; if no Core client is installed, use the verified, consent-only archive downloader. A synchronized node is still required.'
  }
  return 'BYZE Core client exists but RPC is unavailable, on the wrong chain, or not synchronized. Repair or configure this node first; installing another node would risk duplication.'
}

module.exports={candidates,executable,inspectNode,operatorGuidance}
