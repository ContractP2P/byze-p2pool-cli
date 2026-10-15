# BYZE P2Pool CLI

**Peer-to-peer CPU mining for BYZE** — a standalone RandomX miner using Hyperswarm discovery, direct PPLNS coinbase payouts, and a **0.50% pool fee**. No Electron or Contract desktop application is needed.

**[▶ Open the guided installer — macOS Apple Silicon, macOS Intel & Linux x64](https://contractp2p.github.io/byze-p2pool-cli/)**

> **Community testing only · Community Test 1 · CLI v0.2.5-rc4-community.1 · global-epoch-v6 · [Community Test 1 release](https://github.com/ContractP2P/byze-p2pool-cli/releases/tag/v0.2.5-rc4-community.1).** Native test bundles are published but **unsigned and not yet production-qualified**. Mainnet multi-peer payout validation, spendability checks and signing/release gates remain open. See [release status](cli/RELEASE-CHECKLIST.md). Mining rewards are never guaranteed.

## Choose how to install

| Option | Best for | What you get |
| --- | --- | --- |
| **1. [Guided installation (recommended)](https://contractp2p.github.io/byze-p2pool-cli/)** | Miners who want to get started without compiling | Platform-specific complete test bundle, a BYZE Core detection/reuse check, and personalized mining commands |
| **2. [Git clone / source installation](#2-install-from-source-developer-path)** | Developers, reviewers and people building their own native components | Editable source, JavaScript tests, and an explicit optional native build |

### 1. Guided installation (recommended)

Open **https://contractp2p.github.io/byze-p2pool-cli/** and:

1. Select **Mac Apple Silicon (ARM64)**, **Mac Intel (x86-64)** or **Linux (x86-64)**.
2. Enter a **public BYZE receiving address**, a miner alias and the desired CPU thread count. **Never enter a seed phrase or private key.**
3. Copy **Install the complete package** into your Terminal. The installer checks for an existing BYZE Core first: **existing Core is reused, never reinstalled or upgraded**. If no installation is found, the official Core is offered **only after explicit confirmation**.
4. If Core is synchronizing, leave it running. The updated guided installer displays **block-height progress every 30 seconds**, for example `BYZE synchronization: 7006 / 21059 blocks (33.3% by height); IBD: true`. Wait for `BYZE_NODE_READY` before mining. The percentage is an **approximation based on block heights**, not Core's `verificationprogress` estimate.
5. Copy the **personalized mining command** from the website when the node is ready.

The installer fetches a complete platform bundle with bundled Node.js, JavaScript dependencies and verified-by-SHA-256 native RandomX executables: **no Git, npm or compiler is needed for this path**. Downloaded P2Pool bundles are still unsigned experimental artifacts. On a machine with **no existing Core**, the Linux guided installer offers official **BYZE Core v0.2.5-rc5-change-keyspace**; an existing Core is **never upgraded or reinstalled**. Because rc5 can perform a one-way wallet migration after a payment or change-address request, back up `wallet.dat` before independently upgrading a wallet from older Core versions.

**Stopping and resuming synchronization monitoring:** `Ctrl+C` stops only the installer monitor, **not** the running BYZE Core node. To resume without reinstalling, run the already downloaded script with `--wait-sync`, or fetch the current script again:

```bash
# macOS: refresh the public installer script, then resume monitoring
curl -fL --retry 3 https://contractp2p.github.io/byze-p2pool-cli/install-macos.sh \
  -o "$HOME/Downloads/byze-p2pool-first-run-macos.sh"
bash "$HOME/Downloads/byze-p2pool-first-run-macos.sh" --wait-sync

# Linux: fetch the current installer script, then resume monitoring
curl -fL https://contractp2p.github.io/byze-p2pool-cli/install-linux.sh \
  -o /tmp/byze-p2pool-install-linux.sh
bash /tmp/byze-p2pool-install-linux.sh --wait-sync
```

The miner command displayed by the website **enables real mainnet block submission**. For diagnostic mining that cannot submit a found block, add `--no-submit` to that command. Neither mode should be used until BYZE Core is fully synchronized and the payout address has been checked for **actual wallet spendability**.

**Current community test packages (15 October 2026):** [macOS Apple Silicon, macOS Intel, and Linux x64 — Community Test 1](https://github.com/ContractP2P/byze-p2pool-cli/releases/tag/v0.2.5-rc4-community.1) · [All releases](https://github.com/ContractP2P/byze-p2pool-cli/releases). The guided installers pin the exact SHA-256 for each platform and also verify the release manifest.

**Already installed an earlier experimental CLI?** Fetch the updated guided installer and run `--install` again after stopping the existing P2Pool miner. The Community Test 1 build has a **unique internal version**, and installs to a **new versioned directory** and the managed `~/.local/bin/byze-p2pool` launcher is repointed to it. The previous P2Pool files are not deleted. An existing **BYZE Core node is never reinstalled or upgraded**. `--wait-sync` only monitors synchronization; it does not update the CLI.

### 2. Install from source (developer path)

Clone the repository and validate the JavaScript source:

```bash
git clone https://github.com/ContractP2P/byze-p2pool-cli.git
cd byze-p2pool-cli/cli
npm ci
npm run check
npm test
npm run release:preflight:source
node src/byze-p2pool.js --help
```

**Requirements:** Git, Node.js **20+**, npm and (for mining) a synchronized BYZE mainnet Core RPC endpoint. These steps **do not install BYZE Core or produce native RandomX binaries**.

If you want to **build the native miner locally** for development, explicitly run:

```bash
./install-dev.sh
```

This developer-only script builds a managed native bundle from a pinned official upstream source; it requires the appropriate platform build tools. It does not replace an installed BYZE Core. See the [technical README](cli/README.md#developer-only-native-bootstrap) for prerequisites and verification details.

After native setup, check your existing Core and run a non-mining preflight:

```bash
node src/byze-p2pool.js --check-node --byze-cli /absolute/path/to/byze-cli

./byze-p2pool --dry-run \
  --alias TestMiner \
  --wallet YOUR_VERIFIED_PUBLIC_BYZE_ADDRESS \
  --threads 2 \
  --byze-cli /absolute/path/to/byze-cli
```

Only after the dry-run passes, a diagnostic RandomX session can be started with `--no-submit`:

```bash
./byze-p2pool \
  --alias TestMiner \
  --wallet YOUR_VERIFIED_PUBLIC_BYZE_ADDRESS \
  --threads 2 \
  --byze-cli /absolute/path/to/byze-cli \
  --no-submit
```

Without `--no-submit`, a found network block **may be submitted to BYZE mainnet**. The source installation does **not** automatically compile missing native code when you run `./byze-p2pool` without performing the developer bootstrap.

## How P2Pool works

- Each miner computes **RandomX** hashes locally; P2P peers communicate through **Hyperswarm**.
- Validated shares contribute to the **PPLNS** payout window, and candidates commit miner payouts plus the **0.50% fee directly in the coinbase**.
- **Generation v6** has its own discovery topic and PPLNS history; it is **incompatible with older v4/v5 peers**. Coordinate restarts if upgrading a pool.
- The CLI does not ask for BYZE wallet secrets and uses temporary P2P identities. `validateaddress` does **not** prove that a payout address is spendable. Prefer an address obtained and independently verified on **BYZE Core rc4 or later**. Older Core versions can be reused, but may not confirm spendability.

A synchronized node means `chain=main`, a non-empty blockchain, matching/near-matching block and header heights, and `initialblockdownload=false`. **Older 13 October rc3 binaries may misclassify a freshly started zero-block Core as ready.** The Community Test 1 packages include fail-closed node readiness, RandomX pause/resume handling and private capture of a submitted block's committed PPLNS window. The guided installers also independently require nonzero block height and `initialblockdownload=false` before displaying `BYZE_NODE_READY`. The latest binaries still need live multi-peer outage and payout validation.

## Auditable block payouts and Discord

The published Community Test 1 packages record **private** PPLNS evidence of a successful `submitblock` RPC, but may save **no file** for a block discovered before the first PPLNS tip exists. **Correction in [PR #41](https://github.com/ContractP2P/byze-p2pool-cli/pull/41)**: source code now retains separate `bootstrap`, `pplns`, or `incomplete` private records; a **new build/release is required** to deliver it to community miners. A submission record is **not** evidence that the block was accepted by the network. The evidence remains local unless the operator chooses to submit a privacy-reviewed record to GitHub. See [Discord reporting and review procedure](docs/discord-reporting.md).

Discord block reports are allowed only after a separately reviewed attribution is merged, the record is SHA-256 pinned, and the read-only monitor verifies six confirmations, on-chain coinbase outputs, exact PPLNS amounts and the 0.50% fee. No found block has been certified by this process yet. The scheduled activity report is separate.

## Status and technical references

Public **Community Test 1** experimental bundles from **15 October 2026** exist for Apple Silicon, Intel macOS and Linux x64. They are for **community testing, not production deployment**. ARM64 local mining and Mac Intel clean-host installation have been exercised; this does **not** yet qualify real two-peer PPLNS payouts or prove that a discovered block is spendable. The public packages are **unsigned**, and their third-party notices, licensing and final release signing still need review.

- [Guided installation website](https://contractp2p.github.io/byze-p2pool-cli/)
- [CLI documentation and developer bootstrap](cli/README.md)
- [Security policy](cli/SECURITY.md)
- [Release and validation checklist](cli/RELEASE-CHECKLIST.md)
- [Third-party notices](cli/THIRD_PARTY-NOTICES.md)
- [RPC recovery / soak tracking — issue #3](https://github.com/ContractP2P/byze-p2pool-cli/issues/3)
- [Draft community-testing announcement](docs/community-testing-announcement.md)
- [Project MIT license](LICENSE)

**Licensing:** BYZE P2Pool CLI source is released under the [MIT License](LICENSE) (`cli/LICENSE` is provided for standalone CLI distributions). Bundled third-party components retain their separate license terms, listed in [third-party notices](cli/THIRD_PARTY-NOTICES.md). Previously published test artifacts remain experimental and unsigned.
