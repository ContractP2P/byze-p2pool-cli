# Evidence protocol for byzedev review (Experimental Test 1)

Status: **community testing only**. This document does not certify production readiness.

## 4. P2Pool release archive integrity

The website installers include immutable, build-specific SHA-256 hashes that are **independent** of the remotely fetched SHA256SUMS manifest. An archive whose bytes change fails the check even if the attacker also changes the release manifest.

| Platform | Tag | Archive SHA-256 |
| --- | --- | --- |
| Linux x86-64 | `v0.2.5-rc4-community.1` | `6881453c8e3b5f726920affa65fd6ba6127bbce6bfc67d9daf9ef39ec72802ef` |
| macOS Apple Silicon | `v0.2.5-rc4-community.1` | `22ad3f666e4e487c848dbc6133ee1aa91fea0fd8e299944fa9b04e77c6d86986` |
| macOS Intel | `v0.2.5-rc4-community.1` | `f86ee84a54d818b16098b68996473a61f22c7d8481f2b9d02251ffbb7a625b47` |

The three archives above are the **15 October 2026 Community Test 1** prerelease: [GitHub release](https://github.com/ContractP2P/byze-p2pool-cli/releases/tag/v0.2.5-rc4-community.1). Earlier test archives remain published but are **not** the archives selected by the current guided installers. The security CI downloads each actual published archive, verifies the corresponding immutable hash and manifest, then alters the archive and checks that hash verification fails. This **does not** mean the archives are signed or notarized; signing remains a separate release gate.

## 5. Isolated byzed outage (intermediate integration test)

Run on a disposable, network-disabled regtest environment only, with official verified BYZE Core binaries:

```sh
cd cli
npm ci
BYZE_CORE_BIN=/absolute/path/to/verified/core/bin \
  BYZE_OUTAGE_TEST_CONFIRM=DISPOSABLE_REGTEST_ONLY \
  node tools/test-real-byzed-regtest-outage.js
```

The harness starts a **new** `byzed` using a temporary data directory and `-networkactive=0`, creates a temporary address, stops only the **child process it started**, leaves BYZE P2Pool's deferred queues running, uses genuine Core payout-address RPC failures during 60 seconds of outage, restarts the same temp daemon, and checks recovery and exactly-once queue handling. It deletes only its temporary data directory.

**Limitation:** the share packets are synthetic, and only payout-script RPC validation is real. It does **not** prove P2P multi-peer PoW share verification, PPLNS coinbase correctness, reorg handling or real wallet spendability on mainnet. [Issue #3](https://github.com/ContractP2P/byze-p2pool-cli/issues/3) was **closed administratively on 14 October 2026**, not because the full live two-miner test succeeded. Its multi-peer soak, deferred-share accounting, expiry and reorg acceptance criteria **remain outstanding** and must be evidenced separately before a stable release.

For the real two-peer case, use a controlled non-production environment. Record Core and CLI versions, time of stopping and starting byzed, per-share IDs, accepted/rejected/stale/deferred counters, height/hash changes, 120-second expiry behavior, and anonymized logs. **Do not deliberately stop an already running production miner to generate this evidence.**

## 6. Mainnet block and coinbase evidence (read-only)

On a **currently running, synchronized BYZE mainnet node**, use an existing executable path. This command will not start/stop mining, install binaries, access wallet secrets or create transactions:

```sh
node cli/tools/audit-mainnet-coinbase.js \
  --cli=/ABSOLUTE/PATH/TO/byze-cli \
  --from=2026-10-15 \
  --to=2026-10-16 \
  --max=1000 \
  --output=/tmp/byze-p2pool-evidence.json
```

The date range is UTC, with the end date **exclusive**. `--output` refuses to overwrite an existing file; omit it to print JSON to the terminal.

The tool checks `chain=main`, inspects decoded on-chain coinbase transactions, searches outputs for the configured 0.5% pool fee address using the decoded address **or output script**, and reports height, hash, coinbase txid, all outputs, fees, and confirmations. The reported match is a **candidate**, not proof the block came from a specific version of P2Pool CLI.

**A definitive claim that Experimental Test 1 mined a mainnet block requires all of the following:**

1. A real block hash/height with network confirmations.
2. Logs from the miner identifying the **exact experimental build/tag and sha256**, with the submitted block hash/height.
3. Full on-chain coinbase outputs including the pool fee and all miner recipients.
4. PPLNS share-window evidence needed to independently recompute recipient amounts and the exact 0.50% fee.

If any of these is absent, state the claim as **unverified**. Session reward estimates, pool share counts and transfers to the fee address by themselves are not sufficient.

## 7. Discord reports are a presentation layer, not a complete proof

The scheduled observer publishes an **observed miner activity** snapshot only when fresh active MINING presence and positive reported hashrate are available. This does not prove accepted shares, an identified block or PPLNS allocations.

A **confirmed block payout** Discord message is issued only for a block already registered as independently reviewed in `cli/config/pool-block-attributions.json` (initially empty). Its operator review links to external evidence and must satisfy the four requirements above. The monitor rechecks the canonical block, coinbase txid, confirmations, outputs and fee, **and independently recomputes payout amounts from the committed PPLNS window**. Cryptographic validity of the original signed share packets and miner submission provenance still require separate operator review. A fee-address match by itself is only a candidate and is never posted as a confirmed P2Pool payout.

For a reproducible review, keep the miner build identifier and submission logs, the exact block hash, complete on-chain outputs, the PPLNS tip/share window with verified weights, and the independent calculation of each recipient and the 0.50% fee in a public issue or PR (redacting secrets). The Discord payout report can then summarize verified on-chain amounts; it cannot replace the underlying evidence. See [Discord reporting](discord-reporting.md).
