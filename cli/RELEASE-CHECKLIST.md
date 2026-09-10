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
- [ ] Prebuilt native bundle supplied for every advertised platform.
- [ ] Native manifest/release artefacts signed by the dedicated offline release key.
- [ ] Upstream `byze-miner` redistribution/license terms confirmed.
- [x] CLI publication license selected by the owner.
- [ ] End-to-end mainnet soak: CLI A ↔ Contract v0.15.85+ ↔ CLI B.
- [ ] At least one real found block validated for exact PPLNS + 0.50% fee payout.

## Release quality

- [x] `npm ci`
- [x] `npm run check`
- [x] `npm test`
- [x] source-RC preflight
- [ ] public-release preflight (must fail while any blocking gate above remains)
- [ ] CI green on Linux, macOS and Windows
- [ ] `npm audit --omit=dev` succeeds against the live npm registry (audit environment DNS was unavailable).
- [ ] published ZIP SHA-256 generated after final packaging
