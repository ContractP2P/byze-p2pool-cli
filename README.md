# BYZE P2Pool CLI

Mine BYZE with a standalone peer-to-peer CPU mining CLI powered by RandomX and Hyperswarm.
**The Electron Contract application is not required.** A synchronized BYZE node and `byze-cli` are required.

- Direct PPLNS payouts in the block coinbase; pool fee: **0.50%**.
- Temporary P2P identity; no persistent Contract profile.
- No wallet seed, wallet private key or wallet passphrase is requested by the CLI.
- This branch: **0.2.5-rc2**, a source release candidate. See [CLI compatibility and upgrade notes](cli/README.md#upgrade-coordination) before running it.
- Initial public support target: **Linux x86-64** (Ubuntu 24.04 is the documented target).

## Current availability

This source candidate uses P2Pool generation v5. Existing `cli-next` packages use the previous generation and do not contain these changes. The installation instructions below describe that earlier package; use the [CLI source documentation](cli/README.md) to review this candidate.
Use the source checkout instructions below today. Release archives will be listed on the repository's **Releases** page when published; no downloadable release is announced by this README.

The repository also contains macOS Apple Silicon components, but macOS and Windows are not advertised as supported platforms for this first Linux release.

## Requirements

| Requirement | Details |
| --- | --- |
| Operating system | Linux x86-64; Ubuntu 24.04 is the documented target. Compatibility with other distributions is not yet established. |
| JavaScript runtime | Node.js 20 or newer, with npm. The native binaries do not replace the Node.js CLI. |
| BYZE node | A running, synchronized mainnet node with `chain=main` and `initialblockdownload=false`. |
| RPC client | `byze-cli` must already be able to communicate with the node. |
| Payout address | A valid public BYZE address that you control. |
| Network | Internet access for npm installation and P2P discovery/communication. |

This package does not install the BYZE node or `byze-cli`. Set those up first.
Check your node with:

```bash
byze-cli getblockchaininfo
```

If the command fails, fix the node connection before starting the miner. The CLI also refuses a node that is materially behind its known headers.

## Option A — run from the repository

This runs the JavaScript source with the prebuilt Linux components already committed to `cli-next`. **No native compilation is needed when that bundle passes verification.**

```bash
git clone --branch cli-next --single-branch https://github.com/ContractP2P/contract-dev.git byze-p2pool-cli
cd byze-p2pool-cli/cli
npm ci
npm run native:ensure
./byze-p2pool --help
```

The clone URL above uses the repository's current name. If the repository is renamed, use its new clone URL.

## Option B — install a release archive

Use this method once a release has been published. Download the attached `byze-p2pool-cli-0.2.5-rc1.tar.gz` and `release-manifest.json` from that release, into the same directory.
Choose the attached CLI package, not GitHub's automatically generated source-code archive.

Before extraction, verify the archive checksum:

```bash
node -e 'const fs=require("fs"),c=require("crypto");const m=JSON.parse(fs.readFileSync("release-manifest.json","utf8"));const h=c.createHash("sha256").update(fs.readFileSync(m.artifact)).digest("hex");if(h!==m.artifactSha256){console.error("Checksum mismatch");process.exit(1)}console.log("SHA-256 OK")'
```

Only continue if it prints `SHA-256 OK`. A checksum detects a mismatch; an unsigned manifest does not authenticate the publisher. Follow the release notes for signature availability.

```bash
tar -xzf byze-p2pool-cli-0.2.5-rc1.tar.gz
cd byze-p2pool-cli-0.2.5-rc1/cli
npm ci
npm run native:ensure
./byze-p2pool --help
```

Keep the `native/linux-x64/` directory and its `native-manifest.json` together. Do not move the native binaries into `PATH` or replace them with an unrelated miner.

## Check your setup, then start mining

Run the following from the `cli` directory. Replace `YOUR_BYZE_ADDRESS` with your own public payout address:

```bash
./byze-p2pool --dry-run \
  --alias Miner01 \
  --wallet YOUR_BYZE_ADDRESS \
  --threads 2
```

`--dry-run` checks the node, payout address, policy and native components without starting mining or P2P networking.
After `Dry-run OK`, start mining:

```bash
./byze-p2pool \
  --alias Miner01 \
  --wallet YOUR_BYZE_ADDRESS \
  --threads 2
```

Stop with **Ctrl+C**. The CLI stops its worker and destroys its temporary P2P identity.

If `byze-cli` is not detected, add its executable path to either command:

```bash
./byze-p2pool --alias Miner01 --wallet YOUR_BYZE_ADDRESS --threads 2 \
  --byze-cli /absolute/path/to/byze-cli
```

Alternatively, set `BYZE_CLI` to that executable path. RPC settings are those used by `byze-cli`; the mining CLI does not expose RPC host/password flags.

Without alias, wallet or thread arguments, the CLI prompts interactively for the missing values:

```bash
./byze-p2pool
```

For scripts and unattended use, supply all three values explicitly.

## Launch parameters

Use `--option VALUE` syntax.

| Option | Purpose |
| --- | --- |
| `--alias NAME` | Name announced to the pool. Use quotes if it contains spaces. |
| `--wallet ADDRESS` | Public BYZE address receiving your mining payouts. |
| `--threads N` | RandomX CPU threads; clamped between 1 and the available logical CPU count. |
| `--byze-cli PATH` | Path to the BYZE RPC client executable. |
| `--native-dir PATH` | Directory containing both native binaries and their manifest, such as `/path/to/native/linux-x64`. |
| `--policy PATH` | Pool policy JSON; defaults to the package's `config/pool-policy.json`. |
| `--dry-run` | Validate prerequisites without starting mining or P2P networking. |
| `--no-submit` | Diagnostic mode: participates in mining but never submits a found network block. Do not use for normal mining. |
| `--version` | Print the CLI version and exit. |
| `--help` | Print available options and exit. |

Keep the supplied policy for the official pool. Changing its fee policy/address changes the discovery topic and prevents you from joining peers using the official policy.
`--miner-dir` is no longer supported.

## Native compilation — developers only

Cloning this repository does not require recompiling the native miner. If you deliberately need a developer build because native components are missing, the bootstrap command fetches the pinned upstream source and builds an isolated copy.

On Ubuntu 24.04, the build tools include:

```bash
sudo apt-get update
sudo apt-get install -y build-essential cmake git pkg-config libboost-dev libssl-dev
```

Then, from `cli/`:

```bash
npm ci
npm run native:bootstrap-official
npm run native:ensure
```

The bootstrap reuses an already valid bundle. It does not force a rebuild and refuses to silently replace components that fail integrity checks.
It pins upstream `powhermes/byze-miner` commit `d84db8a84ba4a06432fcdddbf1584b89a7e52379` and requires a clean source checkout.
This developer procedure is not a claim of support for additional operating systems.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `byze-cli not found` | Supply `--byze-cli /absolute/path/to/byze-cli`. |
| Node not ready / initial block download | Wait for the mainnet node to synchronize; inspect `byze-cli getblockchaininfo`. |
| Invalid payout address | Replace the example with your actual BYZE address. |
| Missing native components on Linux | Confirm you checked out `cli-next` and have `native/linux-x64/`, then run `npm run native:ensure`. |
| Native checksum mismatch | Obtain a fresh trusted bundle. Do not disable verification or edit the expected checksum to accept an unknown binary. |
| Missing shared library / incompatible Linux binary | Use the documented Ubuntu 24.04 x64 environment, or investigate a developer build for your environment. |
| No peers | Check Internet access and whether peers use the same pool policy and compatible protocol. |

## Development and release status

From `cli/`:

```bash
npm run check
npm test
npm run release:preflight
```

On 1 October 2026, the maintainer's Codespace run passed **61 tests** and verified the Linux native bundle. These checks do not by themselves establish end-to-end mining correctness.

The public-release checklist still records open items for artifact signing, upstream redistribution terms and documented mainnet validation. `release:preflight` intentionally fails while those items remain unchecked; it is a maintainer release check, not the command used to start mining.

See the [current technical README](https://github.com/ContractP2P/contract-dev/blob/cli-next/cli/README.md),
[release checklist](https://github.com/ContractP2P/contract-dev/blob/cli-next/cli/RELEASE-CHECKLIST.md),
[security policy](https://github.com/ContractP2P/contract-dev/blob/cli-next/cli/SECURITY.md) and
[third-party notices](https://github.com/ContractP2P/contract-dev/blob/cli-next/cli/THIRD_PARTY-NOTICES.md).

The CLI on `cli-next` is licensed under [MIT](https://github.com/ContractP2P/contract-dev/blob/cli-next/cli/LICENSE). Native components and dependencies retain their own license terms.
