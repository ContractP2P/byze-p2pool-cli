# BYZE P2Pool Discord reporting (experimental)

The scheduled GitHub Actions observer offers **two types of reports**:

1. **Activity**: at most once per hour. A passive Hyperswarm observer listens for approximately 45 seconds to signed mining-presence announcements. It reports **observed** miners in MINING state and a **self-reported** hashrate. It is not a census of the global P2Pool network. Missing data is displayed as **unavailable**, never as a false zero.
2. **Block payouts**: a message for each independently **attributed** and confirmed P2Pool block. It shows total coinbase, 0.5% fee, amounts paid per wallet and fraction of the net payout. Wallets are displayed with the first ten characters, three dots, and the last six characters. A maximum of 12 wallets fit in the Discord table; other wallets are aggregated, with a link to the block's public on-chain data.

## Public activity format

The public Discord activity report intentionally contains only the latest observation timestamp (Discord-localized for each reader), the count of **active miners observed**, and **observed hashrate**:

    **BYZE P2Pool · Activity Report**
    Latest observation · <t:1792007880:t>

    **1** Active miners observed
    **~2.86 kH/s** Observed hashrate

When no verified presence or fresh hashrate is available, that metric is shown as **unavailable**, not zero. The short post does not claim full-network coverage, a 60-minute aggregation, share acceptance, or a health verdict. Scope and telemetry limitations remain in this documentation rather than being repeated in every Discord post.

## Important: never confuse fee candidates with P2Pool blocks

Matching the fee address or 0.5% fee is NOT proof that this P2Pool mined the block. Candidate observations remain in read-only GitHub Actions evidence; **candidate-only events are no longer posted to Discord**.

Only independently reviewed evidence allows a payout report. The review must establish the exact hash/height with 6+ confirmations; real miner build, submission logs and resulting block; on-chain coinbase outputs; and PPLNS share-window proof sufficient to recompute allocations.

After reviewing that evidence, add one entry to the version-controlled file:

    cli/config/pool-block-attributions.json

Fields: height, hash, coinbaseTxid, pplnsTipId (prefix ps: plus 64 hex characters) and evidenceUrl linking to the GitHub issue or PR that records the review. The observer checks block hash, height, coinbase txid, fee and amounts again. **This file records an operator attestation; the monitor does not independently validate PPLNS proof.** The file is initially empty; thus **no P2Pool block report can be posted until attribution has been established**. Fully automatic P2P evidence ingestion remains a future improvement.

## Configuration and validation

- Existing Actions variable: BYZE_MONITOR_ENABLED=true.
- Existing Actions secret: BYZE_P2POOL_DISCORD_WEBHOOK, pointing to the desired #p2pool-reports channel.
- Run the workflow manually using `dry_run=true` before activation. It prints the report previews and preserves chain observations in an Actions evidence artifact but sends no messages or state mutations.
- To test a real Discord message immediately when the current UTC hour already has a report, manually choose `dry_run=false` and `force_activity=true`. This explicit option bypasses the hourly activity gate for that manual run only; scheduled runs remain capped. Do not enable it for routine publication.
- Run offline tests:

    node --test cli/tools/chain-monitor/core.test.cjs cli/tools/chain-monitor/run.test.cjs cli/tools/chain-monitor/reports.test.cjs

The workflow runs at minutes 17 and 47 UTC, subject to GitHub scheduling delays. Routine activity posts are capped at once per UTC clock hour (manual forced tests are the documented exception). Verified block reports are deduplicated by block hash. A successful webhook followed by failed state persistence may result in repeat delivery.

The explorer scan stops on unexpected or malformed blockchain data. An unavailable P2P observer does not block the scan: the activity post labels values unavailable. The observer sends a protocol hello only and needs no BYZE daemon, wallet secrets, or miner callbacks. Real P2P discovery from a GitHub-hosted observer was confirmed on 2026-10-14 with one active miner and a recent 2.86 kH/s sample. This single observation does not establish full-network coverage.

## Interpretation and privacy

- Signed miner-presence does not make the accompanying hashrate cryptographically trustworthy: telemetry is self-reported.
- Counts are observed peer identities, not guaranteed to be unique humans or wallet owners. Peer discovery may show only a subset of the network.
- The payout table displays **addresses receiving coinbase outputs**, not necessarily distinct miners. It uses the actual payment amounts, not current hashrate or a live PPLNS estimate.
- Abbreviated wallets are not anonymous: amounts and complete receiving addresses remain public on the blockchain. No alias-to-wallet association is published.
- No mining CLI update is required. The observer imports the existing miner's exported network identity constants; the mining CLI code remains unchanged.
