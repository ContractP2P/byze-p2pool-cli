#!/bin/bash
# Full Linux x64 P2Pool installer. A detected BYZE Core is NEVER reinstalled.
set -euo pipefail
[ "$(uname -s)" = Linux ] || { echo 'Linux only' >&2; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo 'Linux x86_64 only' >&2; exit 1; }
CORE_TAG=v0.2.5-rc5-change-keyspace
CORE_SHA=2ce51e203c20ec7dd22fef055fbece0ce702c7e7451a6fe9be248353ae5e19ad
CORE_FPR=9F11E836EB4B7F464ADBB1E7AC11CA674828CAE1
CORE_ASSET=byze-core-linux-x86_64.tar.gz
CORE_URL="https://github.com/powhermes/byze/releases/download/$CORE_TAG"
VERSION=0.2.5-rc3
CLI_TAG=v0.2.5-rc3-evidence-test1
# Immutable trusted archive fingerprint, independently pinned from the GitHub Release asset digest.
CLI_SHA=4be720b76f5066edae2d8e84837efa2cd66349003f8a636335beeb83f614138b
CLI_ASSET="byze-p2pool-cli-complete-$VERSION-linux-x64.tar.gz"
CLI_URL="https://github.com/ContractP2P/byze-p2pool-cli/releases/download/$CLI_TAG"
BASE="$HOME/.local/opt"
# Separate the 15 October package from older rc3 builds; preserve the old files.
POOL="$BASE/byze-p2pool-$VERSION-evidence-test1-linux-x64"
LAUNCHER="$HOME/.local/bin/byze-p2pool"
MARKER="$BASE/byze-p2pool-core-cli.path"
CORE_CLI=
CORE_DAEMON=
EVIDENCE=
TMP=
MODE=--install
if [ "$#" -gt 0 ]; then MODE="$1"; fi
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }
cleanup() { if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf -- "$TMP"; fi; }
trap cleanup EXIT
prepare() { if [ -z "$TMP" ]; then TMP="$(mktemp -d /tmp/byze-first-run.XXXXXXXX)"; fi; }
download() {
  curl --fail --location --retry 3 --silent --show-error --max-time 240 \
    --proto '=https' --proto-redir '=https' "$1" -o "$2"
}
confirm() {
  local answer=
  [ -t 0 ] || fail 'Interactive terminal required before installing or starting Core.'
  printf '%s\nType %s to proceed: ' "$2" "$1"
  IFS= read -r answer || fail 'Cancelled.'
  [ "$answer" = "$1" ] || fail 'No changes authorized.'
}
client() {
  local p="$1"
  [ -n "$p" ] && [ -f "$p" ] && [ -x "$p" ] || return 1
  CORE_CLI="$p"
  EVIDENCE="Existing byze-cli: $p"
  if [ -x "$(dirname "$p")/byzed" ]; then CORE_DAEMON="$(dirname "$p")/byzed"; fi
}
discover_core() {
  local p=
  if [ -n "$BYZE_CLI" ]; then
    client "$BYZE_CLI" || fail 'Invalid BYZE_CLI override; will not install another Core.'
    return 0
  fi
  p="$(command -v byze-cli 2>/dev/null || true)"
  client "$p" && return 0
  for p in "$HOME/ldev/byze/build/bin/byze-cli" "$HOME/byze/build/bin/byze-cli" \
    "$HOME/.local/bin/byze-cli" /usr/local/bin/byze-cli /usr/bin/byze-cli; do
    client "$p" && return 0
  done
  if [ -d "$BASE" ]; then
    p="$(find "$BASE" -maxdepth 7 -type f -name byze-cli -print -quit 2>/dev/null || true)"
    client "$p" && return 0
  fi
  if command -v pgrep >/dev/null 2>&1 && \
    (pgrep -x byzed >/dev/null 2>&1 || pgrep -x byze-qt >/dev/null 2>&1); then
    EVIDENCE='Running BYZE Core process.'
  fi
  if [ -z "$EVIDENCE" ]; then
    for p in "$HOME/.byze" "$HOME/.config/byze" "$HOME/.local/share/byze" \
      "$HOME/.local/share/Byze" "$HOME/.local/bin/byzed"; do
      if [ -e "$p" ] || [ -L "$p" ]; then EVIDENCE="BYZE data or daemon: $p"; break; fi
    done
  fi
  if [ -z "$EVIDENCE" ]; then
    p="$(command -v byzed 2>/dev/null || true)"
    if [ -n "$p" ]; then EVIDENCE="Existing byzed executable: $p"; fi
  fi
  if [ -z "$EVIDENCE" ] && [ -d "$BASE" ]; then
    p="$(find "$BASE" -maxdepth 7 -name byzed -print -quit 2>/dev/null || true)"
    if [ -n "$p" ]; then EVIDENCE="Existing byzed executable: $p"; fi
  fi
  return 1
}
safe_tar() {
  # Reject archive paths escaping staging and all link/special entries.
  tar -tzf "$1" | awk '{n++;if ($0 ~ /^\// || $0 ~ /(^|\/)\.\.(\/|$)/) bad=1} END{if (!n || bad) exit 1}' ||
    fail 'Unsafe archive path.'
  tar -tvzf "$1" | awk '{n++;c=substr($0,1,1);if (c!="-" && c!="d") bad=1} END{if (!n || bad) exit 1}' ||
    fail 'Links or special files in archive.'
}
preflight_pool() {
  [ ! -L "$LAUNCHER" ] || fail 'Cannot overwrite launcher symlink.'
  if [ -e "$LAUNCHER" ] && ! grep -qx '# BYZE_P2POOL_MANAGED_LAUNCHER' "$LAUNCHER"; then
    fail 'Unmanaged P2Pool launcher; no overwrite.'
  fi
  [ ! -L "$MARKER" ] || fail 'Cannot overwrite Core marker symlink.'
  if [ -x "$POOL/bin/byze-p2pool" ]; then log 'Existing P2Pool package detected; reusing it.'; return; fi
  [ ! -e "$POOL" ] && [ ! -L "$POOL" ] || fail 'Incomplete P2Pool install; no overwrite.'
  curl --silent --show-error --fail --location --head --max-time 30 \
    --proto '=https' --proto-redir '=https' "$CLI_URL/$CLI_ASSET" -o /dev/null ||
    fail 'Complete Linux P2Pool release not published; nothing installed.'
}
install_core() {
  local dest="$BASE/byze-core-$CORE_TAG-linux-x64" keyhome= found= daemon= stage=
  [ -z "$EVIDENCE" ] && [ -z "$CORE_CLI" ] || fail 'Existing BYZE Core; will not reinstall.'
  [ ! -e "$dest" ] && [ ! -L "$dest" ] || fail 'Core installation target already exists.'
  command -v gpg >/dev/null || fail 'GnuPG is needed to verify official BYZE Core.'
  confirm NO 'Are you certain this machine has no existing BYZE Core?'
  confirm INSTALL "Install official Core $CORE_TAG in a new, versioned directory?"
  prepare
  keyhome="$TMP/gnupg"
  mkdir -m 700 "$keyhome"
  download "$CORE_URL/SHA256SUMS" "$TMP/SHA256SUMS"
  download "$CORE_URL/SHA256SUMS.asc" "$TMP/SHA256SUMS.asc"
  download "$CORE_URL/byze-release-signing-key.asc" "$TMP/release-key.asc"
  gpg --no-options --homedir "$keyhome" --batch --no-auto-key-retrieve \
    --import "$TMP/release-key.asc" >/dev/null 2>&1 || fail 'Invalid Core signing key.'
  gpg --no-options --homedir "$keyhome" --batch --no-auto-key-retrieve --status-fd 1 \
    --verify "$TMP/SHA256SUMS.asc" "$TMP/SHA256SUMS" > "$TMP/status" 2>/dev/null ||
    fail 'Core release signature invalid.'
  grep -Fq "[GNUPG:] VALIDSIG $CORE_FPR " "$TMP/status" ||
    fail 'Core release signer does not match the pinned fingerprint.'
  awk -v a="$CORE_ASSET" -v s="$CORE_SHA" \
    '($2==a||$2=="*"a){n++;if(tolower($1)!=s)bad=1} END{if(n!=1||bad)exit 1}' \
    "$TMP/SHA256SUMS" || fail 'Official signed Core checksum does not match pinned checksum.'
  download "$CORE_URL/$CORE_ASSET" "$TMP/$CORE_ASSET"
  printf '%s  %s\n' "$CORE_SHA" "$TMP/$CORE_ASSET" | sha256sum -c - >/dev/null ||
    fail 'Core archive checksum mismatch.'
  safe_tar "$TMP/$CORE_ASSET"
  stage="$TMP/core"
  mkdir -p "$stage"
  tar --no-same-owner --no-same-permissions -xzf "$TMP/$CORE_ASSET" -C "$stage"
  found="$(find "$stage" -type f -name byze-cli -print -quit)"
  daemon="$(find "$stage" -type f -name byzed -print -quit)"
  [ -n "$found" ] && [ -n "$daemon" ] || fail 'Verified Core archive missing daemon or CLI.'
  chmod u+x "$found" "$daemon"
  local client_rel= daemon_rel=
  client_rel="$(realpath --relative-to="$stage" "$found")"
  daemon_rel="$(realpath --relative-to="$stage" "$daemon")"
  mkdir -p "$BASE"
  [ ! -e "$dest" ] && [ ! -L "$dest" ] || fail 'Existing Core target; refusing overwrite.'
  mv "$stage" "$dest"
  CORE_CLI="$dest/$client_rel"
  CORE_DAEMON="$dest/$daemon_rel"
  log "CORE_INSTALLED: $dest"
}
start_core() {
  if "$CORE_CLI" getblockchaininfo >/dev/null 2>&1; then
    log 'Core RPC responds; existing node unchanged.'
    return
  fi
  if command -v pgrep >/dev/null 2>&1 && \
    (pgrep -x byzed >/dev/null 2>&1 || pgrep -x byze-qt >/dev/null 2>&1); then
    log 'BYZE process already running; refusing duplicate startup.'
    return
  fi
  if [ ! -x "$CORE_DAEMON" ]; then
    log 'Existing BYZE daemon path unknown; start the existing node manually.'
    return
  fi
  confirm START 'Start the detected BYZE daemon (without reinstalling)?'
  "$CORE_DAEMON" -daemon || fail 'Core daemon failed to start.'
  log 'Core started; sync may take time.'
}
install_pool() {
  local matched= stage=
  [ -n "$CORE_CLI" ] || fail 'No usable byze-cli; existing Core must be repaired.'
  prepare
  if [ -x "$POOL/bin/byze-p2pool" ]; then
    log 'Reusing installed P2Pool.'
  else
    download "$CLI_URL/$CLI_ASSET" "$TMP/$CLI_ASSET"
    download "$CLI_URL/SHA256SUMS" "$TMP/POOL-SHA256SUMS"
    matched="$(awk -v a="$CLI_ASSET" '($2==a||$2=="*"a){print}' "$TMP/POOL-SHA256SUMS")"
    [ "$(printf '%s\n' "$matched" | grep -c .)" -eq 1 ] || fail 'Invalid P2Pool checksum manifest.'
    printf '%s\n' "$matched" | awk -v expected="$CLI_SHA" 'tolower($1)==expected{ok=1} END{exit !ok}' || fail 'P2Pool published checksum differs from pinned archive hash.'
    (cd "$TMP" && printf '%s\n' "$matched" | sha256sum -c -) || fail 'P2Pool checksum mismatch.'
    printf '%s  %s\n' "$CLI_SHA" "$TMP/$CLI_ASSET" | sha256sum -c - >/dev/null || fail 'P2Pool pinned archive hash mismatch.'
    safe_tar "$TMP/$CLI_ASSET"
    stage="$TMP/pool"
    mkdir -p "$stage"
    tar --no-same-owner --no-same-permissions -xzf "$TMP/$CLI_ASSET" -C "$stage"
    [ -x "$stage/linux-x64/bin/byze-p2pool" ] || fail 'Unexpected P2Pool bundle layout.'
    [ ! -e "$POOL" ] && [ ! -L "$POOL" ] || fail 'P2Pool destination already exists.'
    mkdir -p "$BASE"
    mv "$stage/linux-x64" "$POOL"
  fi
  mkdir -p "$(dirname "$LAUNCHER")"
  printf '%s\n' "$CORE_CLI" > "$MARKER"
  cat > "$LAUNCHER" <<'EOF'
#!/bin/sh
# BYZE_P2POOL_MANAGED_LAUNCHER
if [ -z "$BYZE_CLI" ]; then
  BYZE_CLI="$(cat "$HOME/.local/opt/byze-p2pool-core-cli.path")"
  export BYZE_CLI
fi
BYZE_P2POOL_RELEASE_TAG="v0.2.5-rc3-evidence-test1"
BYZE_P2POOL_ARCHIVE_SHA256="4be720b76f5066edae2d8e84837efa2cd66349003f8a636335beeb83f614138b"
export BYZE_P2POOL_RELEASE_TAG BYZE_P2POOL_ARCHIVE_SHA256
exec "$HOME/.local/opt/byze-p2pool-0.2.5-rc3-evidence-test1-linux-x64/bin/byze-p2pool" "$@"
EOF
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
  log "P2Pool package installed. Waiting for BYZE Core synchronization (mainnet)."
  log "This may take a while. Progress is based on block heights, not verificationprogress."
  log "Press Ctrl+C to stop watching; BYZE Core will keep running."
  while :; do
    polls=$((polls + 1))
    raw="$("$CORE_CLI" getblockchaininfo 2>/dev/null || true)"
    blocks="$(printf '%s\n' "$raw" | /usr/bin/sed -nE 's/.*"blocks"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' | head -n 1)"
    headers="$(printf '%s\n' "$raw" | /usr/bin/sed -nE 's/.*"headers"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' | head -n 1)"
    ibd="$(printf '%s\n' "$raw" | /usr/bin/sed -nE 's/.*"initialblockdownload"[[:space:]]*:[[:space:]]*(true|false).*/\1/p' | head -n 1)"
    chain="$(printf '%s\n' "$raw" | /usr/bin/sed -nE 's/.*"chain"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n 1)"
    if [[ "$blocks" =~ ^[0-9]+$ && "$headers" =~ ^[0-9]+$ ]] && [ "$headers" -gt 0 ]; then
      percent="$(awk -v b="$blocks" -v h="$headers" 'BEGIN{p=100*b/h;if(p>100)p=100;printf "%.1f",p}')"
      log "BYZE synchronization: $blocks / $headers blocks ($percent% by height); IBD: ${ibd:-unknown}."
      if [ "$chain" = main ] && [ "$blocks" -gt 0 ] && [ "$headers" -ge "$blocks" ] &&
         [ $((headers - blocks)) -le 2 ] && [ "$ibd" = false ]; then
        if "$LAUNCHER" --check-node >/dev/null 2>&1; then
          log 'BYZE_NODE_READY. Synchronization confirmed. You can start P2Pool mining.'
          return 0
        fi
        log 'Core heights are current, but P2Pool readiness is still pending.'
      fi
    else
      if [[ "$blocks" =~ ^[0-9]+$ && "$headers" =~ ^[0-9]+$ ]]; then
        log "BYZE synchronization: $blocks / $headers blocks (waiting for block headers); IBD: ${ibd:-unknown}."
      else
        log 'Waiting for BYZE Core RPC / block headers (height unavailable).'
      fi
    fi
    if [ "$max_polls" -gt 0 ] && [ "$polls" -ge "$max_polls" ]; then
      log 'BYZE_NODE_NOT_READY. Sync monitor limit reached; BYZE Core remains running.'
      return 2
    fi
    sleep "$interval"
  done
}

