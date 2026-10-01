# BYZE P2Pool CLI v0.2.5-rc1

Standalone command-line peer for the **BYZE P2Pool secure-v2** used by Contract v0.15.85+ (`global-epoch-v4`).

This package is a **release candidate**. The `cli-next` branch contains prebuilt Linux x64 and macOS Apple Silicon components; initial public support is limited to Linux x64. Artifact signing and upstream redistribution confirmation remain open in the release checklist.

The Electron Contract application is **not required**. See the [installation and mining guide](../README.md) for the source checkout, release archive instructions and full launch parameter table.

## Security model

- no persistent Contract profile;
- a fresh Ed25519/Hyperswarm identity is generated in RAM and destroyed on shutdown;
- no BYZE seed, private key or wallet passphrase is requested;
- PPLNS payouts and the 0.50% pool fee are committed directly in the candidate coinbase;
- PoW is cryptographically bound to the actual coinbase/txid/Merkle root/header before PPLNS credit;
- native components are loaded only from the managed native directory, require SHA-256 verification and must declare the pinned upstream source commit;
- the public pool is **mainnet-only** and refuses to run while the local node is in Initial Block Download or materially behind its headers;
- incoming P2P traffic is bounded by frame-size, peer-count, per-peer rate limits and bounded expensive-validation concurrency.

The P2Pool consensus behavior remains unchanged from v0.2.4. The `cli-next` branch also contains build and release preparation changes.

## Compatibility

- CLI: `0.2.5-rc1`
- Contract: `v0.15.85+ global-epoch-v4`
- contract: `org.contract.byze-p2pool@0.1.3`
- contract source hash: `0ba509a74eb5f475ce41f152349fe49a7d19e4fbd6c14c1833632c61681a0b66`
- pool: `byze-main-p2pool-v1`
- proof mode: `byze-randomx-v2`
- security generation: `coinbase-binding-v2-global-epoch-v4`
- native miner feature: `contract-direct-coinbase-v2`
- PPLNS window: 20 PoolShares
- cell size: up to 20 miners; global epoch aggregation combines valid cell checkpoints
- pool fee: 50 bp = 0.50%

See `COMPATIBILITY.json` for machine-readable compatibility metadata.

## Requirements

- Node.js 20 or newer;
- a local, synchronized BYZE mainnet node (`chain=main`, `initialblockdownload=false`);
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

To install dependencies and verify a prebuilt native bundle:

```bash
npm ci
npm run check
npm test
npm run native:ensure
./byze-p2pool --dry-run --alias Test --wallet YOUR_BYZE_ADDRESS --threads 1
```

`install.sh` performs the same checks and **does not compile missing native code automatically**.

On Linux x64, `cli-next` already includes a native bundle; successful verification does not require compilation. Node.js and a synchronized BYZE node are still required. Use your own public BYZE payout address in the command above.

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

If a verified bundle already exists, the bootstrap reuses it. When components are missing, this explicitly clones the official `powhermes/byze-miner` repository, checks out the pinned commit, verifies the checkout is clean and its submodules are at the expected revisions, copies the source to an isolated work directory, patches **only the copy**, builds the P2Pool-native binaries, writes their SHA-256 manifest and verifies the resulting managed bundle.

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

The CLI license is MIT and a Linux x64 bundle is present. The public preflight still fails while blocking items remain unchecked, including signing, upstream redistribution confirmation and documented mainnet validation. It is a release-maintainer check, not a prerequisite command for starting the CLI. See `RELEASE-CHECKLIST.md` and `THIRD_PARTY-NOTICES.md`.

## Tests

```bash
npm ci
npm run check
npm test
```

The suite covers consensus/fork-choice/global-epoch scaling, coinbase attacks, native isolation/integrity, pinned native source trust, mainnet fail-closed behavior, P2P rate limiting and expensive-validation bounds.

## Release signatures

The release tooling can create and sign a detached release manifest with a dedicated offline Ed25519 key. No private release key is included in this repository or source archive. See `tools/release-manifest.js`, `tools/release-sign.js` and `tools/release-verify.js`.


## Beta 1 platform support

BYZE P2Pool CLI Beta 1 is publicly supported on **Linux x86-64 only**.

Recommended environment:

- Ubuntu 24.04 LTS or another recent compatible Linux distribution;
- x86-64 CPU;
- a synchronized BYZE mainnet node.

macOS and Windows are not advertised as supported platforms for Beta 1.

The distributed Linux native components are SHA-256 pinned and reproducible
with the documented Docker reproducibility procedure.
