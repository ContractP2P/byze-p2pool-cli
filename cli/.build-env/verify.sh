#!/usr/bin/env bash
set -euo pipefail

ROOT="/workspaces/contract-dev/cli"
UPSTREAM="/tmp/byze-miner"

COMMIT="d84db8a84ba4a06432fcdddbf1584b89a7e52379"

EXPECTED_MINER="52ca608f8141ff7279b72a1fd122b9106876809428429a947e2ca3675ff4dca2"
EXPECTED_RXHASH="21c8503d08fbe3f0f2e58e8ebd3703c21cedaa1cd4b1c37ef18830635f5418e3"
EXPECTED_MANIFEST="f0b2c50001e8c482ac47e3588157988f4c3ff19f25460364aa29cd559a2ad38b"

echo "===== ENVIRONMENT ====="

grep -E 'PRETTY_NAME|VERSION_ID' /etc/os-release
gcc --version | head -1
g++ --version | head -1
cmake --version | head -1
ld --version | head -1
git --version
node --version

echo
echo "===== ISOLATED CLI ====="

rm -rf "$ROOT"
mkdir -p "$ROOT"

(
  cd /src-cli

  find . \
    -path './.git' -prune -o \
    -path './.native-work' -prune -o \
    -path './node_modules' -prune -o \
    -path './native/linux-x64' -prune -o \
    -type f -print0
) | (
  cd /src-cli
  tar --null -T - -cf -
) | (
  cd "$ROOT"
  tar -xf -
)

cd "$ROOT"

echo
echo "===== PINNED UPSTREAM ====="

rm -rf "$UPSTREAM"

git clone \
  --no-checkout \
  --filter=blob:none \
  https://github.com/powhermes/byze-miner.git \
  "$UPSTREAM"

git -C "$UPSTREAM" checkout \
  --detach \
  "$COMMIT"

git -C "$UPSTREAM" submodule update \
  --init \
  --recursive

ACTUAL="$(git -C "$UPSTREAM" rev-parse HEAD)"
test "$ACTUAL" = "$COMMIT"

if [ -n "$(git -C "$UPSTREAM" status --porcelain --untracked-files=all)" ]; then
  echo "ERROR: upstream checkout is dirty"
  exit 10
fi

echo "Pinned commit: $ACTUAL"

echo
echo "===== SOURCE TRUST POLICY ====="

node - "$UPSTREAM" <<'NODE'
const source = process.argv[2]
const { verifyPinnedSource } =
  require('./tools/lib/native-source-policy')

const result = verifyPinnedSource(source)
console.log(result)

if (!result.ok) process.exit(1)
NODE

echo
echo "===== REPRODUCIBLE BUILD ====="

node tools/reproducible-native-build.js \
  --source "$UPSTREAM"

MINER="native/linux-x64/byze-p2pool-miner"
RXHASH="native/linux-x64/byze-rxhash"
MANIFEST="native/linux-x64/native-manifest.json"

echo
echo "===== EXPECTED RELEASE HASHES ====="

printf '%s  %s\n' "$EXPECTED_MINER" "$MINER" \
  | sha256sum -c -

printf '%s  %s\n' "$EXPECTED_RXHASH" "$RXHASH" \
  | sha256sum -c -

printf '%s  %s\n' "$EXPECTED_MANIFEST" "$MANIFEST" \
  | sha256sum -c -

echo
echo "===== GNU STACK ====="

for elf in "$MINER" "$RXHASH"; do
  STACK="$(readelf -W -l "$elf" | grep GNU_STACK)"
  echo "$elf: $STACK"

  if echo "$STACK" | grep -q 'RWE'; then
    echo "ERROR: executable GNU_STACK"
    exit 20
  fi
done

echo
echo "===== FEATURE ====="

FEATURE="$("$MINER" --features)"
echo "$FEATURE"

if [ "$FEATURE" != "contract-direct-coinbase-v2" ]; then
  echo "ERROR: unexpected native feature"
  exit 21
fi

echo
echo "=============================================="
echo "OK: isolated Linux x64 environment"
echo "OK: native build is bit-for-bit reproducible"
echo "OK: historical release SHA-256 reproduced"
echo "OK: GNU stack is non-executable"
echo "OK: native feature verified"
echo "=============================================="
