"""Offline permission tests for Mac loopback BYZE Core RPC relay."""
import importlib.util
from pathlib import Path
import unittest

SOURCE=Path(__file__).resolve().parents[1] / "tools" / "byze-lab-rpc-relay.py"
spec=importlib.util.spec_from_file_location("byze_lab_rpc_relay", SOURCE)
relay=importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


class RelayPolicy(unittest.TestCase):
    def test_allow_read_only_mainnet_chain_calls(self):
        cases = (
            ("getblockchaininfo", []), ("getbestblockhash", []),
            ("getblockhash", [20930]),
            ("getblockheader", ["a"*64]),
            ("getblock", ["b"*64, 2]),
            ("getrawtransaction", ["a"*64, True, "b"*64]),
            ("decoderawtransaction", ["aabbccdd"]),
            ("validateaddress", ["byz1aabbccddeeff"]),
            ("getaddressinfo", ["byz1aabbccddeeff"]),
            ("getblocktemplate", []),
            ("getblocktemplate", [{"rules":["segwit"]}]),
        )
        for name, params in cases:
            with self.subTest(name=name, params=params):
                self.assertIsInstance(relay.validated(name, params), list)

    def test_deny_mutations_secret_reading_and_proposal_submission(self):
        cases=(
            ("submitblock", ["deadbeef"]), ("signpoolblock", ["abcd"]),
            ("stop", []), ("getwalletinfo", []), ("dumpprivkey", ["abc"]),
            ("sendtoaddress", ["abc", 1]), ("getblocktemplate",
                                            [{"mode":"proposal", "data":"abcd"}]),
            ("getblockchaininfo", ["extra"]), ("decoderawtransaction",
                                               [".." * 50]),
            ("getblockhash", ["../../secrets"]), ("getrawtransaction",
                                                  ["a"*64, False, "b"*64]),
        )
        for name, params in cases:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    relay.validated(name, params)

    def test_params_do_not_trigger_shell_execution(self):
        with self.assertRaises(ValueError):
            relay.validated("validateaddress", ["$(touch /tmp/unsafe)"])
        with self.assertRaises(ValueError):
            relay.validated("getblockhash", [True])


if __name__ == "__main__":
    unittest.main()
