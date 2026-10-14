# Evidence protocol for byzedev review (Experimental Test 1)

Status: **community testing only**. This document does not certify production readiness.

## 4. P2Pool release archive integrity

The website installers include immutable, build-specific SHA-256 hashes that are **independent** of the remotely fetched SHA256SUMS manifest. An archive whose bytes change fails the check even if the attacker also changes the release manifest.

| Platform | Tag | Archive SHA-256 |
| --- | --- | --- |
| Linux x86-64 | `v0.2.5-rc3-linux-x64-test1` | `3481ebacc1a237598da6ad383a903dcf8f9532853d18f64f49f77783b1293766` |
| macOS Apple Silicon | `v0.2.5-rc3-macos-arm64-test1` | `a9b2a7275cf6f28255d156c78e14ad5d02faab7a32e3fbb1af3fbe46cd9d3a13` |
| macOS Intel | `v0.2.5-rc3-macos-intel-test1` | `bbe0988ff7ce919648e3d5f6b91015793e3db5cc98f27e090ea17ca682986ec8` |

The security CI downloads each actual published archive, verifies the corresponding immutable hash and manifest, then alters the archive and checks that hash verification fails. This **does not** mean the archives are signed or notarized; signing remains a separate release gate.

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

**Limitation:** the share packets are synthetic, and only payout-script RPC validation is real. It does **not** prove P2P multi-peer PoW share verification, PPLNS coinbase correctness, reorg handling or real wallet spendability on mainnet. The full two-miner soak test in [issue #3](https://github.com/ContractP2P/byze-p2pool-cli/issues/3) must remain open until separately evidenced.

For the real two-peer case, use a controlled non-production environment. Record Core and CLI versions, time of stopping and starting byzed, per-share IDs, accepted/rejected/stale/deferred counters, height/hash changes, 120-second expiry behavior, and anonymized logs. **Do not deliberately stop an already running production miner to generate this evidence.**

## 6. Mainnet block and coinbase evidence (read-only)

On a **currently running, synchronized BYZE mainnet node**, use an existing executable path. This command will not start/stop mining, install binaries, access wallet secrets or create transactions:

```sh
node cli/tools/audit-mainnet-coinbase.js \
  --cli=/ABSOLUTE/PATH/TO/byze-cli \
  --from=2026-10-13 \
  --to=2026-10-15 \
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
