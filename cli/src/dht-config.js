'use strict'

function parseBootstrap(value) {
  if(value===undefined)return undefined
  if(typeof value!=='string'||!value.trim())throw new Error('--bootstrap requires HOST:PORT[,HOST:PORT] or none')
  if(value==='none')return []
  const nodes=value.split(',').map(x=>x.trim())
  if(nodes.length>8)throw new Error('At most eight bootstrap nodes are allowed')
  for(const node of nodes){
    const match=/^([a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?):([0-9]{1,5})$/.exec(node)
    if(!match||Number(match[2])<1||Number(match[2])>65535||match[1].includes('..'))throw new Error('Invalid bootstrap node: expected HOST:PORT')
  }
  return [...new Set(nodes)]
}
function dhtOptions(bootstrap) {
  if(bootstrap===undefined)return {}
  if(!Array.isArray(bootstrap))throw new Error('Invalid bootstrap configuration')
  const checked=parseBootstrap(bootstrap.length?bootstrap.join(','):'none')
  // HyperDHT has a separate public known-node list; both lists must be replaced.
  return {bootstrap:checked,nodes:[]}
}
module.exports={parseBootstrap,dhtOptions}
