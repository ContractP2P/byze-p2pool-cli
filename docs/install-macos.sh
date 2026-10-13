#!/bin/bash
# BYZE P2Pool installer for stock macOS. Never re-installs detected BYZE Core.
set -euo pipefail
CORE_TAG="v0.2.5-rc5-change-keyspace"
CORE_BASE="https://github.com/powhermes/byze/releases/download/$CORE_TAG"
CORE_SHA_X64="08392d6daf5597b45749f2fa18cfbac585510ca591df2f70f555d5093b16bf28"
CORE_SHA_ARM="d71baa8534515027b60a0c7b9de71ffe75ae236322a5cbb5e77056a5f1731a62"
VERSION="0.2.5-rc3"
BASE="$HOME/.local/opt"
LAUNCHER="$HOME/.local/bin/byze-p2pool"
MARKER="$BASE/byze-p2pool-core-cli.path"
MODE="${1:---install}"
TMP=""
CORE_CLI=""
CORE_DAEMON=""
CORE_EVIDENCE=""
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
message() { printf '%s\n' "$*"; }
cleanup() { if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf -- "$TMP"; fi; }
trap cleanup EXIT
[ "$(uname -s)" = "Darwin" ] || fail "macOS only."
case "$(uname -m)" in
 x86_64)
   PLATFORM="darwin-x64"; CORE_ARCH="x86_64"; CORE_SHA="$CORE_SHA_X64"
   CLI_TAG="v0.2.5-rc3-macos-intel-test1" ;;
 arm64)
   PLATFORM="darwin-arm64"; CORE_ARCH="arm64"; CORE_SHA="$CORE_SHA_ARM"
   CLI_TAG="v0.2.5-rc3-macos-arm64-test1" ;;
 *) fail "Unsupported CPU architecture." ;;
