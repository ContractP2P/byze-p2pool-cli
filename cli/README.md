# BYZE P2Pool CLI v0.2.5-rc3

Standalone command-line peer for **BYZE P2Pool secure-v2**, with the `global-epoch-v6` compatibility generation.

This package is a **source release candidate**. Managed native bundles remain subject to the platform, license-notice and signing gates in [the release checklist](RELEASE-CHECKLIST.md).

## Security model

- no persistent Contract profile;
- a fresh Ed25519/Hyperswarm identity is generated in RAM and destroyed on shutdown;
- no BYZE seed, private key or wallet passphrase is requested;
- PPLNS payouts and the 0.50% pool fee are committed directly in the candidate coinbase;
- PoW is cryptographically bound to the actual coinbase/txid/Merkle root/header before PPLNS credit;
- native components are loaded only from the managed native directory, require SHA-256 verification and must declare the pinned upstream source commit;
- the public pool is **mainnet-only** and refuses to run while the local node is in Initial Block Download or materially behind its headers;
- incoming P2P traffic is bounded by frame-size, peer-count, per-peer rate limits and bounded expensive-validation concurrency.

This candidate uses Core-compatible PoW ordering, node-backed payout checks, and a block-weight budget that includes the direct coinbase and quantum block signatures. When needed, it removes a suffix of template transactions, subtracts their fees, and rebuilds the witness commitment and payout plan. All PPLNS beneficiaries are retained.

Addresses are checked at startup (including the fee address), membership intake, share verification and payout resolution. The node rejects invalid scripts; wallet-reported `unspendable` addresses are refused. A valid external address may still have unknown spendability: the CLI warns instead of claiming otherwise. Obtain receiving addresses with `getnewaddress` on Byze rc4 or later. Node validation does not replace a receiving-wallet check or a small test spend.

### Upgrade coordination

Generation v6 uses a new discovery topic and a signed generation field. It does not join v4/v5 peers or import their PPLNS history. Coordinate a pool-wide restart after reviewing the current payout window; restarting starts a new window and does not carry forward its prior share weights. Existing on-chain coinbase outputs are unchanged. Do not mix this CLI with an unmodified Contract v4 miner.

## Compatibility

- CLI: `0.2.5-rc3`
- Contract ancestry: `v0.15.85+`; unmodified v4/v5 peers are incompatible
- contract: `org.contract.byze-p2pool@0.1.3`
- contract source hash: `0ba509a74eb5f475ce41f152349fe49a7d19e4fbd6c14c1833632c61681a0b66`
- pool: `byze-main-p2pool-v1`
- proof mode: `byze-randomx-v2`
- security generation: `coinbase-binding-v2-global-epoch-v6`
- native miner feature: `contract-direct-coinbase-v2`
- PPLNS window: 20 PoolShares
- cell size: up to 20 miners; global epoch aggregation combines valid cell checkpoints
- pool fee: 50 bp = 0.50%

See `COMPATIBILITY.json` for machine-readable compatibility metadata.

## Validation

Run `npm ci`, `npm run check`, `npm test` and `npm run release:preflight:source` from `cli/`.
The regression suite covers PoW ordering, payout validation, a near-full block with
400 recipients, fee conservation after template adjustment, and protocol compatibility.

For an isolated Core RPC integration check, set `BYZE_CORE_BIN` to a directory
containing verified Byze rc4 `byzed` and `byze-cli` binaries, then run `npm run test:core`.
This creates a temporary regtest node with networking disabled, checks wallet address
classification and serialization against Core, mines one test block, and stops the node.
It does not access an existing wallet or mainnet. End-to-end multi-peer mining with a
full mempool and real-wallet test spends remain separate release checks.

## Requirements

- Node.js 20 or newer;
- a local, synchronized BYZE rc4 or later mainnet node (`chain=main`, `initialblockdownload=false`);
- `byze-cli` able to communicate with that node;
- a managed native bundle for the current platform:

```text
native/<platform>-<arch>/
  byze-p2pool-miner[.exe]
  byze-rxhash[.exe]
  native-manifest.json
```

