# BYZE P2Pool Discord reporting (experimental)

The scheduled GitHub Actions observer offers **two types of reports**:

1. **Activity**: at most once per hour. A passive Hyperswarm observer listens for approximately 45 seconds to signed mining-presence announcements. It reports **observed** miners in MINING state and a **self-reported** hashrate. It is not a census of the global P2Pool network. **No activity message is posted** unless the snapshot is fresh, at least one verified miner is in MINING state, and a positive recent hashrate has been received. Unavailable measurements never imply that the pool is empty.
2. **Block payouts**: a message for each independently **attributed** and confirmed P2Pool block. A reviewed single-miner bootstrap payout is explicitly marked **Bootstrap block — NO PPLNS window**; only a reviewed share-window payout is marked **PPLNS block**. It shows total coinbase, 0.5% fee, amounts paid per wallet and fraction of the net payout. Wallets are displayed with the first ten characters, three dots, and the last six characters. A maximum of 12 wallets fit in the Discord table; other wallets are aggregated, with links to the block's public on-chain data **and the GitHub evidence review**.

## Public activity format

The public Discord activity report intentionally contains only the latest observation timestamp (Discord-localized for each reader), the count of **active miners observed**, and **observed hashrate**:

    **BYZE P2Pool · Activity Report**
    Latest observation · <t:1792007880:t>

    **1** Active miners
    **~2.86 kH/s** Hashrate

When no verified active miner or positive recent hashrate is available, **no activity report is posted**. This also applies when the passive observer fails, the sample is stale, miners are idle, or a start-up miner reports 0 H/s. Absence of observations does not prove that the pool is empty. A skipped run does **not** advance the hourly activity timestamp; the next scheduled run can try again. A valid activity report does not claim full-network coverage, a 60-minute aggregation, share acceptance, or a health verdict. Scope and telemetry limitations remain in this documentation rather than being repeated in every Discord post.

## Important: never confuse fee candidates with P2Pool blocks

Matching the fee address or 0.5% fee is NOT proof that this P2Pool mined the block. Candidate observations remain in read-only GitHub Actions evidence; **candidate-only events are no longer posted to Discord**.

Only independently reviewed evidence allows a payout report. The review must establish the exact hash/height with 6+ confirmations; real miner build, submission logs and resulting block; on-chain coinbase outputs; and PPLNS share-window proof sufficient to recompute allocations.

After reviewing that evidence, add one entry to the version-controlled file:

    cli/config/pool-block-attributions.json

The required entry fields are `height`, `hash`, `coinbaseTxid`, `proofFile`, `proofSha256` (exact SHA-256 of the committed public JSON proof), and `evidenceUrl` (the separately reviewed GitHub issue or PR). For PPLNS, `pplnsTipId` must begin with `ps:` and contain 64 hex digits (`payoutMode: "pplns"` may be omitted). For a bootstrap payout **only**, use `payoutMode: "bootstrap"` and `pplnsTipId: ""`. A file marked `proofStatus: "incomplete"` is never eligible for a verified block report.

The original signed miner/protocol share evidence must be independently reviewed before accepting a PR. For PPLNS, the monitor independently **recomputes payout arithmetic** from the committed PPLNS pool-share window. For a separately reviewed bootstrap payout, it checks the single miner plus exact 0.50% fee **without claiming PPLNS**. It checks that **every positive coinbase output** (script and satoshis) agrees on every scheduled check. It also verifies evidence file SHA-256, release metadata, hash, height, txid, six confirmations and canonical-chain identity. This numerical verification does **not** cryptographically verify the original PoW share proofs or establish that a self-reported submission actually occurred; a human reviewer must verify these additional source records.

When the review has passed and the attribution manifest is committed to `main`, the existing scheduled GitHub Actions monitor publishes the payout message automatically to Discord once the block is confirmed (>=6), with the evidence review URL. **No auto-publishing from a mere fee-address candidate, local submission log or unreviewed PR.** The manifest remains empty until a real block is proved.

## Configuration and validation

- Existing Actions variable: BYZE_MONITOR_ENABLED=true.
- Existing Actions secret: BYZE_P2POOL_DISCORD_WEBHOOK, pointing to the desired #p2pool-reports channel.
- Run the workflow manually using `dry_run=true` before activation. It prints the report previews and preserves chain observations in an Actions evidence artifact but sends no messages or state mutations.
- To test a real Discord message immediately when the current UTC hour already has a report, manually choose `dry_run=false` and `force_activity=true`. This explicit option bypasses the hourly activity gate for that manual run only; it **does not bypass** the requirement for a fresh, positive mining observation. Scheduled runs remain capped. Do not enable it for routine publication.
- Run offline tests:

    node --test cli/tools/chain-monitor/core.test.cjs cli/tools/chain-monitor/run.test.cjs cli/tools/chain-monitor/reports.test.cjs cli/tools/chain-monitor/evidence.test.cjs

