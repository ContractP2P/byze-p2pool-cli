# Stage 2 of 2 — Complete P2Pool CLI packaging and controlled P2P validation

**Target:** a tester downloads ONE Linux-x64 complete application archive,
does not have to install Node.js or npm, and can run the BYZE P2Pool CLI.
This is an experimental lab package; it is NOT yet a public signed release
and does not eliminate the blockchain node prerequisite.

## Contents produced by GitHub Actions

Workflow `.github/workflows/portable-lab.yml` compiles the native miner and
RandomX verifier from the pinned upstream official source and stages:

- `linux-x64/bin/node` — a matching Node.js 22 Linux runtime
- `linux-x64/bin/byze-p2pool` — relocatable POSIX launcher
- `linux-x64/app/src/` — complete P2Pool CLI orchestrator
- `linux-x64/app/node_modules/` — locked production dependencies
- `linux-x64/app/native/linux-x64/` — miner, verifier, hash/source manifest
- `linux-x64/app/config/` — pool policy
- `linux-x64/app/tools/test-private-dht.js` — private DHT test
- third-party notices, licenses, pinned compatibility metadata

The workflow verifies the native SHA-256 manifest and required
`contract-direct-coinbase-v2` capability; runs Node `--version`,
CLI `--help`, and a **two-peer local-bootstrap/private DHT test** inside
the extracted package. The workflow publishes a short-lived unsigned
artifact plus `SHA256SUMS`. It never embeds RPC passwords or wallet secrets.

On Oct 12, 2026, the first complete-package CI workflow passed and produced
artifact `byze-p2pool-complete-lab-linux-x64` (GitHub Actions run
`38242376907`, archived artifact about **53 MiB**). The later workflow
also packages the private DHT harness and needs its own CI verification.

A 53-MiB archive cannot be uploaded through the deployed SafeLabEnv's
**8 MiB** input endpoint. The Stage 1 operator-only 64 MiB upload extension
has been proposed to address that; it is NOT live yet.

## Existing Core detection without duplicate-node installation

The complete Linux CLI now supports `--check-node` (no mining options
required), strict `--byze-cli PATH` overrides, reuse of a healthy RPC
endpoint and `--setup-core` (explicit consent before a pinned/signed
Core archive download, with **no** daemon startup or wallet modifications).
Client detection does not prove whether the responding daemon is on the
same machine. Before connecting the SafeLabEnv guest to Core, use the
controlled gateway arrangement defined in
[Core discovery and live lab](core-discovery-and-live-lab.md). The
network/lease policy belongs exclusively to SafeLabEnv.

## User-side prerequisites — precise wording

With the complete artifact, a user does **not** need to install Node/npm,
compile RandomX, or clone the upstream native miner. However:

- A BYZE Core rc4+ **mainnet synchronized node** is still required.
- The CLI currently runs **`byze-cli`** to communicate with that node.
  This experimental bundle does not include a verified BYZE Core installation.
- Real mining requires a valid **receiving address**, trusted RPC access to
  the node and network reachability to compatible v6 P2Pool peers.
- A standalone executable with zero external prerequisites is **not yet
  available**. The separate Core dependency must remain explicit.
- No real mainnet block submission is attempted by this lab workflow.

## Deterministic two-step qualification (no further feature expansion)

### First: SafeLabEnv infrastructure is qualified separately
Wait for the generic Stage 1 branch's real KVM egress/lease/64-MiB upload
canaries and operator-controlled rollback to succeed. Do not remove the
existing offline mode or open the VPS to the Internet.

### Second: BYZE integration / release decision
1. Upload the signed/checksummed experimental complete archive to the trusted
   SafeLabEnv environment once 64-MiB binary input is authorized.
2. Extract inside a job VM, validate `linux-x64/bin/byze-p2pool --version`,
   native manifest and the local private-DHT bundle-exchange test.
3. For *real* mining validation, set up one dedicated BYZE Core node and a
   separate, **restricted RPC gateway** for the test only; private bootstrap
   peers at operator-approved IPs, with no production wallet or credentials
   mounted inside guest environments.
4. Run at least two compatible P2Pool v6 participants, one inside SafeLabEnv
   and another on a dedicated external machine, with `--no-submit`.
   Validate peer discovery, native worker hashrate, local PoolShares,
   checkpoint/payout commitment, restart/reorg/disconnect behavior, lease
   renewals, expiry killing the entire guest and no leaked KVM processes.
5. Keep the final release blocked until its existing
   `cli/RELEASE-CHECKLIST.md` is fully satisfied: signed archives, selected
   software license, full PPLNS 0.50% fee payout verification and a genuine
   network-found block in an authorized environment.

**Scope freeze:** this stage does not add new SafeLabEnv endpoint types,
change pool consensus or turn a restricted RPC gateway into a public node.
It uses the generic execution contract only, and does not claim a successful
real-mining test until actual logs confirm it.