BYZE_CLI="${BYZE_CLI-}"
case "$MODE" in
  --probe)
    if discover_core; then
      log "CORE_FOUND: $EVIDENCE"; log 'CORE_ACTION: REUSE_ONLY'
    elif [ -n "$EVIDENCE" ]; then
      log "CORE_FOUND: $EVIDENCE"; log 'CORE_ACTION: DO_NOT_REINSTALL'
    else
      log 'CORE_ABSENT: no existing Core found.'
    fi ;;
  --wait-sync)
    discover_core || fail 'Existing BYZE Core client not found; no installation attempted.'
    wait_for_mainnet_sync ;;
  --install|--install-core)
    for c in curl tar sha256sum awk grep realpath mktemp; do
      command -v "$c" >/dev/null || fail "Missing prerequisite: $c"
    done
    absent=0
    if discover_core; then
      log "CORE_FOUND: $EVIDENCE"; log 'CORE_ACTION: REUSE_ONLY'
    elif [ -n "$EVIDENCE" ]; then
      fail "Existing Core footprint: $EVIDENCE. Will not reinstall."
    else
      absent=1
    fi
    if [ "$MODE" = --install ]; then preflight_pool; fi
    if [ "$absent" -eq 1 ]; then install_core; fi
    start_core
    if [ "$MODE" = --install ]; then
      install_pool
      wait_for_mainnet_sync
    fi ;;
  *) fail 'Usage: install-linux.sh [--probe|--install-core|--install|--wait-sync]' ;;
esac
