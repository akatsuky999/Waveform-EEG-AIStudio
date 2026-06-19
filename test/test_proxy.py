from __future__ import annotations

import unittest

from agent.backend.proxy import _clean_base_url


class ProviderConfigurationTests(unittest.TestCase):
    def test_base_url_must_be_explicit(self):
        with self.assertRaisesRegex(ValueError, "Base URL is required"):
            _clean_base_url("")

    def test_base_url_is_validated_and_normalized(self):
        self.assertEqual(_clean_base_url("https://api.openai.com/"), "https://api.openai.com")
        self.assertEqual(_clean_base_url("https://provider.example/v1"), "https://provider.example/v1")
        with self.assertRaisesRegex(ValueError, "credentials"):
            _clean_base_url("https://user:pass@provider.example")


if __name__ == "__main__":
    unittest.main()