esac
CORE_ZIP="byze-core-macos-$CORE_ARCH.zip"
CLI_FOLDER="byze-p2pool-$VERSION-$PLATFORM"
CLI_TAR="byze-p2pool-cli-complete-$VERSION-$PLATFORM.tar.gz"
CLI_URL="https://github.com/ContractP2P/byze-p2pool-cli/releases/download/$CLI_TAG"
CLI_HOME="$BASE/$CLI_FOLDER"
try_client() {
 local path="$1"
 if [ -n "$path" ] && [ -f "$path" ] && [ -x "$path" ]; then
   CORE_CLI="$path"; CORE_EVIDENCE="Existing byze-cli: $path"
   if [ -x "$(dirname "$path")/byzed" ]; then CORE_DAEMON="$(dirname "$path")/byzed"; fi
   return 0
 fi
 return 1
}
discover_core() {
 local path="" p=""
 if [ -n "${BYZE_CLI:-}" ]; then
   [ -x "$BYZE_CLI" ] || fail "BYZE_CLI points to a missing client. Core will not be reinstalled."
   try_client "$BYZE_CLI" && return 0
 fi
 path="$(command -v byze-cli 2>/dev/null || true)"
 try_client "$path" && return 0
 for path in "$HOME/ldev/byze/build/bin/byze-cli" "$HOME/byze/build/bin/byze-cli" \
      /usr/local/bin/byze-cli /opt/homebrew/bin/byze-cli; do
   try_client "$path" && return 0
 done
 if [ -d "$BASE" ]; then
   path="$(find "$BASE" -type f -name byze-cli -print -quit 2>/dev/null || true)"
   try_client "$path" && return 0
 fi
 # A data directory or running node counts as an existing Core, even if
 # no accessible RPC client was found; stop rather than install twice.
 if pgrep -x byzed >/dev/null 2>&1 || pgrep -x byze-qt >/dev/null 2>&1; then
   CORE_EVIDENCE="Existing BYZE process is running."
 fi
 if [ -z "$CORE_EVIDENCE" ]; then
   for p in "$HOME/.byze" "$HOME/Library/Application Support/Byze" \
     "$HOME/Library/Application Support/BYZE" "$HOME/.config/byze" \
     "$HOME/Applications/Byze-Qt.app" "/Applications/Byze-Qt.app"; do
     if [ -e "$p" ]; then CORE_EVIDENCE="Existing BYZE data or app: $p"; break; fi
   done
 fi
 if [ -z "$CORE_EVIDENCE" ]; then
   path="$(command -v byzed 2>/dev/null || true)"
   if [ -n "$path" ]; then CORE_EVIDENCE="Existing daemon executable: $path"; fi
 fi
 if [ -z "$CORE_EVIDENCE" ] && [ -d "$BASE" ]; then
   path="$(find "$BASE" -type f -name byzed -print -quit 2>/dev/null || true)"
   if [ -n "$path" ]; then CORE_EVIDENCE="Existing daemon executable: $path"; fi
 fi
 return 1
}
confirm() {
 local expected="$1" prompt="$2" reply=""
 [ -t 0 ] || fail "Interactive Terminal required. No Core changes made."
 printf '%s\nType %s to continue: ' "$prompt" "$expected"
 IFS= read -r reply || fail "Cancelled."
 [ "$reply" = "$expected" ] || fail "Not confirmed. No Core changes made."
}
preflight() {
 command -v curl >/dev/null || fail "curl is required."
 command -v shasum >/dev/null || fail "shasum is required."
 if [ -L "$LAUNCHER" ]; then fail "Launcher symlink exists; refusing overwrite."; fi
 if [ -e "$LAUNCHER" ] && ! grep -q '^# BYZE_P2POOL_MANAGED_LAUNCHER$' "$LAUNCHER"; then
   fail "Unmanaged P2Pool launcher exists; refusing overwrite."
 fi
 [ ! -L "$MARKER" ] || fail "Core path marker is a symlink."
 # An already installed complete package is reused even when offline.
 if [ -d "$CLI_HOME" ] && [ -x "$CLI_HOME/bin/byze-p2pool" ]; then
   message "Existing P2Pool package found; no release download needed."
   return 0
 fi
 [ ! -e "$CLI_HOME" ] && [ ! -L "$CLI_HOME" ] ||
   fail "Incomplete P2Pool package exists; refusing overwrite."
 # Fail before provisioning Core when the P2Pool platform package is absent.
 curl --silent --show-error --fail --location --head --max-time 30 \
   "$CLI_URL/$CLI_TAR" -o /dev/null ||
   fail "Complete P2Pool $PLATFORM release not yet published; nothing installed."
}
install_new_core() {
 local dest="$BASE/byze-core-$CORE_TAG-$PLATFORM" stage="$TMP/core" found="" relative=""
 [ -z "$CORE_EVIDENCE" ] && [ -z "$CORE_CLI" ] || fail "Existing Core found; duplicate install blocked."
 [ ! -e "$dest" ] && [ ! -L "$dest" ] || fail "Core target exists; refusing overwrite."
 confirm "NO" "Is any BYZE Core already installed elsewhere on this Mac? Confirm NO only if certain."
 confirm "INSTALL" "Install official BYZE Core $CORE_TAG and start a mainnet node?"
 message "Downloading official BYZE Core $CORE_ARCH..."
 curl --fail --location --retry 3 --silent --show-error \
   "$CORE_BASE/$CORE_ZIP" -o "$TMP/$CORE_ZIP"
 ( cd "$TMP" && printf '%s  %s\n' "$CORE_SHA" "$CORE_ZIP" | shasum -a 256 -c - ) ||
   fail "Official Core archive SHA-256 mismatch. No installation performed."
 mkdir -p "$stage"
 /usr/bin/ditto -x -k "$TMP/$CORE_ZIP" "$stage"
 found="$(find "$stage" -type f -name byze-cli -print -quit)"
 [ -n "$found" ] || fail "Core archive contains no byze-cli."
 relative="${found#"$stage"/}"
 [ "$relative" != "$found" ] || fail "Invalid Core archive path."
 local daemon="" daemon_relative=""
 daemon="$(find "$stage" -type f -name byzed -print -quit)"
 [ -n "$daemon" ] || fail "Verified Core archive does not contain byzed."
 daemon_relative="${daemon#"$stage"/}"
 [ "$daemon_relative" != "$daemon" ] || fail "Invalid daemon archive path."
 chmod u+x "$found" "$daemon"
 mkdir -p "$BASE"
 [ ! -e "$dest" ] && [ ! -L "$dest" ] || fail "Core target appeared. No overwrite."
 mv "$stage" "$dest"
 CORE_CLI="$dest/$relative"
 CORE_DAEMON="$dest/$daemon_relative"
 message "BYZE Core installed at $dest; no previous Core was touched."
}
start_core() {
 if "$CORE_CLI" getblockchaininfo >/dev/null 2>&1; then
   message "Existing Core RPC responds; keeping the node unchanged."
   return 0
 fi
 if pgrep -x byzed >/dev/null 2>&1 || pgrep -x byze-qt >/dev/null 2>&1; then
   message "BYZE process detected. Its RPC is not ready; no duplicate daemon will be started."
   return 0
 fi
 if [ ! -x "$CORE_DAEMON" ]; then
   message "Core is installed but daemon was not found; start or repair that existing node."
   return 0
 fi
 confirm "START" "Start the installed BYZE Core daemon (without reinstalling)?"
 "$CORE_DAEMON" -daemon || fail "Existing BYZE daemon did not start."
 message "Core daemon started; mainnet sync may require time."
}
install_pool() {
 local dest="$CLI_HOME" stage="$TMP/pool" matched=""
 [ -n "$CORE_CLI" ] || fail "No usable Core RPC client found. NO replacement will be attempted."
 if [ -d "$dest" ] && [ -x "$dest/bin/byze-p2pool" ]; then
   message "Existing P2Pool package detected; reusing it."
 else
   [ ! -e "$dest" ] && [ ! -L "$dest" ] || fail "Existing incomplete pool package; no overwrite."
   curl --fail --location --retry 3 --silent --show-error "$CLI_URL/$CLI_TAR" -o "$TMP/$CLI_TAR"
   curl --fail --location --retry 3 --silent --show-error "$CLI_URL/SHA256SUMS" -o "$TMP/SHA256SUMS"
   matched="$(grep -E "^[a-fA-F0-9]{64} [ *]$CLI_TAR\$" "$TMP/SHA256SUMS" || true)"
   [ "$(printf '%s\n' "$matched" | grep -c . || true)" -eq 1 ] || fail "Invalid pool checksum manifest."
   ( cd "$TMP" && printf '%s\n' "$matched" | shasum -a 256 -c - ) || fail "Pool checksum mismatch."
   mkdir -p "$stage"
   /usr/bin/tar -xzf "$TMP/$CLI_TAR" -C "$stage"
   [ -x "$stage/$CLI_FOLDER/bin/byze-p2pool" ] || fail "Unexpected pool archive layout."
   [ ! -e "$dest" ] && [ ! -L "$dest" ] || fail "Pool target already exists."
   mkdir -p "$BASE"
   mv "$stage/$CLI_FOLDER" "$dest"
 fi
 mkdir -p "$(dirname "$LAUNCHER")"
 printf '%s\n' "$CORE_CLI" > "$MARKER"
 cat > "$LAUNCHER" <<'LAUNCHER_TEXT'
#!/bin/sh
# BYZE_P2POOL_MANAGED_LAUNCHER
if [ -z "${BYZE_CLI+x}" ]; then
  BYZE_CLI="$(cat "$HOME/.local/opt/byze-p2pool-core-cli.path")"
  export BYZE_CLI
fi
exec "$HOME/.local/opt/byze-p2pool-0.2.5-rc3-__PLATFORM__/bin/byze-p2pool" "$@"
LAUNCHER_TEXT
 /usr/bin/sed -i '' "s/__PLATFORM__/$PLATFORM/g" "$LAUNCHER"
 chmod 0755 "$LAUNCHER"
 "$LAUNCHER" --version
}

