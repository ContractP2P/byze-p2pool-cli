#!/usr/bin/env python3
"""BYZE P2Pool consensus proof using a generic SafeLabEnv remote KVM.

- Source: powhermes/byze tag v0.2.5-rc4-plain-taproot-guard,
  src/kernel/chainparams.cpp and src/primitives/block.cpp.
- Binary: ContractP2P/byze-p2pool-cli experimental linux-x64 CI bundle.
- No wallet, no mainnet node, no guest network, no arbitrary host file paths.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import struct
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:18766"
# Historical CI run 37982214553. Its SHA is used as a reproducible
# pinned test fixture, not as evidence of a signed public release.
EXPECTED_ARCHIVE_SHA = "3b8dc23e1e6b7f73ccb3026beb257c23168bf0d9315ffbff730ff0e1b7910e69"
EXPECTED_GENESIS_HASH_DISPLAY = "00000a6ff6ac3c6549d30a1931c8ff1fc98be705c7802164d7fb61b2bec85070"
MAINNET_GENESIS_MERKLE = "946448a64c948d5a9c044306689cc47a4e1c12ee591f8871600ab8b9025f7cca"


def raw_hex(reverse_display_hex: str) -> str:
    return bytes.fromhex(reverse_display_hex)[::-1].hex()


def genesis_header() -> str:
    fields = (
        struct.pack("<I", 1)
        + bytes(32)
        + bytes.fromhex(MAINNET_GENESIS_MERKLE)[::-1]
        + struct.pack("<III", 1777337372, 0x1e0ffff0, 847791)
    )
    assert len(fields) == 80
    return fields.hex()


def request(method, path, key, body=None, content_type=None, digest=None):
    headers = {"Authorization": "Bearer " + key}
    if content_type:
        headers["Content-Type"] = content_type
    if digest:
        headers["X-Content-SHA256"] = digest
    req = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        print("HTTP", exc.code, exc.read(1300).decode("utf-8", "replace"), file=sys.stderr)
        raise SystemExit(1)


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python3 safelabenv-randomx-genesis.py byze-p2pool-native-...linux-x64-...tar.gz",
              file=sys.stderr)
        return 2
    key = os.environ.get("SAFELABENV_REMOTE_API_KEY")
    if not key:
        print("SAFELABENV_REMOTE_API_KEY is missing", file=sys.stderr)
        return 2
    src = Path(sys.argv[1])
    if not src.name.startswith("byze-p2pool-native-0.2.5-rc3-linux-x64-"):
        print("Expected pinned experimental Linux x64 bundle", file=sys.stderr)
        return 2
    data = src.read_bytes()
    if not 0 < len(data) <= 8 * 1024 * 1024:
        raise ValueError("Input violates fixed 8MiB upload limit")
    digest = hashlib.sha256(data).hexdigest()
    if digest != EXPECTED_ARCHIVE_SHA:
        print("Refusing archive: hash differs from already independently verified CI artifact",
              file=sys.stderr)
        return 2

    header = genesis_header()
    expected_raw = raw_hex(EXPECTED_GENESIS_HASH_DISPLAY)
    print("Mainnet genesis header (160 hex):", header)
    print("Expected BYZE Core hash:", EXPECTED_GENESIS_HASH_DISPLAY)
    print("Uploading verified Linux x64 bundle:", len(data), "bytes")
    up = request("POST", "/v1/inputs", key, data, "application/octet-stream", digest)
    if up.get("sha256") != digest:
        raise RuntimeError("Input receipt SHA-256 mismatch")

    guest = f"""set -eu
mkdir -p /tmp/byze
tar -xzf /inputs/payload.bin -C /tmp/byze --no-same-owner
test -f /tmp/byze/native/linux-x64/byze-rxhash
chmod 500 /tmp/byze/native/linux-x64/byze-rxhash
echo BYZE_RANDOMX_FULL_MEM_BEGIN
hash=$(/tmp/byze/native/linux-x64/byze-rxhash --once ${header})
printf 'BYZE_RANDOMX_HASH_RAW=%s\\n' "$hash"
echo BYZE_RANDOMX_FULL_MEM_END
"""

    spec = {
        "image": "ubuntu", "input_id": up["id"],
        "command": ["sh", "-ec", guest],
        "cpus": 1, "memory_mib": 4096, "timeout_seconds": 180,
    }
    job = request("POST", "/v1/jobs", key, json.dumps(spec).encode(), "application/json")
    jid = job["id"]
    print("Remote RandomX job:", jid, flush=True)
    deadline = time.monotonic() + 230
    last = None
    while time.monotonic() < deadline:
        result = request("GET", "/v1/jobs/" + jid, key)
        state = result["status"]
        if state != last:
            print("Status:", state, flush=True)
            last = state
        if state in ("succeeded", "failed", "cancelled"):
            details = result.get("result") or {}
            stdout, stderr = details.get("stdout", ""), details.get("stderr", "")
            print("Duration:", details.get("duration_seconds"), "s")
            print("STDOUT:\n", stdout)
            print("STDERR:\n", stderr[:3000])
            print("Exit code:", details.get("exit_code"))
            match = re.search(r"^BYZE_RANDOMX_HASH_RAW=([a-f0-9]{64})$", stdout, re.M)
            if state != "succeeded" or details.get("exit_code") != 0 or not match:
                print("SAFELABENV_BYZE_RANDOMX_HASH_FAILED")
                return 1
            actual_raw = match.group(1)
            actual_display = raw_hex(actual_raw)
            print("Observed BYZE hash:", actual_display)
            print("BYZE Core expected: ", EXPECTED_GENESIS_HASH_DISPLAY)
            if actual_raw != expected_raw:
                print("SAFELABENV_BYZE_RANDOMX_CONSENSUS_MISMATCH")
                return 1
            print("SAFELABENV_BYZE_RANDOMX_GENESIS_MATCH_PASSED")
            return 0
        time.sleep(2)
    print("Polling deadline reached, job:", jid)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
