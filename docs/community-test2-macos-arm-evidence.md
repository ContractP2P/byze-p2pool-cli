# Community Test 2: macOS Apple Silicon P2Pool block evidence

**Experimental mainnet testing only.** Do not use real wallet secrets in GitHub or Discord. This guide does not promise a block.

## Before mining

- Keep the existing BYZE Core daemon and blockchain untouched. Stop only the previous P2Pool CLI process before updating.
- Use the guided installer from [GitHub Pages](https://contractp2p.github.io/byze-p2pool-cli/) after its version and archive hashes are updated.
- Execute `~/.local/bin/byze-p2pool --version` and verify `0.2.5-rc4-community.2`.
- Execute `~/.local/bin/byze-p2pool --check-node`; confirm a synchronized `main` node with `BYZE_NODE_READY`.
- Verify the actual spendability of the payout address independently with a supported BYZE Core wallet (address syntax alone is insufficient).

## Mine and preserve evidence

Start the site-generated mining command **without** `--no-submit`. The command uses your chosen public BYZE address, alias and CPU-thread count. Keep the terminal session log privately and monitor for `BYZE BLOCK SUBMITTED` and `P2Pool local submission evidence:`.

The CLI should save under:

`~/.local/state/byze-p2pool/block-evidence/submitted-<height>-<coinbase-txid>-<digest>.json`

Check records locally without printing wallets, signed peer packets, or P2P identifiers:

```sh
python3 - <<'PY'
from pathlib import Path
import json
folder=Path.home()/'.local/state/byze-p2pool/block-evidence'
files=sorted(folder.glob('submitted-*.json'),key=lambda x:x.stat().st_mtime)
print('Private submitted records:',len(files))
for file in files[-10:]:
  d=json.loads(file.read_text())
  print('height',d.get('height'),'mode',d.get('payoutMode'),
        'proof',d.get('proofStatus'),'PPLNS shares',len(d.get('poolShares',[])),
        'missing packets',d.get('missingProofPackets'))
PY
```

A `bootstrap` payout is **not** a PPLNS payout. `incomplete` or `pplns-packets-missing` is not a publishable proof. A successful `submitblock` result means submitted, not independently confirmed or spendable.

## Reviewed Discord payout publication

1. Verify the exact block/hash/coinbase on canonical BYZE mainnet with at least **six confirmations**.
2. Independently verify submission provenance, release identity, recipient scripts/amounts, the exact 0.5% fee, and if mode is PPLNS, the complete signed share chain including PoW.
3. **Only with deliberate operator approval**, redact sensitive details and contribute a reviewed JSON under `cli/evidence/blocks/<height>-<coinbaseTxid>.json`.
4. Commit the SHA-256-pinned entry to `cli/config/pool-block-attributions.json`, with a GitHub issue/PR review URL. For bootstrap use `payoutMode: "bootstrap"`, `pplnsTipId: ""`; for PPLNS use the committed `ps:...` tip.
5. After merge, the scheduled GitHub observer independently checks blockchain amounts and publishes one categorized block report in `#p2pool-reports`. No candidate-only or unreviewed block is published.

The hourly **Activity Report** is independent of block discovery and depends on a fresh positive P2P observation.

**Privacy:** a local proof may contain public payout addresses and P2P identity history; neither the CLI nor the installer uploads these to GitHub or Discord. The review gate is intentional.
