# BYZE P2Pool CLI

A standalone peer-to-peer CPU miner for BYZE, using RandomX, Hyperswarm, and direct PPLNS coinbase payouts. The Electron **Contract** application is **not required**.

> **Status: v0.2.5-rc3 source release candidate (generation v6). Not a validated public binary release.** Live multi-peer payout/soak tests, native bundle packaging/signatures and a publication license are still release gates. See the [release checklist](cli/RELEASE-CHECKLIST.md).

- Mining payouts are committed directly to the candidate block coinbase; pool fee: **0.50%**.
- No BYZE private key, seed or wallet passphrase is requested.
- Requires a synchronized BYZE mainnet node, working `byze-cli`, and Node.js 20+.
- **Linux x86-64 / Ubuntu 24.04** is the initial intended target; macOS and Windows have CI coverage for the JavaScript source but are **not** advertised as tested mining distributions.
- The v6 discovery generation is incompatible with v4/v5 peers and PPLNS histories. Coordinate upgrades; a restart starts a new window.

## Obtain and test the current source

The current code is in **this repository's `main` branch**:

```bash
git clone https://github.com/ContractP2P/byze-p2pool-cli.git
cd byze-p2pool-cli/cli
npm ci
npm run check
npm test
npm run release:preflight:source
node src/byze-p2pool.js --help
```

These commands check JavaScript source and the source-RC release metadata. They do **not** establish that a native miner bundle or a live BYZE node is ready. CI also runs an isolated DHT integration check on Linux/Node 22.

For an additional isolated BYZE Core regtest check, see [the CLI technical README](cli/README.md#validation). It requires verified rc4 or later `byzed` and `byze-cli` binaries.

## Running the miner (development testing only)

You need:

1. A synchronized BYZE mainnet node with `getblockchaininfo` reporting `chain=main` and `initialblockdownload=false`.
2. A public **receiving address that your BYZE wallet can actually spend**, preferably obtained using `getnewaddress` on Byze rc4 or later. Script validation alone does not prove spendability.
3. Verified managed native miner/verifier binaries for your platform, with their `native-manifest.json`.

**A managed redistributable native bundle is not included in this source RC.** The runtime does not silently compile native code. For explicit developer-only bootstrap from a pinned upstream source, follow [CLI installation / native bootstrap](cli/README.md#developer-only-native-bootstrap). Do not bypass native hash/source verification.

Once the prerequisites exist, from `cli/`:

```bash
./byze-p2pool --dry-run \
  --alias TestMiner \
  --wallet YOUR_VERIFIED_BYZE_RECEIVING_ADDRESS \
  --threads 2 \
  --byze-cli /absolute/path/to/byze-cli
```

Only if the dry run succeeds, an opt-in diagnostic session can use `--no-submit` (it **never submits a found network block**):

```bash
./byze-p2pool --alias TestMiner \
  --wallet YOUR_VERIFIED_BYZE_RECEIVING_ADDRESS \
  --threads 2 --byze-cli /absolute/path/to/byze-cli --no-submit
```

These commands still use **mainnet** policy; do not assume a separate consensus testnet. The isolated regtest integration test uses its own disposable node, not a running mainnet wallet.

## Validation and release readiness

The `main` branch includes PR #2's remote-payout/RPC retry fixes and PR #4's deterministic deferred-share recovery regression. That regression simulates RPC failures; it does **not** replace a live `byzed` outage soak test. Track this in [issue #3](https://github.com/ContractP2P/byze-p2pool-cli/issues/3).

Before any public binary release:

- Run an isolated multi-peer outage/recovery soak, including share expiry, stale-chain treatment, duplicate prevention, and PPLNS accounting.
- Independently confirm direct coinbase payouts and the 0.50% pool fee with a real found block.
- Build, verify and sign managed platform-specific native bundles and publication manifests.
- Select/document the CLI publication license, retain all third-party notices, and pass `npm run release:preflight`.

See [technical documentation](cli/README.md), [security policy](cli/SECURITY.md), [release checklist](cli/RELEASE-CHECKLIST.md) and [third-party notices](cli/THIRD_PARTY-NOTICES.md).

The CLI's `package.json` currently declares `UNLICENSED`. The upstream native miner and other bundled dependencies retain their own separate licenses. No MIT license is claimed for the CLI source in this repository.