Each manifest entry must include the executable SHA-256 and the pinned upstream source commit:

```text
d84db8a84ba4a06432fcdddbf1584b89a7e52379
```

## Installation

For a final binary release:

```bash
npm ci
npm run check
npm test
npm run release:preflight
./byze-p2pool --dry-run --alias Test --wallet byz1... --threads 1
```

`install.sh` performs the same checks and **does not compile missing native code automatically**.

This source RC deliberately has no redistributable native binary, so the final native check will fail until a managed bundle is supplied.

### Developer-only native bootstrap

For local development/testing only:

```bash
./install-dev.sh
```

or:

```bash
npm ci
npm run native:bootstrap-official
```

This explicitly clones the official `powhermes/byze-miner` repository, checks out the pinned commit, verifies the checkout is clean and its submodules are at the expected revisions, copies the source to an isolated work directory, patches **only the copy**, builds the P2Pool-native binaries, writes their SHA-256 manifest and verifies the resulting managed bundle.

There is no automatic discovery of `~/ldev/byze-miner`, `~/Downloads/byze-miner`, `PATH`, or `BYZE_P2POOL_MINER_SOURCE`.

## Usage

```bash
./byze-p2pool \
  --alias Mac01 \
  --wallet byz1xxxxxxxxxxxxxxxxxxxxxxxx \
  --threads 6
```

If `byze-cli` is not detected automatically:

```bash
./byze-p2pool \
  --alias Mac01 \
  --wallet byz1xxxxxxxxxxxxxxxxxxxxxxxx \
  --threads 6 \
  --byze-cli ~/ldev/byze/build/bin/byze-cli
```

For a managed native bundle stored elsewhere:

```bash
./byze-p2pool ... --native-dir /path/to/managed/native-bundle
```

`--miner-dir` remains removed and is rejected.

Other useful options:

```text
--dry-run      validate node, payout address, policy and native bundle without P2P/mining
--no-submit    mine/validate but never submit a found network block
--version      print the CLI version
--help         print usage
```

## Mainnet fail-closed behavior

Before mining, the CLI requires a positive `validateaddress` result and a `getblockchaininfo` response with:

```text
chain = main
initialblockdownload = false
```

It also refuses a node that is materially behind its known headers. The same readiness check is repeated immediately before a candidate block is signed/submitted. RPC failure at that point means **no submission**.

## P2P resource limits

The integration layer limits:

- 64 simultaneous Hyperswarm peers;
- 256 KiB per newline-delimited wire frame;
- 120 frames / 10 s / peer;
- 2 MiB / 10 s / peer;
- 48 share/checkpoint/PoolShare frames / 10 s / peer;
- temporary blocking after repeated rate-limit violations;
- 8 expensive validation tasks globally, 2 per peer, with a bounded queue;
- pre-presence history to 24 frames per peer and 256 frames globally.

Proof bundles remain independently chunked and bounded by the consensus-layer limits.

## Pool fee policy

`config/pool-policy.json` contains the current official policy. Its `policyHash` participates in the pool discovery topic. A client changing the fee address/policy therefore moves to a different P2P topic instead of silently joining the official pool with a different fee.

## Block publication

A candidate accepted by the local secure-v2 pipeline is rechecked against its Job Commitment and then passes through:

1. `signpoolblock`;
2. `getblocktemplate` proposal validation;
3. `submitblock`.

Submission is allowed only after a fresh synchronized-mainnet check.

## Native source trust

Public runtime execution never uses an upstream checkout directly. Developer compilation is accepted only from the pinned Git commit and a clean checkout. The build helper copies the source first and verifies that the upstream checkout did not change during preparation/build.

The runtime also rejects a native manifest whose `sourceCommit` differs from the pinned commit, even when the executable SHA-256 itself matches the manifest.

## Release status

Run:

```bash
npm run release:preflight:source
```

for this source RC. A true end-user release must pass:

```bash
npm run release:preflight
```

The latter intentionally remains blocked until a publication license is selected and a valid managed native bundle exists for the current platform. See `RELEASE-CHECKLIST.md` and `THIRD_PARTY-NOTICES.md`.

