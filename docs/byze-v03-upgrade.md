# BYZE v0.3.0 — hard fork and safe P2Pool CLI migration

> **Experimental / not a production release.** Hard fork: **mainnet height 28,000**, not a fixed calendar date. P2Pool source candidate: `0.3.0-rc1.dev` on branch `fix/byze-v0.3-p0-hardfork`. Previous Community Test 2 archives (`0.2.5-rc4-community.2`) were built before this fork and must **not** be presented as v0.3-compatible.

## Protocol changes and limits

- Byze Core release: [v0.3.0-stateless-pq](https://github.com/powhermes/byze/releases/tag/v0.3.0-stateless-pq), with notarized macOS builds and signed SHA-256 checksums.
- At height 28,000, coinbase outputs may pay **witness-v2 stateless** addresses (`byz1z…`, script `5220` plus 32-byte program). **Before** height 28,000 they are not valid payout destinations. Legacy `byz1p…` / `5120` outputs remain valid, subject to the XMSS signature-use limit.
- From the fork height, every block header must retain **bit 4** (`0x10`) as supplied by Byze Core's `getblocktemplate.version`. **Never rewrite the version** in the JS supervisor or native RandomX miner. The CLI now refuses a mismatched header or an obsolete Core. Verify with a regtest Core before enabling real block submission.
- `signpoolblock` must not change the 80-byte block header; signed candidates must pass proposal validation before submission. `--no-submit` disables publication entirely.
- New addresses do not prove **ownership**, **wallet spendability** or **confirmed payout**. Those remain separate checks. Existing PPLNS multi-peer release gates remain open.

## Public installers: transition policy

The public guided P2Pool installer is **temporarily paused** in this source branch. The earlier complete P2Pool archives are still downloadable as historical test artifacts but are **not** replaced by rewriting the tag name or skipping checksum verification. The Mac and Linux installers pin **official Core v0.3.0** for *new* Core installations; they always preserve an existing Core and wallet. `--probe`, `--wait-sync` and Linux `--install-core` remain available. Re-enable P2Pool `--install` only after publishing full, audited, checksum-pinned v0.3-compatible P2Pool bundles for each platform, and update the website release table and launcher version.

## P1 — Fee-address migration: separate coordinated decision

The current pool fee address is `byz1p…`, which has the legacy XMSS signature limit. **It remains unchanged in this branch.** Do not invent a `byz1z…` replacement: an authorized fee wallet must actually own the destination and independently verify that it can spend received rewards. Use Byze Core v0.3.0 to get a new **wallet-owned** stateless address:

```bash
# In the *actual fee wallet only*, with a verified wallet backup:
byze-cli -rpcwallet=YOUR_FEE_WALLET getnewstatelessaddress "p2pool-fee"
```

This RPC creates an address; it does not transfer coins. The stateless destination can be prepared before activation, but cannot receive valid P2Pool coinbase outputs before height 28,000.

Use the read-only planning tool from the `cli/` directory:

```bash
node tools/plan-fee-migration.js \
  --candidate 'byz1z...actual-verified-address...' \
  --byze-cli "$HOME/ldev/byze-v0.3.0/byze-cli"
```

It verifies the candidate with `validateaddress`, checks Core version, and previews **old and new** fee-policy hashes. It makes **no changes** to `config/pool-policy.json` and does **not** verify wallet ownership. A different fee address changes `policyHash` and thereby the P2P discovery topic: existing peers **cannot** share a PPLNS window with peers on the new policy. Record/reconcile any pending work and commission obligations, agree on a cutover point, then coordinate a clean restart of all miners. Do not turn on this migration during the Mac smoke test.

## P2 — macOS Apple Silicon: verify a new source build without touching Core

The commands below run on the operator's Mac, **not** on GitHub. They do not replace, update, stop or migrate `byzed`; the existing node `~/ldev/byze-v0.3.0/byzed` keeps running with its existing 16 wallets. The first stage does **not** modify the old P2Pool launcher.

**1. Inspect the active miner and its launcher.** If a P2Pool miner is running, stop it gracefully in its own terminal (Ctrl+C) before proceeding. Do **not** kill `byzed`.

```bash
pgrep -fl 'byze-p2pool|byze-p2pool-miner' || true
command -v byze-p2pool || true
if [ -f "$HOME/.local/bin/byze-p2pool" ]; then
  sed -n '1,12p' "$HOME/.local/bin/byze-p2pool"
fi
"$HOME/ldev/byze-v0.3.0/byze-cli" getnetworkinfo | grep -E '"version"|"subversion"|"connections"'
```

**2. Install the experimental source in a new directory, leaving the previous CLI untouched.** Choose a fresh directory name if it already exists.

```bash
set -e
TESTDIR="$HOME/ldev/byze-p2pool-cli-v03-review"
if [ -e "$TESTDIR" ]; then echo "Directory already exists — inspect it, do not overwrite"; exit 1; fi
git clone --branch fix/byze-v0.3-p0-hardfork --single-branch \
  https://github.com/ContractP2P/byze-p2pool-cli.git "$TESTDIR"
cd "$TESTDIR/cli"
npm ci
npm run check
npm test
npm run release:preflight:source
npm run native:ensure
node src/byze-p2pool.js --version
node src/byze-p2pool.js --check-node \
  --byze-cli "$HOME/ldev/byze-v0.3.0/byze-cli"
```

Expected source CLI version: **`0.3.0-rc1.dev`**. The `native:ensure` check reads the bundled Mac ARM native manifest and verifies the SHA-256 and pinned upstream commit; it must succeed before P2P testing. It does not build from arbitrary local miner sources.

**3. Check a real payout address and run a non-mining dry run.** Before the fork, use a fresh **wallet-owned `byz1p…` legacy address**, not a `byz1z…` address. You may generate one from a dedicated, backed-up mining wallet with:

```bash
# Only if you want a new receive address:
"$HOME/ldev/byze-v0.3.0/byze-cli" \
  -rpcwallet=YOUR_BACKED_UP_MINING_WALLET getnewaddress
```

Record the returned public address as `PAYOUT` below (do **not** paste private keys, phrases, or wallet files into the chat):

```bash
cd "$HOME/ldev/byze-p2pool-cli-v03-review/cli"
PAYOUT='PASTE_YOUR_VERIFIED_PUBLIC_BYZ1P_ADDRESS'
./byze-p2pool --dry-run --alias MacArm-V03 --wallet "$PAYOUT" \
  --threads 2 --byze-cli "$HOME/ldev/byze-v0.3.0/byze-cli"
```

If the dry run succeeds, run a **short diagnostic P2P session with no mainnet block submission**:

```bash
./byze-p2pool --alias MacArm-V03 --wallet "$PAYOUT" \
  --threads 2 --byze-cli "$HOME/ldev/byze-v0.3.0/byze-cli" --no-submit
```

This still sends P2P communications and uses CPU. Stop with Ctrl+C. Confirm native hashrate, peer discovery, share acceptance, no fork errors, and **no submitted blocks**. The old fee-address spendability and future two-peer payout tests remain gating issues for real mining.

**4. Replace only the managed CLI launcher (after the diagnostic passes).** Do not edit the prior package or delete it. The following backs up a managed launcher and atomically points `~/.local/bin/byze-p2pool` to the tested source; it refuses unmanaged files or symlinks.

```bash
set -e
test "$(uname -m)" = arm64
NEW="$HOME/ldev/byze-p2pool-cli-v03-review/cli"
CLI="$HOME/ldev/byze-v0.3.0/byze-cli"
LAUNCHER="$HOME/.local/bin/byze-p2pool"
if pgrep -fl 'byze-p2pool-miner|/src/byze-p2pool.js' >/dev/null; then
  echo "Stop the running P2Pool process first"; exit 1
fi
test -x "$CLI"
test -f "$NEW/src/byze-p2pool.js"
test "$(node "$NEW/src/byze-p2pool.js" --version)" = 0.3.0-rc1.dev
mkdir -p "$HOME/.local/bin"
if [ -e "$LAUNCHER" ] || [ -L "$LAUNCHER" ]; then
  if [ -L "$LAUNCHER" ] || ! grep -qx '# BYZE_P2POOL_MANAGED_LAUNCHER' "$LAUNCHER"; then
    echo "Unmanaged launcher or symlink — stop, do not replace"; exit 1
  fi
  cp -p "$LAUNCHER" "$LAUNCHER.pre-v03.$(date +%Y%m%d-%H%M%S)"
fi
TMP_LAUNCHER="$(mktemp "$HOME/.local/bin/byze-p2pool.XXXXXX")"
cat > "$TMP_LAUNCHER" <<'EOF'
#!/bin/sh
# BYZE_P2POOL_MANAGED_LAUNCHER
BYZE_CLI="$HOME/ldev/byze-v0.3.0/byze-cli"
export BYZE_CLI
exec node "$HOME/ldev/byze-p2pool-cli-v03-review/cli/src/byze-p2pool.js" "$@"
EOF
chmod 0755 "$TMP_LAUNCHER"
"$TMP_LAUNCHER" --version
mv -f "$TMP_LAUNCHER" "$LAUNCHER"
"$LAUNCHER" --version
"$LAUNCHER" --check-node
```

Expected: `0.3.0-rc1.dev` and `BYZE_NODE_READY`. **The prior versioned package remains on disk as rollback material.** The launcher is the only path replaced; no Core/wallet/blockchain file is changed. If an old unmanaged shell alias, another `PATH` executable or background service is in use, inspect it separately rather than overwriting it.

**Rollback:** if needed, stop the new P2Pool process, inspect the timestamped `$LAUNCHER.pre-v03.*` backup, then copy the selected managed backup back to `$LAUNCHER`. Do not roll back the *Byze Core v0.3.0 node*.

## Required release evidence

Passing unit tests, `--check-node`, dry-run or `--no-submit` is not proof that a real found block or PPLNS payout will be accepted/spendable. Before publishing a fork-ready package: test on isolated `byzed` v0.3.0 regtest with fork activation at height 28,000 (or overridden activation on regtest), create and spend stateless outputs, test native block candidates / proposal acceptance, demonstrate PPLNS payout and 0.50% fee accounting for **at least two peers**, then repeat on actual mainnet with the release gates and operator approvals. Never use test wallet seeds on mainnet.
