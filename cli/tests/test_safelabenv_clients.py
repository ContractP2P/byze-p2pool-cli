"""Offline contract tests for BYZE-specific SafeLabEnv clients.

No credentials, network, VPS or BYZE node are required.  Executables are
provided by the byze-p2pool-cli CI artifacts, not by SafeLabEnv itself.
"""
import ast
import importlib.util
from pathlib import Path
import struct
import unittest

TOOLS = Path(__file__).resolve().parents[1] / "tools"


def load(path):
    spec = importlib.util.spec_from_file_location("byze_remote_test_client", TOOLS / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SafeLabEnvBYZEClientTests(unittest.TestCase):
    def test_client_scripts_are_syntax_valid_and_no_custom_engine_profile(self):
        for name in ("safelabenv-native-smoke.py", "safelabenv-randomx-genesis.py"):
            source = (TOOLS / name).read_text(encoding="utf8")
            ast.parse(source)
            self.assertNotIn('"profile": "byze-randomx-v1"', source)
            self.assertIn('"/v1/inputs"', source)
            self.assertIn('"/v1/jobs"', source)
            self.assertIn('"input_id"', source)
            self.assertIn('SAFELABENV_REMOTE_API_KEY', source)

    def test_genesis_header_is_exactly_80_bytes(self):
        client = load("safelabenv-randomx-genesis.py")
        header = bytes.fromhex(client.genesis_header())
        self.assertEqual(len(header), 80)
        self.assertEqual(struct.unpack_from("<I", header, 0)[0], 1)
        self.assertEqual(header[4:36], bytes(32))
        self.assertEqual(header[36:68], bytes.fromhex(client.MAINNET_GENESIS_MERKLE)[::-1])
        self.assertEqual(struct.unpack_from("<III", header, 68),
                         (1777337372, 0x1e0ffff0, 847791))

    def test_hash_bytes_are_reversed_not_hex_characters(self):
        client = load("safelabenv-randomx-genesis.py")
        raw = client.raw_hex(client.EXPECTED_GENESIS_HASH_DISPLAY)
        self.assertEqual(raw, "7050c8beb261fbd7642180c705e78bc91fffc831190ad349653cacf66f0a0000")
        self.assertEqual(client.raw_hex(raw), client.EXPECTED_GENESIS_HASH_DISPLAY)

    def test_native_smoke_is_explicitly_a_non_mining_test(self):
        client = load("safelabenv-native-smoke.py")
        self.assertIn("--features", client.GUEST_SCRIPT)
        self.assertIn("--once invalid", client.GUEST_SCRIPT)
        self.assertIn("contract-direct-coinbase-v2", client.GUEST_SCRIPT)
        self.assertNotIn("submitblock", client.GUEST_SCRIPT)


if __name__ == "__main__":
    unittest.main()
