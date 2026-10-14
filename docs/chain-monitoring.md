# BYZE P2Pool external chain monitor (Stage 1)

**Status: code ready for review, live explorer endpoints unverified. No external posting is enabled by default.**

This is a separate, read-only GitHub Actions observer of `explorer.byze.org`. It does not use Hyperswarm, does not run Byze Core, does not contact miners, does not access wallets, and **requires no changes to the mining CLI**. It is complementary to `cli/tools/audit-mainnet-coinbase.js`, whose existing safety standard and matching policy it follows. It does not claim to replace the complete native-node audit or P2P PPLNS evidence.

## Verified vs. unverified

Verified in the GitHub source tree:

- `cli/config/pool-policy.json` defines `feeBasisPoints: 50` and the configured fee address.
- Existing auditor scans coinbases from a local Byze Core node, explicitly identifies **candidate** blocks and does not claim origin or PPLNS accuracy based only on fee matching.
- Offline tests verify Byze bech32m address decoding, fee-script matching, exact satoshi accounting, detection of changed block hashes, delayed confirmations, and scan limits.

**Not yet verified:** precise public JSON API paths and payload shapes exposed by `explorer.byze.org`. Neither HTTP explorer block routes nor their decoded coinbase shapes should be guessed. The job deliberately refuses to run without explicit, validated endpoint variables. It does not publish partial or speculative results.

## Set up after verifying the explorer JSON API

In `ContractP2P/byze-p2pool-cli` → **Settings → Secrets and variables → Actions**:

Repository **variables**:

| Variable | Value | Required |
| --- | --- | --- |
| `BYZE_TIP_URL` | Verified HTTPS JSON URL on `explorer.byze.org` returning mainnet block height (`blocks`, `height`, etc.) | yes |
| `BYZE_BLOCK_URL_TEMPLATE` | Verified HTTPS JSON URL for decoded block by **height**; include literal `{id}` placeholder | yes |
| `BYZE_TX_URL_TEMPLATE` | Verified HTTPS JSON URL for decoded coinbase by txid, with `{id}` placeholder | only when the block endpoint returns txids instead of full txs |
| `BYZE_VALUE_MODE` | `byz` (default, Core-style output decimal) or `sats` (only if explorer's `value` fields are explicitly integer satoshis) | optional |
| `BYZE_MONITOR_ENABLED` | `true` only **after** a successful manual `dry_run` and Discord webhook creation | activation |

Repository **secret**:

- `BYZE_P2POOL_DISCORD_WEBHOOK`: Discord webhook URL of the intended `#p2pool-reports` channel. Never commit this URL or paste it into an issue.

How to validate endpoints: open the official explorer in a browser, inspect **Network → Fetch/XHR** requests, check exact URL, response status, content-type JSON, and JSON shape. Look for a recent block where first transaction is a decoded coinbase, with `vin[].coinbase`, `vout[].value` and an output address or script. If the explorer returns only transaction IDs, confirm the separate decoded-tx endpoint too.

Do **not** use routes from the historic `pool.byze.org` Stratum dashboard: its data is not evidence about our independent v6 P2Pool.

## Test without sending to Discord

On the default branch after merge:

1. Open **Actions → BYZE P2Pool — read-only blockchain monitor → Run workflow**.
2. Keep `dry_run=true` (the default). The workflow will scan recent blocks and generate a readable log and a `byze-chain-evidence` artifact; it will not post Discord or update monitoring state.
3. Verify the hashes/fees shown against the explorer and inspect the artifact. If any schema or endpoint is incompatible, the job fails **without publishing**.
4. Add the Discord webhook secret. Set `BYZE_MONITOR_ENABLED=true` to enable the schedule. A manual `dry_run=false` can also activate one real run and state update deliberately.

The schedule is at minute 17 and 47 (UTC), roughly every half hour; GitHub timing is not guaranteed. GitHub also automatically disables scheduled workflows in public repositories after 60 days of inactivity. No workaround creates fake commits here; operators must watch and re-enable the scheduled workflow if needed.

## Evidence, reporting and state

- Scans from the last observed height with a 12-block overlap; first run checks the most recent 36 blocks. It refuses to skip a gap larger than 160 blocks rather than silently omitting events.
- Computes the exact configured 0.5% fee (50 basis points), compares the total sum of coinbase outputs, and includes a maximum two-satoshi approximation tolerance from the existing local auditor.
- A fee-output match is **only a candidate**, not independent identification of the P2Pool's origin or correct PPLNS distribution; a real attribution needs miner logs and share-window evidence.
- Requires at least six confirmations before notifying about a *new* fee-output candidate, and rechecks recent block hashes for observed reorganizations.
- Saves full output-address/script/satoshi evidence for candidate coinbases as a 14-day downloadable Actions artifact (no wallet secrets; addresses are public chain data).
- Posts at most once per run, on new confirmed candidates, observed reorgs, or after 24h without a report. Keeps state and deduplicates candidate hashes in a **single public repository issue** created on first live run. Do not close or modify that issue.
- Uses repository `GITHUB_TOKEN` with `issues:write` and `contents:read` only; no GitHub PAT, Cloudflare deployment or VPS. If the webhook fails, the run fails and does not advance the cursor. GitHub reruns might therefore repeat a previously delivered Discord message (at-least-once delivery).
- Every HTTP request must remain on `https://explorer.byze.org` and return valid, bounded JSON; redirects, unexpected chain, malformed blocks or partial responses cause the run to fail closed.
- No network requests are necessary for the offline unit tests: `node --test cli/tools/chain-monitor/core.test.cjs`.

## Not included in Stage 1

Hashrate, miner count, accepted/stale/deferred shares, P2P outages, and exact PPLNS share weights are **not recorded on-chain**. An independent passive Hyperswarm observer would be Stage 2, after the chain data pipeline is proven. The BYZE CLI must never call a monitoring API or HTTP endpoint to support either stage.