# Sync status is by block height, not Core's verificationprogress field.
# Ctrl+C stops this monitor only; it never stops an existing BYZE daemon.
wait_for_mainnet_sync() {
  local interval="${BYZE_SYNC_INTERVAL_SECONDS:-30}" max_polls="${BYZE_SYNC_MAX_POLLS:-0}"
  local polls=0 raw="" blocks="" headers="" ibd="" chain="" percent=""
  [[ "$interval" =~ ^[0-9]+$ ]] || fail 'Invalid sync poll interval.'
  [[ "$max_polls" =~ ^[0-9]+$ ]] || fail 'Invalid sync poll limit.'
  [ -n "$CORE_CLI" ] && [ -x "$CORE_CLI" ] ||
    fail 'Existing BYZE Core client not found; cannot monitor synchronization.'
  [ -x "$LAUNCHER" ] ||
    fail 'P2Pool CLI is not installed; complete installation before monitoring.'
  message "P2Pool package installed. Waiting for BYZE Core synchronization (mainnet)."
  message "This may take a while. Progress is based on block heights, not verificationprogress."
  message "Press Ctrl+C to stop watching; BYZE Core will keep running."
  while :; do
    polls=$((polls + 1))
    raw="$("$CORE_CLI" getblockchaininfo 2>/dev/null || true)"
    blocks="$(printf '%s\n' "$raw" | /usr/bin/sed -nE 's/.*"blocks"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' | head -n 1)"
    headers="$(printf '%s\n' "$raw" | /usr/bin/sed -nE 's/.*"headers"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' | head -n 1)"
    ibd="$(printf '%s\n' "$raw" | /usr/bin/sed -nE 's/.*"initialblockdownload"[[:space:]]*:[[:space:]]*(true|false).*/\1/p' | head -n 1)"
    chain="$(printf '%s\n' "$raw" | /usr/bin/sed -nE 's/.*"chain"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n 1)"
    if [[ "$blocks" =~ ^[0-9]+$ && "$headers" =~ ^[0-9]+$ ]] && [ "$headers" -gt 0 ]; then
      percent="$(awk -v b="$blocks" -v h="$headers" 'BEGIN{p=100*b/h;if(p>100)p=100;printf "%.1f",p}')"
      message "BYZE synchronization: $blocks / $headers blocks ($percent% by height); IBD: ${ibd:-unknown}."
      if [ "$chain" = main ] && [ "$blocks" -gt 0 ] && [ "$headers" -ge "$blocks" ] &&
         [ $((headers - blocks)) -le 2 ] && [ "$ibd" = false ]; then
        if "$LAUNCHER" --check-node >/dev/null 2>&1; then
          message 'BYZE_NODE_READY. Synchronization confirmed. You can start P2Pool mining.'
          return 0
        fi
        message 'Core heights are current, but P2Pool readiness is still pending.'
      fi
    else
      if [[ "$blocks" =~ ^[0-9]+$ && "$headers" =~ ^[0-9]+$ ]]; then
        message "BYZE synchronization: $blocks / $headers blocks (waiting for block headers); IBD: ${ibd:-unknown}."
      else
        message 'Waiting for BYZE Core RPC / block headers (height unavailable).'
      fi
    fi
    if [ "$max_polls" -gt 0 ] && [ "$polls" -ge "$max_polls" ]; then
      message 'BYZE_NODE_NOT_READY. Sync monitor limit reached; BYZE Core remains running.'
      return 2
    fi
    sleep "$interval"
  done
}