The workflow runs at minutes 17 and 47 UTC, subject to GitHub scheduling delays. Routine activity posts are capped at once per UTC clock hour (manual forced tests are the documented exception). Verified block reports are deduplicated by block hash. A successful webhook followed by failed state persistence may result in repeat delivery.

The explorer scan stops on unexpected or malformed blockchain data. An unavailable P2P observer does not block the chain scan: the activity post is suppressed, while chain evidence and independently verified block reports remain possible. The observer sends a protocol hello only and needs no BYZE daemon, wallet secrets, or miner callbacks. Real P2P discovery from a GitHub-hosted observer was confirmed on 2026-10-14 with one active miner and a recent 2.86 kH/s sample. This single observation does not establish full-network coverage.

## Interpretation and privacy

- Signed miner-presence does not make the accompanying hashrate cryptographically trustworthy: telemetry is self-reported.
- Counts are observed peer identities, not guaranteed to be unique humans or wallet owners. Peer discovery may show only a subset of the network.
- The payout table displays **addresses receiving coinbase outputs**, not necessarily distinct miners. It uses the actual payment amounts, not current hashrate or a live PPLNS estimate.
- Abbreviated wallets are not anonymous: amounts and complete receiving addresses remain public on the blockchain. No alias-to-wallet association is published.
- No mining CLI update is required. The observer imports the existing miner's exported network identity constants; the mining CLI code remains unchanged.

## End-to-end block evidence workflow (no VPS)

1. A new miner build containing `cli/src/mining/block-evidence.js` records a **private, unconfirmed** JSON file after a successful `submitblock` RPC, under `~/.local/state/byze-p2pool/block-evidence/` (mode 0700, file mode 0600). In this corrective branch, the record distinguishes `payoutMode: "bootstrap"` from `payoutMode: "pplns"`, and preserves `proofStatus: "incomplete"` records if full proof construction fails (best effort: disk/permission failures can still prevent a save). **The published Community Test 1 binaries do not yet contain these corrections; a rebuilt release is necessary after review.** The miner does not contact GitHub or Discord. The **Community Test 1** binaries [`v0.2.5-rc4-community.1`](https://github.com/ContractP2P/byze-p2pool-cli/releases/tag/v0.2.5-rc4-community.1) contain this feature. The prior [evidence test binaries](https://github.com/ContractP2P/byze-p2pool-cli/releases/tag/v0.2.5-rc3-evidence-test1) also contain local evidence capture, but report the older `0.2.5-rc3` internal version. Earlier `v0.2.5-rc3-rpc-recovery-test1` binaries do not capture block evidence; re-run the updated guided installer with the miner stopped to select the new release without touching BYZE Core.
2. The operator independently checks that the block exists and has six confirmations, that the coinbase txid matches the saved submission, and for **PPLNS** that the correct signed pool-share / proof history genuinely produced its window. For **bootstrap**, the review must independently establish the one-recipient payout, exact coinbase and fee, and the absence of a committed PPLNS tip. Never label bootstrap as PPLNS. Never upload wallet keys, raw RPC credentials or private network information. The locally saved file also includes any retained **signed pool-share packets** for the PPLNS window (and a count of missing packets), so a reviewer can inspect the original share/proof provenance. These packets may contain public miner identities and payout addresses: review privacy before uploading. **The monitor checks share IDs, ancestry, payouts and coinbase values, but does not validate the full signed PoW protocol packet chain; that remains a separate manual review gate.**
3. After an explicit operator decision to publish this record, copy the privacy-reviewed JSON to `cli/evidence/blocks/<height>-<coinbaseTxid>.json`. Review **all** public mining identifiers and recipient addresses before publishing; these data are not anonymous. Update the manifest with the exact file SHA-256, mode/tip and a GitHub issue/PR evidence review link. GitHub PR review is the provenance/attestation gate; never automatically commit miner claims.
4. The GitHub CI runs deterministic evidence tests; the scheduled chain monitor rechecks the real chain, share weights, amount distribution and the exact pool fee. It **fails closed** on missing, forged, modified, incomplete or inconsistent evidence.
5. Only after a completed review, the manifest entry is merged and the block has six confirmations, a concise `#p2pool-reports` payout report can be posted automatically with both explorer and review links. The report distinguishes a **Bootstrap block** from a **PPLNS block**. **No local proof is automatically uploaded to GitHub or Discord**, and a fee match or an incomplete record never authorizes an attribution. The existing hourly activity report remains separate.

**PPLNS strictness:** A PPLNS evidence file with missing signed pool-share packets is saved locally for diagnosis, but is *not* eligible for a public verified payout message. The independent monitor checks packet presence and share linkage; it does not replace the human cryptographic review of the signed share / PoW provenance. An operator may reconstruct missing source records from independently checked peers before public review, never by fabricating packets.
