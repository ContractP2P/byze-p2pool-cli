# BYZE native verification using SafeLabEnv Remote

This document is part of **byze-p2pool-cli**, not SafeLabEnv. The BYZE
repository owns the software, CI build, expected native features, RandomX
consensus vectors and acceptance criteria. SafeLabEnv is only a generic
isolated-Linux job executor.

## Architecture

1. BYZE GitHub Actions builds the experimental Linux x64 native artifact.
2. An authenticated client retrieves the artifact, checks `SHA256SUMS`,
   and sends its archive bytes to SafeLabEnv `POST /v1/inputs`.
3. The generic SafeLabEnv job API receives `image`, `input_id`, `command`,
   `cpus`, `memory_mib` and `timeout_seconds`. There is **no** BYZE
   parameter or miner plugin in SafeLabEnv.
4. SafeLabEnv starts an offline Ubuntu microVM and returns stdout/stderr.
5. BYZE-specific client-side code checks results against this repository's
   feature expectations or independent BYZE Core consensus values.

No BYZE wallets, private keys, seed phrases, RPC passwords or working mainnet
nodes are required for these two isolated tests.

## 1. Fetch an experimental BYZE Linux-x64 bundle

As of October 12, 2026, the experimentally compiled BYZE native-only artifact
is from GitHub Actions run
[37982214553](https://github.com/ContractP2P/byze-p2pool-cli/actions/runs/37982214553).
**Not signed/not a production release.** CI artifacts can expire; newer
artifacts must be audited separately before use.

On a Mac with `gh` logged in:

```bash
mkdir -p "$HOME/byze-safelabenv-test"
cd "$HOME/byze-safelabenv-test"
gh run download 37982214553 -R ContractP2P/byze-p2pool-cli \
  -n byze-p2pool-native-test-linux-x64 -D .
shasum -a 256 -c SHA256SUMS
```

For this historical test bundle, the precise filename is:

```text
byze-p2pool-native-0.2.5-rc3-linux-x64-ec2d9fa039b1.tar.gz
```

The scripts expect the archive to contain
`native/linux-x64/byze-p2pool-miner` and
`native/linux-x64/byze-rxhash`.

## 2. SafeLabEnv binary startup test (512 MiB)

With the existing localhost SSH tunnel from your Mac
(`127.0.0.1:18766` → SafeLabEnv VPS `127.0.0.1:8766`) and environment
variable `SAFELABENV_REMOTE_API_KEY` configured, run the client stored
in **this BYZE repository**:

```bash
python3 cli/tools/safelabenv-native-smoke.py \
  "$HOME/byze-safelabenv-test/byze-p2pool-native-0.2.5-rc3-linux-x64-ec2d9fa039b1.tar.gz"
```

The test checks native `--features` contains
`contract-direct-coinbase-v2` and `byze-rxhash` rejects a deliberately
malformed header. Successful marker:
`SAFELABENV_BYZE_REMOTE_BINARY_PASSED`.

This is **not** a full RandomX computation or P2P mining test.

## 3. Full-memory RandomX genesis check (4096 MiB)

This requires SafeLabEnv to support **generic** operator-approved resource
requests up to `memory_mib=4096` and `timeout_seconds=180`.
It must not require any `byze-randomx` special profile. The generic
high-memory limit is default-OFF and must pass its own deployment tests first.

```bash
python3 cli/tools/safelabenv-randomx-genesis.py \
  "$HOME/byze-safelabenv-test/byze-p2pool-native-0.2.5-rc3-linux-x64-ec2d9fa039b1.tar.gz"
```

The client verifies the historical archive's pinned SHA-256, reconstructs
the 80-byte BYZE mainnet genesis block header from independently pinned
BYZE Core rc4 parameters, and executes:

```text
byze-rxhash --once <80-byte-header-as-160-hex>
```

Reference genesis hash (BYZE Core's display byte order):

```text
00000a6ff6ac3c6549d30a1931c8ff1fc98be705c7802164d7fb61b2bec85070
```

The client reverses raw output *bytes*, compares all 32 bytes, and emits
`SAFELABENV_BYZE_RANDOMX_GENESIS_MATCH_PASSED` only if they match.

The host never runs uploaded executables: they run inside an offline,
resource-limited KVM guest. This test neither exercises a networked
BYZE Core nor verifies PPLNS/reorgs/direct coinbase payouts, nor signs
or endorses binaries for release.

## Boundaries

Do not add BYZE-specific source files, consensus constants, feature flags,
wallet handling, or pool payout logic to SafeLabEnv. Future binaries should
be verified by additional **client-owned** tests that use the unchanged
SafeLabEnv API.

These tests use one trusted owner/token; separate multi-tenant isolation is
not established by this workflow. Keep the SSH tunnel loopback-only.
