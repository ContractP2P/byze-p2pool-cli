'use strict'

const { blockWeight, MAX_BLOCK_WEIGHT } = require('./block-weight')

function hexBlock(v) {
  const s = String(v || '').toLowerCase()
  return /^[0-9a-f]+$/.test(s) && s.length >= 160 && s.length % 2 === 0 ? s : ''
}

function signedHexFromRpc(v) {
  if (typeof v === 'string') return hexBlock(v)
  for (const k of ['hex', 'blockhex', 'signedblock', 'signedBlockHex']) {
    const h = hexBlock(v?.[k])
    if (h) return h
  }
  return ''
}

async function signPoolBlock(rpc, blockHex) {
  try {
    const result = await rpc('signpoolblock', [blockHex])
    return { ok: true, method: 'signpoolblock', result }
  } catch (error) {
    return { ok: false, code: 'miningQuantumSignerUnavailable', error: String(error?.message || error) }
  }
}

async function publishQuantumBlock({ rpc, candidate, allowSubmit = false, expectedNetwork = 'main', validateProposal = true } = {}) {
  if (typeof rpc !== 'function' || !candidate) return { ok: false, code: 'miningBlockPublisherInvalid' }
  const blockHex = hexBlock(candidate.blockHex)
  if (!blockHex) return { ok: false, code: 'miningBlockCandidateInvalid' }

  let info
  try { info = await rpc('getblockchaininfo', []) }
  catch (error) { return { ok: false, code: 'miningBlockNodeUnavailable', error: String(error?.message || error) } }
  const chain = String(info?.chain || '')
  if (expectedNetwork && chain !== expectedNetwork) return { ok: false, code: 'miningBlockSubmissionNetworkGuard', chain }

  let best = ''
  try { best = String(await rpc('getbestblockhash', [])).toLowerCase() } catch {}
  if (candidate.previousBlockHash && best && best !== String(candidate.previousBlockHash).toLowerCase()) return { ok: false, code: 'miningBlockCandidateStale', chain }
  if (!allowSubmit) return { ok: false, code: 'miningBlockSubmissionDisabled', chain }

  const signed = await signPoolBlock(rpc, blockHex)
  if (!signed.ok) return { ...signed, chain }
  const signedHex = signedHexFromRpc(signed.result)
  if (!signedHex) return { ok: false, code: 'miningQuantumSignerInvalidResult', chain, signerMethod: signed.method }
  if (chain === 'main' && signed.result?.quantum_signed !== true) {
    return { ok: false, code: 'miningQuantumSignatureMissing', chain, signerMethod: signed.method }
  }

  // Check the actual signed serialization as well as the pre-mining budget.
  try {
    if (blockWeight(signedHex) > MAX_BLOCK_WEIGHT) return { ok:false, code:'miningBlockWeightExceeded', chain }
  } catch { return { ok:false, code:'miningBlockSerializationInvalid', chain } }

  if (validateProposal) {
    let proposal
    try { proposal = await rpc('getblocktemplate', [{ mode: 'proposal', data: signedHex, rules: ['segwit'] }]) }
    catch (error) { return { ok: false, code: 'miningBlockProposalCheckFailed', chain, signerMethod: signed.method, error: String(error?.message || error) } }
    if (proposal !== null && proposal !== undefined && proposal !== '') {
      return { ok: false, code: 'miningBlockProposalRejected', chain, signerMethod: signed.method, reason: String(proposal) }
    }
  }

  let result
  try { result = await rpc('submitblock', [signedHex]) }
  catch (error) { return { ok: false, code: 'miningSubmitBlockFailed', chain, signerMethod: signed.method, error: String(error?.message || error) } }
  if (result !== null && result !== undefined && result !== '') return { ok: false, code: 'miningSubmitBlockRejected', chain, signerMethod: signed.method, reason: String(result) }
  return { ok: true, chain, signerMethod: signed.method, quantumSigned: signed.result?.quantum_signed === true, proposalValidated: !!validateProposal, signedBytes: signedHex.length / 2 }
}

module.exports = { publishQuantumBlock, signedHexFromRpc, signPoolBlock }
