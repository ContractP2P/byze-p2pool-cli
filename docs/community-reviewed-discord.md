# Community Test 2 · reviewed Discord reports

Block heights **21127** and **21128** were submitted by BYZE P2Pool Community Test 2 on 2026-10-15.
See the operator evidence review in [issue #44](https://github.com/ContractP2P/byze-p2pool-cli/issues/44) and [PR #45](https://github.com/ContractP2P/byze-p2pool-cli/pull/45).

- The two SHA-256-pinned private submissions contain 10/12 signed PPLNS PoolShare packets and 90/112 local proofs.
- The private operator recomputed **112/112 distinct RandomX hashes**, with no differences.
- Independently queried BYZE Core returned canonical blocks and six or more confirmations, matching each coinbase txid, parent hash, positive coinbase output script, and amount.
- Each block allocated **49.75 BYZE** to its miner and **0.25 BYZE** (0.5%) to the pool.
- Payout-address spendability has **not** been demonstrated. Six confirmations validate the reporting threshold, not the 100-block coinbase maturity threshold.

Any privacy-minimized Discord attribution must identify itself as *operator-reviewed*: it must not claim to make the original signed PoW packets public or independently replayable. Never upload raw submitted-block files or raw P2P keys; publish only independently checked chain facts, approved summaries and masked wallet addresses.

Do not bypass the strict existing `pool-block-attributions.json` gate. Its entries are required to include complete signed source packets. A separately reviewed privacy-preserving reporting path may verify public arithmetic against the live chain and cite the operator review, but must not state that private P2P signature/RandomX provenance was independently replayed by an anonymous public reader.
