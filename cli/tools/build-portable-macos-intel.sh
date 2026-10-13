#!/usr/bin/env bash
# Assemble a portable macOS Intel x86_64 test distribution; never compile native sources.
# Run from a verified checkout: bash cli/tools/build-portable-macos.sh
set -Eeuo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
PLATFORM='darwin-x64'
APP_VERSION='0.2.5-rc3'
NODE_VERSION='v22.23.3'
NODE_NAME="node-${NODE_VERSION}-${PLATFORM}.tar.gz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}"
TOP="byze-p2pool-${APP_VERSION}-${PLATFORM}"
STAGE_PARENT="$ROOT/.portable-lab/macos-x64"
STAGE="$STAGE_PARENT/$TOP"
DIST="$ROOT/dist"
ARCHIVE="byze-p2pool-cli-complete-${APP_VERSION}-${PLATFORM}.tar.gz"

if [[ "$(uname -s)" != 'Darwin' || "$(uname -m)" != 'x86_64' ]]; then
  echo 'This packaging script must run on macOS Intel (x86_64).' >&2
  exit 2
fi

for bin in curl shasum tar node npm git; do
  command -v "$bin" >/dev/null || { echo "Missing builder tool: $bin" >&2; exit 3; }
done

# npm installation is a builder operation, not an end-user requirement.
npm ci --omit=dev --ignore-scripts
node tools/ensure-native.js
npm run check
npm test
npm run test:dht
npm run release:preflight:source

# Source and native components are verified before packaging.
node - <<'JS'
const {nativeBundleStatus, EXPECTED_NATIVE_SOURCE_COMMIT}=require('./src/mining/native-components')
const s=nativeBundleStatus()
if(s.platformKey!=='darwin-arm64' || !s.miner.ok || !s.verifier.ok ||
  s.miner.feature!=='contract-direct-coinbase-v2' ||
  s.miner.sourceCommit!==EXPECTED_NATIVE_SOURCE_COMMIT ||
  s.verifier.sourceCommit!==EXPECTED_NATIVE_SOURCE_COMMIT) {
    throw Error('Managed macOS Intel x64 native bundle verification failed')
}
console.log('Pinned managed macOS Intel x64 miner and verifier: OK')
JS

# The Node.js runtime comes from an official, precompiled distribution.
# Verify its checksum against the official HTTPS SHASUMS256 manifest.
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/byze-mac-package.XXXXXXXX")"
trap 'rm -rf -- "$TEMP_ROOT"' EXIT
curl --fail --location --retry 3 --silent --show-error \
  "$NODE_URL/SHASUMS256.txt" -o "$TEMP_ROOT/SHASUMS256.txt"
curl --fail --location --retry 3 --silent --show-error \
  "$NODE_URL/$NODE_NAME" -o "$TEMP_ROOT/$NODE_NAME"
awk -v name="$NODE_NAME" '$2 == name { print }' "$TEMP_ROOT/SHASUMS256.txt" > "$TEMP_ROOT/node-checksum.txt"
[[ "$(wc -l < "$TEMP_ROOT/node-checksum.txt" | tr -d ' ')" == '1' ]] || {
  echo 'Node.js checksum is absent or duplicated.' >&2; exit 4;
}
(cd "$TEMP_ROOT" && shasum -a 256 -c node-checksum.txt)

tar -xzf "$TEMP_ROOT/$NODE_NAME" -C "$TEMP_ROOT" 
NODE_BINARY="$TEMP_ROOT/node-${NODE_VERSION}-${PLATFORM}/bin/node"
[[ -x "$NODE_BINARY" ]] || { echo 'Verified Node.js runtime binary is missing.' >&2; exit 5; }
[[ "$("$NODE_BINARY" --version)" == "$NODE_VERSION" ]] || {
  echo 'Downloaded Node.js binary has an unexpected version.' >&2; exit 6;
}

# Remove only our fixed packaging staging directory and reject symlink escapes.
[[ ! -L "$ROOT/.portable-lab" && ! -L "$STAGE_PARENT" && ! -L "$STAGE" ]] || {
  echo 'Symlinked packaging path rejected.' >&2; exit 7;
}
rm -rf -- "$STAGE_PARENT"
mkdir -p "$STAGE/bin" "$STAGE/app/native" "$STAGE/app/tools" "$DIST"
install -m 0755 "$NODE_BINARY" "$STAGE/bin/node"
cp -R src config node_modules licenses "$STAGE/app/"
cp -R native/darwin-x64 "$STAGE/app/native/"
cp package.json package-lock.json COMPATIBILITY.json THIRD_PARTY-NOTICES.md "$STAGE/app/"
cp tools/test-private-dht.js "$STAGE/app/tools/"

cat > "$STAGE/bin/byze-p2pool" <<'SH'
#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$here/node" "$here/../app/src/byze-p2pool.js" "$@"
SH
chmod 0755 "$STAGE/bin/byze-p2pool"

cat > "$STAGE/README-FIRST.txt" <<'DOC'
BYZE P2Pool CLI 0.2.5-rc3 / macOS Intel x86_64 — EXPERIMENTAL TEST BUILD

The Node.js runtime, JS dependencies and pinned native miner/verifier are bundled.
A separately installed and synchronized BYZE Core daemon/client is required.
No wallet private keys or RPC credentials are included.

From the uncompressed folder:
  ./bin/byze-p2pool --version
  ./bin/byze-p2pool --check-node
  ./bin/byze-p2pool --wallet YOUR_BYZE_ADDRESS --threads 2

To install in your home directory, use the documented release installation
commands at https://contractp2p.github.io/byze-p2pool-cli/ once published.

NOTE: Unsigned/unnotarized test package. Not a validated mining or payout release.
DOC

cat > "$STAGE/BUILD-INFO.txt" <<DOC
BYZE P2Pool CLI test package (not a signed or notarized public release)
CLI version: $APP_VERSION
Platform: $PLATFORM
Repository: ContractP2P/byze-p2pool-cli
Source commit: $(git rev-parse HEAD)
Node runtime: $NODE_VERSION (official archive + SHA256SUMS verified)
Upstream native pin: d84db8a84ba4a06432fcdddbf1584b89a7e52379
No BYZE Core, wallet, RPC credential, or private key is embedded.
DOC

# Verify complete staged distribution, not just its checkout.
"$STAGE/bin/byze-p2pool" --version
"$STAGE/bin/byze-p2pool" --help >/dev/null
"$STAGE/app/native/$PLATFORM/byze-p2pool-miner" --features | grep -q 'contract-direct-coinbase-v2'
"$STAGE/bin/node" "$STAGE/app/tools/test-private-dht.js"

export COPYFILE_DISABLE=1
# Portable directory name is intentionally stable for the GitHub Pages installer.
tar -czf "$DIST/$ARCHIVE" -C "$STAGE_PARENT" "$TOP"
(cd "$DIST" && shasum -a 256 "$ARCHIVE" > SHA256SUMS && shasum -a 256 -c SHA256SUMS)

cat <<INFO
PACKAGE_READY
Package: $DIST/$ARCHIVE
Checksums: $DIST/SHA256SUMS
Source commit: $(git rev-parse HEAD)
Test release tag: v0.2.5-rc3-macos-intel-test1
INFO