#!/usr/bin/env bash
# Experimental self-contained Linux-x64 CLI for a controlled test lab.
# BYZE Core remains separately operated and authenticated.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
[[ "$(node -p 'process.platform+"-"+process.arch')" == "linux-x64" ]] || {
  echo "Linux x64 only" >&2; exit 2;
}
node tools/ensure-native.js
[[ -d node_modules && -f node_modules/hyperswarm/package.json ]] || {
  echo "Run npm ci --omit=dev first" >&2; exit 2;
}
[[ "$#" -eq 0 ]] || { echo "No output-path override permitted" >&2; exit 2; }
stage="$PWD/.portable-lab/linux-x64"
[[ ! -L "$PWD/.portable-lab" && ! -L "$stage" ]] || {
  echo "Symlinked staging directories forbidden" >&2; exit 2;
}
rm -rf -- "$stage"
install -d -m 0755 "$stage/bin" "$stage/app/native"
install -m 0755 "$(node -p 'process.execPath')" "$stage/bin/node"
cp -R src config node_modules licenses "$stage/app/"
cp -R native/linux-x64 "$stage/app/native/"
install -d -m 0755 "$stage/app/tools"
install -m 0644 tools/test-private-dht.js "$stage/app/tools/"
install -m 0644 tools/download-core.js "$stage/app/tools/"
install -m 0644 package.json package-lock.json THIRD_PARTY-NOTICES.md COMPATIBILITY.json "$stage/app/"
cat > "$stage/bin/byze-p2pool" <<'SH'
#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$here/node" "$here/../app/src/byze-p2pool.js" "$@"
SH
chmod 0755 "$stage/bin/byze-p2pool"
node tools/verify-portable-lab.js "$stage"
"$stage/bin/byze-p2pool" --help >/dev/null
echo "BYZE_P2POOL_COMPLETE_LINUX_CLI_PACKAGE_READY"
