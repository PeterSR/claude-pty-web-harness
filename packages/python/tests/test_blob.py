"""Run with: uv run python -m unittest discover -s tests (stdlib only).
Mirrors blob.test.ts."""
import re
import unittest

from claude_pty_web_harness.blob import hash_image_bytes


class TestHashImageBytes(unittest.TestCase):
    def test_matches_known_sha256_test_vectors(self):
        # Proves TS/Python hash the same bytes the same way: these are the
        # same two vectors asserted in blob.test.ts.
        self.assertEqual(
            hash_image_bytes(b"hello world"),
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
        )
        self.assertEqual(
            hash_image_bytes(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        )

    def test_identical_bytes_hash_identically(self):
        a = hash_image_bytes(bytes([1, 2, 3, 4]))
        b = hash_image_bytes(bytes([1, 2, 3, 4]))
        self.assertEqual(a, b)

    def test_returns_lowercase_hex_digest_matching_the_blob_id_regex(self):
        blob_id = hash_image_bytes(b"anything")
        self.assertRegex(blob_id, r"^[a-f0-9]{64}$")


if __name__ == "__main__":
    unittest.main()
