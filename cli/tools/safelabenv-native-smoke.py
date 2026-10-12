#!/usr/bin/env python3
"""BYZE P2Pool native binary smoke using generic SafeLabEnv Remote V1.

Prerequisites: operator-enabled trusted binary inputs on both Remote Gateway
and local API, existing authenticated loopback SSH tunnel, and a verified
GitHub Actions Linux x64 native-only .tar.gz bundle. No VPS SSH per job.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request

MAX_INPUT_BYTES = 8 * 1024 * 1024
URL = "http://127.0.0.1:18766"
GUEST_SCRIPT = r"""
set -eu
mkdir -p /tmp/byze
tar -xzf /inputs/payload.bin -C /tmp/byze
miner=/tmp/byze/native/linux-x64/byze-p2pool-miner
verifier=/tmp/byze/native/linux-x64/byze-rxhash
test -f "$miner"
test -f "$verifier"
chmod 500 "$miner" "$verifier"
features=$("$miner" --features)
printf 'BYZE_NATIVE_FEATURES=%s\n' "$features"
case "$features" in *contract-direct-coinbase-v2*) ;; *) exit 31 ;; esac
if "$verifier" --once invalid >/tmp/verifier-stdout 2>/tmp/verifier-stderr; then
  echo BYZE_VERIFIER_INVALID_INPUT_UNEXPECTED_SUCCESS; exit 32
fi
cat /tmp/verifier-stderr
grep -q 'expects 160 hex chars' /tmp/verifier-stderr
echo SAFELABENV_BYZE_REMOTE_BINARY_OK
"""


def request(method: str, path: str, key: str,
            content: bytes | None = None, content_type: str | None = None,
            digest: str | None = None) -> dict:
    headers = {"Authorization": "Bearer " + key}
    if content_type:
        headers["Content-Type"] = content_type
    if digest:
        headers["X-Content-SHA256"] = digest
    req = urllib.request.Request(URL + path, data=content,
                                 headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        print(f"HTTP {exc.code}: {exc.read(1500).decode('utf-8', 'replace')}",
              file=sys.stderr)
        raise SystemExit(1)


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python3 cli/tools/safelabenv-native-smoke.py "
              "byze-p2pool-native-linux-x64.tar.gz", file=sys.stderr)
        return 2
    key = os.environ.get("SAFELABENV_REMOTE_API_KEY")
    if not key:
        print("Missing SAFELABENV_REMOTE_API_KEY", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    size = path.stat().st_size
    if not 0 < size <= MAX_INPUT_BYTES:
        print("Archive exceeds the 8 MiB upload limit", file=sys.stderr)
        return 2
    content = path.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    print("Uploading archive, bytes =", size, "SHA256 =", digest, flush=True)
    uploaded = request("POST", "/v1/inputs", key, content,
                       "application/octet-stream", digest)
    if uploaded.get("sha256") != digest or uploaded.get("size_bytes") != size:
        raise RuntimeError("Input receipt mismatch")
    print("Input ID:", uploaded["id"], flush=True)
    spec = {
        "image": "ubuntu",
        "input_id": uploaded["id"],
        "command": ["sh", "-ec", GUEST_SCRIPT],
        "cpus": 1, "memory_mib": 512, "timeout_seconds": 90,
    }
    job = request("POST", "/v1/jobs", key,
                  json.dumps(spec).encode(), "application/json")
    jid = job["id"]
    print("Job ID:", jid, flush=True)
    deadline = time.monotonic() + 110
    last = None
    while time.monotonic() < deadline:
        result = request("GET", "/v1/jobs/" + jid, key)
        status = result["status"]
        if status != last:
            print("Status:", status, flush=True)
            last = status
        if status in ("succeeded", "failed", "cancelled"):
            execution = result.get("result") or {}
            print("\nSTDOUT:\n", execution.get("stdout", ""))
            print("\nSTDERR:\n", execution.get("stderr", ""))
            print("Exit code:", execution.get("exit_code"))
            if (status == "succeeded" and execution.get("exit_code") == 0 and
                    "SAFELABENV_BYZE_REMOTE_BINARY_OK" in execution.get("stdout", "")):
                print("SAFELABENV_BYZE_REMOTE_BINARY_PASSED")
                return 0
            print("SAFELABENV_BYZE_REMOTE_BINARY_FAILED")
            return 1
        time.sleep(2)
    print("Polling deadline reached. Job ID:", jid)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
