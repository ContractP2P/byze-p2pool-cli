#!/usr/bin/env python3
"""Loopback-only read-only BYZE Core RPC relay for a controlled P2Pool lab.

This is a narrow *test* relay, not a general RPC proxy. Never listens on
public interfaces, never forwards credentials, and never permits submission,
wallet mutation, raw RPC tunneling, or command execution chosen by a guest.
"""
import argparse
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import re
import subprocess
import sys

ADDR = re.compile(r"^[A-Za-z0-9:._-]{8,160}$")
HASH = re.compile(r"^[a-fA-F0-9]{64}$")
HEX = re.compile(r"^[a-fA-F0-9]+$")
METHODS = frozenset((
    "getblockchaininfo", "getbestblockhash", "getblockhash",
    "getblockheader", "getblock", "getrawtransaction",
    "getblocktemplate", "decoderawtransaction",
    "validateaddress", "getaddressinfo",
))
MAX_REQUEST = 65536
MAX_RPC_OUTPUT = 24 * 1024 * 1024


def validated(method, params):
    if not isinstance(method, str) or method not in METHODS:
        raise ValueError("Method prohibited")
    if type(params) is not list or len(params) > 3:
        raise ValueError("Invalid parameter count")
    if method in ("getblockchaininfo", "getbestblockhash"):
        ok = len(params) == 0
    elif method == "getblockhash":
        ok = len(params) == 1 and type(params[0]) is int and 0 <= params[0] <= 100000000
    elif method in ("getblockheader", "getblock"):
        ok = bool(params) and type(params[0]) is str and HASH.fullmatch(params[0])
        if method == "getblockheader":
            ok = ok and len(params) == 1
        else:
            ok = ok and (len(params) == 1 or
                         (len(params) == 2 and type(params[1]) is int and 0 <= params[1] <= 2))
    elif method == "getrawtransaction":
        ok = (len(params) == 3 and type(params[0]) is str
              and HASH.fullmatch(params[0]) is not None
              and params[1] is True and type(params[2]) is str
              and HASH.fullmatch(params[2]) is not None)
    elif method in ("validateaddress", "getaddressinfo"):
        ok = len(params) == 1 and type(params[0]) is str and ADDR.fullmatch(params[0]) is not None
    elif method == "decoderawtransaction":
        ok = (len(params) == 1 and type(params[0]) is str
              and 2 <= len(params[0]) <= 8192 and len(params[0]) % 2 == 0
              and HEX.fullmatch(params[0]) is not None)
    elif method == "getblocktemplate":
        ok = (not params or (len(params) == 1 and
              type(params[0]) is dict and params[0] == {"rules": ["segwit"]}))
    else:
        ok = False
    if not ok:
        raise ValueError("Parameters prohibited")
    return [json.dumps(x, separators=(",", ":")) if type(x) in (dict, list, bool, int)
            else x for x in params]


def create_handler(cli, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            # No request bodies, wallet addresses, RPC cookie paths or auth tokens logged.
            return

        def reply(self, code, obj):
            body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.path != "/rpc":
                return self.reply(404, {"ok": False, "error": "not-found"})
            supplied = self.headers.get("Authorization", "")
            if not hmac.compare_digest(supplied, "Bearer " + token):
                return self.reply(401, {"ok": False, "error": "unauthorized"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_REQUEST:
                    raise ValueError("Payload size")
                value = json.loads(self.rfile.read(length))
                if type(value) is not dict or set(value) != {"method", "params"}:
                    raise ValueError("Invalid RPC request")
                args = validated(value["method"], value["params"])
            except (ValueError, TypeError, UnicodeError):
                return self.reply(400, {"ok": False, "error": "request-rejected"})
            try:
                # Never invoke a shell, never forward guest CLI flags or arbitrary methods.
                proc = subprocess.run([cli, value["method"], *args], shell=False,
                                      capture_output=True, text=True, timeout=30,
                                      check=False)
                if proc.returncode or len(proc.stdout.encode("utf-8")) > MAX_RPC_OUTPUT:
                    return self.reply(502, {"ok": False, "error": "core-rpc-unavailable"})
                result = json.loads(proc.stdout)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                return self.reply(502, {"ok": False, "error": "core-rpc-unavailable"})
            return self.reply(200, {"ok": True, "result": result})
    return Handler


def main():
    parser = argparse.ArgumentParser(description="Read-only BYZE lab RPC bridge on Mac loopback")
    parser.add_argument("--byze-cli", required=True)
    parser.add_argument("--port", type=int, default=18755)
    args = parser.parse_args()
    if not 1024 <= args.port < 65536:
        parser.error("Port must be unprivileged")
    if not os.path.isabs(args.byze_cli) or not os.path.isfile(args.byze_cli):
        parser.error("Absolute existing byze-cli required")
    token = os.environ.get("BYZE_LAB_RELAY_TOKEN", "")
    if len(token) < 32 or len(token) > 256 or not token.isascii():
        parser.error("BYZE_LAB_RELAY_TOKEN with at least 32 ASCII characters required")
    print("Read-only local BYZE RPC relay active on 127.0.0.1:" + str(args.port), flush=True)
    print("Only allowlisted diagnostic/mining-template methods permitted; "
          "no wallet mutations or block submissions.", flush=True)
    server = HTTPServer(("127.0.0.1", args.port), create_handler(args.byze_cli, token))
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
