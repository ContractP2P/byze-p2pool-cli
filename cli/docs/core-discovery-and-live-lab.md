# Existing BYZE Core discovery and safe acquisition

This guidance applies to **byze-p2pool-cli**, independently of SafeLabEnv.

## What the program does, and what it does not

`byze-p2pool --check-node` is a read-only preflight: it searches for a
`byze-cli` RPC client and executes only `getblockchaininfo` against each
eligible candidate. It requires no mining alias or receiving address and
does not launch native miners, contact DHT peers, install packages or start
a BYZE daemon.

Resolution precedence:

1. `--byze-cli ABSOLUTE_PATH` (strict override; no fallback).
2. `BYZE_CLI` environment path (strict override; no fallback).
3. Existing executable in absolute directories of `PATH` (not a relative
   or empty directory).
4. Established BYZE build locations in the user's home directory.

For automatic discovery, an available but disconnected candidate is skipped
and the next candidate is tested. The **first actually mainnet-synchronized
RPC endpoint** is reused. BYZE Core's `chain`,
`initialblockdownload`, `blocks` and `headers` fields are verified
through the existing `assertMainnetReady()` routine, which also rejects
nodes more than two blocks behind their known headers.

A discovered `byze-cli` executable is a client and **is not proof of
a local `byzed` process**. It may use a configured remote RPC endpoint.
The preflight deliberately reports daemon locality as `unknown`.
It does not inspect wallet directories, print RPC secrets, scan TCP ports,
install a blockchain or start a second daemon.

Possible results:

- `BYZE_NODE_READY`: reuse that RPC client; no Core installation.
- `BYZE_NODE_NOT_READY`: missing executable or none usable. If a client
  exists but the daemon is unavailable, on another chain or unsynchronized,
  repair the current endpoint; do **not** install a duplicate Core node.

To examine an existing local Mac node before any experiment:

```bash
node cli/src/byze-p2pool.js --check-node \
  --byze-cli "$HOME/ldev/byze/build/bin/byze-cli"
```

Or inside the extracted portable Linux bundle:

```bash
linux-x64/bin/byze-p2pool --check-node --byze-cli /path/to/existing/byze-cli
```

The portable archive contains the P2Pool program, Node.js and native
RandomX parts, **not** a BYZE Core daemon or connected client.

## Consent-only verified Core archive acquisition

`--setup-core` is optional and only runs in an *interactive terminal*
when no `byze-cli` executable was detected. It asks the user to enter the
literal word `DOWNLOAD` before invoking the existing
`tools/download-core.js` helper. The helper downloads the fixed rc4
archive, verifies its pinned SHA-256 plus GPG signature, and requires a
**new, nonexisting** destination under the user's home folder. GnuPG and
HTTPS access on the user's computer are required.

**No extraction, Core installation, systemd launch, blockchain download,
RPC configuration or wallet modification is performed.** A second node is
never started as part of this action. A CLI binary that exists but cannot
connect to Core leads to diagnostic guidance, not automatic acquisition.

## Mac -> SafeLabEnv -> P2Pool acceptance sequence

Mac acts as the **controller**. The portable Linux-x64 bundle is executed
inside SafeLabEnv's Ubuntu KVM guest, not directly on macOS. No additional
BYZE node is installed inside that microVM.

1. Run `--check-node` on Mac against the existing Core client to confirm
   chain/readiness, and independently verify whether its RPC is local or
   remote through its configuration. For production pool operation, prefer
   BYZE Core rc4+ (with receiving-wallet addresses independently validated).
2. Keep the current offline SafeLabEnv service unchanged until the **generic
   trusted network/renewable lease** Stage 1 of 2 (SafeLabEnv PR #30)
   has passed real KVM negative and positive egress probes, port/protocol
   firewall rules, expiring lease/orphan cleanup and guarded rollback.
3. Use the **already built experimental complete Linux archive** from the
   BYZE portable GitHub Actions workflow. Operator-opt-in 64MiB inputs are
   required for its ~53MiB archive; current installed SafeLabEnv only
   accepts 8MiB.
4. Provision an **explicitly approved external test node/RPC gateway** at
   a fixed destination allowed by the SafeLabEnv operator. It must not expose
   production Core RPC credentials or wallet operations to test guests.
   The present `ByzeCli` adapter uses executable `byze-cli`, so the lab
   must provide a tested client/gateway arrangement; `--check-node` will
   fail closed if none is usable.
5. First run `--dry-run` with valid test receiving address, then two
   compatible v6 P2Pool participants with `--bootstrap` pointing only to
   controlled private-DHT endpoints and `--no-submit`.
6. Verify native worker hashrate, peer connection, valid PoolShares,
   checkpoint/PPLNS accounting, lease renewal for longer than the original
   180-second normal job window, then cease renewing and verify complete
   KVM/cgroup teardown.

**Live miner acceptance is not yet proven.** No unrestricted Internet
egress, node relaunch, wallet secrets or production block submission should
be added to sidestep the network gates.
