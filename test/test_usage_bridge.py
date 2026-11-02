"""Synthetic reader fixtures: no credentials or network calls."""
import importlib.util
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).resolve().parents[1] / "scripts/usage_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class CreditsTest(unittest.TestCase):
    def module(self, amount=1234, currency="USD", fail=False):
        def get_json(url, headers):
            if url.endswith("/usage"):
                return {"extra_usage": {"monthly_limit": 999999, "used_credits": 0}}
            if url.endswith("/profile"):
                return {"organization": {"uuid": "synthetic-org"}}
            if url.endswith("/prepaid/credits"):
                if fail:
                    raise RuntimeError("synthetic error must not leak")
                return {"amount": amount, "currency": currency, "private": "must not copy"}
            raise AssertionError("Unexpected endpoint")

        module = SimpleNamespace(get_json=get_json)
        def fetch():
            module.get_json("https://api.anthropic.com/api/oauth/usage", {"Authorization": "synthetic"})
            return [("Session (5 hours)", 10, None, timedelta(hours=5)), ("Weekly (7 days)", 20, None, timedelta(days=7))]
        module.fetch_claude = fetch
        return module

    def test_actual_prepaid_minor_units_converted_once_only_under_weekly(self):
        module = self.module()
        original = module.get_json
        rows = bridge.claude_rows(module, {"usdToGbp": 0.8})
        self.assertNotIn("credits", rows[0])
        self.assertAlmostEqual(rows[1]["credits"], 9.872)
        self.assertIs(module.get_json, original)
        self.assertNotIn("must not copy", str(rows))

    def test_native_gbp_and_zero_do_not_require_exchange_rate(self):
        self.assertEqual(bridge.claude_rows(self.module(currency="GBP"), None)[1]["credits"], 12.34)
        self.assertEqual(bridge.claude_rows(self.module(amount=0, currency="GBP"), None)[1]["credits"], 0)

    def test_missing_rate_invalid_balance_or_endpoint_failure_preserves_allowances(self):
        for module, rate in [(self.module(), None), (self.module(fail=True), {"usdToGbp": .8}),
                             (self.module(amount=True), {"usdToGbp": .8}), (self.module(currency="EUR"), {"usdToGbp": .8})]:
            with self.subTest():
                rows = bridge.claude_rows(module, rate)
                self.assertIsNone(rows[1]["credits"])
                self.assertEqual(rows[1]["percent"], 20)


if __name__ == "__main__":
    unittest.main()