case "$MODE" in
 --probe)
   if discover_core; then
     message "CORE_FOUND: $CORE_EVIDENCE"
     message "CORE_ACTION: REUSE_ONLY"
   elif [ -n "$CORE_EVIDENCE" ]; then
     message "CORE_FOUND: $CORE_EVIDENCE"
     message "CORE_ACTION: DO_NOT_REINSTALL; locate your existing client."
   else
     message "CORE_ABSENT: No existing Core executable, process, data or app detected."
     message "CORE_ACTION: only install with explicit consent."
   fi ;;
 --wait-sync)
   discover_core || fail 'Existing BYZE Core client could not be found; no installation attempted.'
   wait_for_mainnet_sync ;;
 --install)
   message "BYZE P2Pool full installation for $PLATFORM"
   # Inspect local installations before any network operation. A detected
   # footprint with no usable byze-cli must fail closed even when offline.
   local_core_absent=0
   if discover_core; then
     message "CORE_FOUND: $CORE_EVIDENCE"
     message "CORE_ACTION: REUSE_ONLY; no download, replacement or upgrade."
   elif [ -n "$CORE_EVIDENCE" ]; then
     fail "Existing Core footprint: $CORE_EVIDENCE. Core will NOT be reinstalled. Set BYZE_CLI to its client location."
   else
     local_core_absent=1
   fi
   preflight
   if [ "$local_core_absent" -eq 1 ]; then
     TMP="$(mktemp -d "${TMPDIR:-/tmp}/byze-install.XXXXXXXX")"
     install_new_core
   fi
   if [ -z "$TMP" ]; then TMP="$(mktemp -d "${TMPDIR:-/tmp}/byze-install.XXXXXXXX")"; fi
   start_core
   install_pool
   wait_for_mainnet_sync ;;
 *) fail "Usage: install-macos.sh [--probe|--install|--wait-sync]" ;;
esac
