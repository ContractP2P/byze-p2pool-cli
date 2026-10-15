# BYZE P2Pool CLI — Experimental Test 1 (community testing)

We have published the updated **15 October 2026 Experimental Test 1** packages of the standalone **BYZE P2Pool CLI** for **Linux x64, macOS Apple Silicon and macOS Intel**. All three packages use the same tested CLI source commit and include safe RandomX pause/resume on node RPC outages, plus private auditable PPLNS snapshots after successful block submission.

The CLI enables peer-to-peer RandomX CPU mining with direct PPLNS coinbase payout construction and a 0.5% pool fee. The guided installer detects and **reuses an existing BYZE Core installation without reinstalling or upgrading it**. The new evidence-enabled CLI is kept in a separate directory from earlier rc3 test packages, with only the managed launcher switched after installation. If Core is absent, an official Core installation is offered only with explicit confirmation (Linux: BYZE Core v0.2.5-rc5-change-keyspace).

**Guided setup:** https://contractp2p.github.io/byze-p2pool-cli/
**Current three-platform release:** https://github.com/ContractP2P/byze-p2pool-cli/releases/tag/v0.2.5-rc3-evidence-test1
**Source and technical information:** https://github.com/ContractP2P/byze-p2pool-cli

**Please note:** These are **experimental pre-releases for community testing**, not stable or production-qualified releases. The P2Pool bundles are currently unsigned. Verify any BYZE payout address with the receiving wallet, and avoid risking funds you cannot afford to lose. A live byzed-outage recovery test and a block/payout confirmation using these exact builds have not yet been documented as completed; no such claim is made here.

A block payout report in Discord is only posted after six confirmations, exact on-chain PPLNS reconciliation and a reviewed GitHub evidence record; a fee-address match is not proof. Reports of installation problems, peer discovery issues, share accounting anomalies or payout concerns are welcome. Please include the platform, package tag, BYZE Core version and redacted logs (never wallet secrets or seed phrases).

Thank you to everyone contributing reviews and tests, including byzedev.
