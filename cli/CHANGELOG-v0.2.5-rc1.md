# v0.2.5-rc1

Release-hardening candidate based on v0.2.4 global-epoch-v4. Consensus modules are unchanged.

## Security / distribution

- public launcher no longer compiles missing native components automatically;
- developer bootstrap is explicit (`npm run native:bootstrap-official`) and fetches only the pinned upstream commit;
- native builder rejects unpinned or dirty upstream source;
- runtime requires `sourceCommit` in each native manifest entry to match the pinned upstream commit;
- restored Contract v0.15.85 Boost header-only portability definitions in the native source helper;
- public mining is fail-closed to synchronized BYZE mainnet;
- block publication repeats that mainnet readiness check immediately before signing/submission;
- payout address must be positively validated by the local BYZE node;
- P2P maximum peers/frame size reduced and per-peer rate limiting/temporary blocking added;
- expensive remote proof validation is globally/per-peer bounded;
- startup pre-presence buffering is bounded globally and per peer.

## Release engineering

- added `--version`;
- installation uses `npm ci`;
- historical internal audit/change documents are excluded from the distributable source package;
- added `SECURITY.md`, third-party notices, release checklist, source/public preflight distinction and multi-platform CI;
- source RC deliberately contains no redistributable native binary until license and signing gates are closed.
