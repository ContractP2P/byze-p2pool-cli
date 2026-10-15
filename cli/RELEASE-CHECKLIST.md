# BYZE P2Pool CLI release checklist

## Blocking public-release gates

- [x] Public launcher never auto-builds from an arbitrary local checkout.
- [x] Developer native build requires the pinned upstream Git commit and a clean checkout.
- [x] Runtime native manifest requires the same pinned upstream source commit.
- [x] Public pool requires BYZE `chain=main` and `initialblockdownload=false`.
- [x] Block submission re-checks mainnet readiness immediately before publication.
- [x] Per-peer frame/byte/expensive-message rate limits and temporary blocking are enabled.
- [x] Expensive inbound validation concurrency/queue size is bounded.
- [x] Pre-presence history buffering is bounded per peer and globally.
- [x] Experimental complete prebuilt native CLI/RandomX bundles published for every **advertised community-test** platform (Linux x64, macOS arm64 and x64; 15 October 2026). **Not** a production-signing gate.
- [ ] Native manifest/release artefacts signed by the dedicated offline release key.
- [x] Upstream MIT and RandomX BSD notices retained; pinned source compared with licensed upstream tree.
- [ ] All packaged native bundles include `THIRD_PARTY-NOTICES.md` and `licenses/`.
- [x] CLI source license: MIT (`LICENSE` at repository root and `cli/LICENSE`; third-party notices remain separate).
- [ ] End-to-end mainnet soak: generation-v6 CLI A ↔ CLI B on an isolated test network before a coordinated mainnet RC.
- [ ] At least one real found block validated for exact PPLNS + 0.50% fee payout.

## Release quality

- [x] `npm ci`
- [x] `npm run check`
- [x] `npm test`
- [x] source-RC preflight
- [ ] public-release preflight (must fail while any blocking gate above remains)
- [x] CI green on Linux, macOS and Windows (source tests on Node.js 20/22; not native miner validation)
- [ ] `npm audit --omit=dev` succeeds against the live npm registry (audit environment DNS was unavailable).
- [x] Published experimental `.tar.gz` archives have final `SHA256SUMS`, independently pinned in guided installers and tested against altered downloads (15 October 2026). This does **not** meet the separate unsigned-release signing gate.

**Status distinction:** the 15 October 2026 `v0.2.5-rc3-rpc-recovery-test1` bundles and their checksums are public **Experimental Test 1** artefacts. Their availability closes the community-test packaging task only; unchecked items above (including native signatures/notarization where applicable, full multi-peer evidence, exact PPLNS payouts and package notice review) still block a stable production release. An administratively closed tracking issue is not evidence of a passed test.
