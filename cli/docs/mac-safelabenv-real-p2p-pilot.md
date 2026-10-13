# Real P2Pool mining pilot — Mac controller + SafeLabEnv KVM

**Status:** application-side Mac Core RPC bridge is implemented and unit/CI
tested, but the SafeLabEnv network/renewable-job branch has NOT been deployed.
**No actual external P2P mining job has run in SafeLabEnv yet.**

Only two stages are permitted for this pilot:
1. SafeLabEnv generic network/lease/input preflight + controlled activation
   after negative/positive KVM checks and host firewall approval.
2. Use the BYZE P2Pool complete bundle and existing Mac Core for a private
   two-peer network with `--no-submit`. Do not install a second Core.

## Mac preflight — use the existing node (SAFE NOW)

```bash
cd "$HOME/byze-p2pool-node-check"
git fetch origin feature/complete-p2pool-lab-bundle-v1
git switch --detach origin/feature/complete-p2pool-lab-bundle-v1
cd cli
npm ci

BYZE="$HOME/ldev/byze/build/bin/byze-cli"
node src/byze-p2pool.js --check-node --byze-cli "$BYZE"
"$BYZE" getnetworkinfo | python3 -c \
  'import json,sys; d=json.load(sys.stdin); print("Core version:",d.get("version"),"subversion:",d.get("subversion"))'
```

The known Mac node answered `BYZE_NODE_READY` at height 20930 with
`headers=20930` on 2026-10-12. This proves chain readiness, NOT Core rc4
payout compatibility. Confirm rc4 or later before any spendability claim.

Next do one local nonmining CLI dry-run with a receiving address **already
known to be spendable**. A public payout address can be typed at the prompt;
never type a seed phrase or private key:

```bash
printf "Existing BYZE receiving address (public): "
IFS= read -r BYZE_PAYOUT
node src/byze-p2pool.js --dry-run --alias MacPreflight \
  --wallet "$BYZE_PAYOUT" --threads 1 --byze-cli "$BYZE" \
  --bootstrap none
```

`--dry-run` validates policy, fee and both native components but does NOT
start P2P, mining, or block submission. If payout is rejected or
`multioutput: INCOMPATIBLE`, stop and investigate; do not bypass.

## Mac-only read-only Core relay acceptance (SAFE NOW)

This step proves the cryptographic API bridge uses the existing Mac
`byze-cli`. It must **not** be exposed on a public interface.

In **Mac terminal A**:

```bash
cd "$HOME/byze-p2pool-node-check/cli"
umask 077
mkdir -p "$HOME/.config/byze-p2pool"
if [ ! -s "$HOME/.config/byze-p2pool/lab-token" ]; then
  python3 -c 'import secrets; print(secrets.token_urlsafe(48))' \
    > "$HOME/.config/byze-p2pool/lab-token"
fi
export BYZE_LAB_RELAY_TOKEN="$(cat "$HOME/.config/byze-p2pool/lab-token")"
python3 tools/byze-lab-rpc-relay.py \
  --byze-cli "$HOME/ldev/byze/build/bin/byze-cli" --port 18755
```

In **Mac terminal B**:

```bash
cd "$HOME/byze-p2pool-node-check/cli"
export BYZE_LAB_RELAY_TOKEN="$(cat "$HOME/.config/byze-p2pool/lab-token")"
export BYZE_LAB_RELAY_URL=http://127.0.0.1:18755/rpc
node tools/byze-lab-remote-cli.js getblockchaininfo
```

Expected: `{"chain":"main", ... "blocks":20930, ...}` with evolving
height. The relay binds to `127.0.0.1` only, requires a high-entropy bearer
and forwards only these read-only Core methods with strict arguments:
`getblockchaininfo`, `getbestblockhash`, `getblockhash`,
`getblockheader`, `getblock`, `getrawtransaction`,
`decoderawtransaction`, `getblocktemplate`, `validateaddress`,
`getaddressinfo`. It rejects `submitblock`, `signpoolblock`,
wallet-spending methods, arbitrary flags and blockchain node startup.
Wallet-related address responses strip labels and unrelated metadata.
No Core RPC credentials are put in the VM or logged by the relay.

**The token only authorizes this read-only bridge**, not wallet spending.
Do not paste the token into chat or store it in GitHub.

## VPS read-only inventory before ANY network change (SAFE NOW)

```bash
cd "$HOME/safelabenv-security"
git fetch origin feature/controlled-egress-renewable-jobs-v1
git worktree add --detach "$HOME/safelabenv-p2p-v1" \
 origin/feature/controlled-egress-renewable-jobs-v1
cd "$HOME/safelabenv-p2p-v1"
python3 -m unittest discover -s tests -p 'test_controlled_network.py' -q
sudo bash scripts/preflight-p2p-lab-readonly.sh
```

Output marker: `SAFELABENV_P2P_READ_ONLY_INVENTORY_DONE`.
**It is an inventory, NOT a security pass or installation authorization.**
It makes no change to the already operational 8765/8766 services.

## Approval gate for connecting a VM to Mac Core (NOT YET COMPLETE)

The intended path is:

```text
Mac (existing Core byze-cli + loopback-only read-only relay)
   |
   | SSH reverse forwarding; VPS end bound to 127.0.0.1 only
   v
VPS operator-controlled single relay port
   |
   | independently verified host gateway / per-protocol port egress policy
   v
SafeLabEnv KVM 1 CPU, 4096 MiB, renewable 60-300s heartbeat
   |
   | bin/byze-cli-lab adapter from the complete Linux-x64 bundle
   v
BYZE P2Pool CLI --no-submit, controlled private-DHT peer(s)
```

The gateway address `100.96.0.1` is reserved for SmolVM host routing,
but the current generic profile explicitly permits only public IPv4 /32
destinations. **Do NOT add `100.96.0.1/32` to the current profile or
use `--net` to bypass it:** that could expose unrelated host services.
The generic Stage 1 firewall must first prove that guests can reach
only the approved relay port/protocol and not SafeLabEnv localhost APIs,
host SSH, metadata or other services. Static CIDR filters are insufficient
for port-level isolation.

An SSH reverse tunnel alone forwards TCP, **not UDP**. The P2P private
bootstrap/peer path therefore requires separately qualified UDP reachability
to fixed, operator-controlled endpoints. No default public DHT seeds are
allowed during the first pilot.

Only after successful KVM network negative/positive tests and an exact-hash
rollback may a 64MiB input profile accept the portable Linux archive
(~53MiB) and a renewable VM start. The pilot needs two real compatible P2Pool
participants, both confirmed v6, and a synchronization-aware Core RPC
adapter. Do not merge PR #30 or claim real mining until evidence includes:

- One KVM instance stays up past 180s under authenticated lease renewals;
- Mac existing Core mainnet RPC `getblockchaininfo` and `getblocktemplate`
  are accessible via the restricted relay, and forbidden methods are not;
- Two actual P2Pool peers exchange signed valid PoolShares and checkpoints;
- Native hashrate exists, `--no-submit` prevents network block submission;
- Heartbeat stops -> KVM/cgroup processes terminate and no mounts leak;
- Offline/default and current 512MiB API regressions still pass.

The pilot does **not** guarantee block rewards, a production-ready payout
ledger or safe exposure to arbitrary Internet miners.
