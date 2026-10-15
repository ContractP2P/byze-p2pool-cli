# Community Test 2: mainnet PPLNS block evidence review (15 October 2026)

**Review:** https://github.com/ContractP2P/byze-p2pool-cli/issues/44

This review records two real BYZE Core mainnet blocks submitted by the Community Test 2 macOS ARM64 CLI. This text is a human-readable audit summary, **not the raw signed P2P source evidence**, and is not a replacement for the repository's full PPLNS attribution verifier.

| | Block 21127 | Block 21128 |
|---|---|---|
| Canonical block hash at operator review | `0000014e9bb4a17987d446a26847dbae9ca4fb4d7ce31b39d061729c8c7cae87` | `00000366f5a606b917a5636b0de59d3b25cd726a51a15dea36ba903c513ab9cd` |
| Coinbase txid | `610acf6fa96c134bddbb2db475c6e8119c8d5ca96de64d189ee2213a61044580` | `136f7d91ba241f56c2e7644e57a4678e343251c78e5ecd1ce17eab7fbfbeceb6` |
| Original privately preserved JSON SHA-256 | `365f51fb8605a0833073bce5c044c6df84116d446c4db87d252a5411de1910ba` | `565baff05f06a815850676248dfbd6ac6d2653342b41b20b900566a564240fba` |
| Signed PoolShare packets captured | 10/10 | 12/12 |
| Local signed RandomX shares captured | 90 | 112 |
| Operator-observed confirmations | 7 | 6 |
| Positive on-chain outputs | 2, matching local script and satoshi amounts | 2, matching local script and satoshi amounts |
| Miner coinbase allocation | 49.75 BYZE | 49.75 BYZE |
| Pool fee allocation (0.5%) | 0.25 BYZE | 0.25 BYZE |

A separately executed native BYZE RandomX verifier returned **112/112 matching unique hashes, zero differences** across the two evidence files. The SHA-256 identifiers, canonical block/parent identities and every positive coinbase output were compared to the operator's live BYZE Core node. A prior offline review checked Ed25519 signatures, PoolShare lineage and payout arithmetic. The 21128 file extends the 21127 PPLNS window (the first ten PoolShares are shared).

**Limits and confidentiality.** Confirmation figures are a snapshot and must be checked again at publication. The RandomX verifier comes from the pinned Community Test 2 native release, not an independently written RandomX engine. Witness-v1 payout-address spendability has not been demonstrated, nor has coinbase maturity (100 blocks). This audit asserts on-chain outputs only, not spendability. Full signed proof packets also contain P2P miner identifiers and complete payout addresses; they remain private until the operator explicitly authorizes their public release.

The automatic Discord monitor **must not attribute** either block on the basis of this summary alone. Its existing verified-attribution gate requires a reviewed source proof file and SHA-256-pinned `cli/config/pool-block-attributions.json` entry, with at least six live confirmations and a fresh chain check. Do not bypass that gate merely to announce results.