## Tests

```bash
npm ci
npm run check
npm test
```

The suite covers consensus/fork-choice/global-epoch scaling, coinbase attacks, native isolation/integrity, pinned native source trust, mainnet fail-closed behavior, P2P rate limiting and expensive-validation bounds.

## Release signatures

The release tooling can create and sign a detached release manifest with a dedicated offline Ed25519 key. No private release key is included in this repository or source archive. See `tools/release-manifest.js`, `tools/release-sign.js` and `tools/release-verify.js`.

## Peer synchronization

Pool shares use a deterministic anchor derived from their proven headers. Live proofs are checked against the local active chain within six blocks; a cached context is invalidated when the node tip changes. Pool-share height may move back by up to six blocks across consecutive epochs.

Live aggregates allow three minutes of age and one minute of forward clock skew. Requested history is separately checked against the wall clock, with a maximum age of 30 days. History still requires signatures, relay authorization, RandomX and coinbase verification. It never becomes a live proof merely because its timestamp was signed.

Peers advertise share identifiers and retrieve one page (at most 48 KiB of packet data) per request. Each client issues at most one request every 650 ms, with 16 outstanding bundles globally and four per peer. Serving is bounded per peer and globally; socket output buffers are bounded too. Deferred validation uses the same concurrency gate as new traffic.

History is bounded by the peers' retained packet caches. If an ancestor is unavailable, synchronization stays pending and block submission is held while pending contexts remain. A fully archival bootstrap/persistent pool history is not supplied by this RC. Validate restart and partition recovery with the intended pool size before rollout.

## DHT bootstrap configuration

Default operation uses HyperDHT's public bootstrap nodes. To use a separate DHT, start a persistent bootstrap node and pass the same endpoint to every miner:

```sh
# From cli/, in a separate terminal (local test network):
node -e "require('hyperdht').bootstrapper(49737,'127.0.0.1',{bootstrap:[],nodes:[]})"
# Add to each miner's normal invocation:
node src/byze-p2pool.js --alias Miner --wallet byz1... --bootstrap 127.0.0.1:49737
```

`--bootstrap HOST:PORT[,HOST:PORT]` replaces both bootstrap and known-node lists. There is no fallback to public seeds when the chosen nodes are unreachable. `--bootstrap none` uses empty lists and cannot discover peers on its own. Up to eight IPv4/hostname endpoints are accepted; IPv6 endpoint syntax is not supported by this option. A private DHT does not change the CLI's mainnet-only mining policy.

`npm run test:dht` creates two transport peers with a loopback-only bootstrap, exchanges a multi-page proof bundle, then closes them. It does not start mining or contact the public DHT. The Linux/Node 22 CI job runs this integration test.

The unused `CONTRACT_BYZE_POOL_FEE_ADDRESS` environment override has been removed. The configured pool policy remains the source of the fee address.

## Verified Core rc4 download

With GnuPG available on PATH, from `cli/`:

```sh
npm run core:download -- --dest ./core-rc4-download
```

The destination must be new, and its parent must exist. The tool selects Linux x64, macOS arm64/x64 or Windows x64; `--platform` can select one explicitly. It verifies the signed checksum manifest against pinned release-key fingerprint `9F11E836EB4B7F464ADBB1E7AC11CA674828CAE1`, then verifies the archive against both the signed manifest and the pinned rc4 SHA-256. It uses an isolated public-key ring and removes partial downloads on failure.

The verified archive is left unextracted. Stop your node before manually replacing its binaries, then restart and select the new `byze-cli` with `--byze-cli PATH`. The downloader never opens wallets or changes node data. Platform requirements and the source release are documented in the [official rc4 release](https://github.com/powhermes/byze/releases/tag/v0.2.5-rc4-plain-taproot-guard).

For the optional Core integration test, set `BYZE_CORE_BIN` to the directory containing verified `byzed` and `byze-cli`, then run `npm run test:core`. It creates a temporary regtest node with networking disabled, verifies payouts and block metrics, and checks chain context after block invalidation/restoration.
