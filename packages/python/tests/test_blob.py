"""Run with: uv run python -m unittest discover -s tests (stdlib only).
Mirrors blob.test.ts."""
import unittest

from claude_pty_web_harness.blob import decode_image, hash_image_bytes


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


class TestDecodeImage(unittest.TestCase):
    def test_decodes_properly_padded_base64_and_reports_matching_blob_id_and_bytes(self):
        blob_id, raw = decode_image("aGVsbG8gd29ybGQ=")  # "hello world"
        self.assertEqual(blob_id, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9")
        self.assertEqual(len(raw), 11)
        self.assertEqual(raw, b"hello world")

    def test_rejects_improperly_padded_base64_rather_than_guessing(self):
        # Node's Buffer.from would happily turn "abc" into 2 bytes while this
        # raises on the same string, which made one image block parse into an
        # "unknown" ContentPart here and an "image" one in TS. Validating first
        # is what reconciles the two ports; see decode_image's docstring and
        # the blob-decode-*-rejected conformance cases. The caller (jsonl.py's
        # _block_to_part) turns the raise into a graceful "unknown" part.
        with self.assertRaises(Exception):
            decode_image("abc")
        with self.assertRaises(Exception):
            decode_image("YQ")

    def test_accepts_the_malformed_looking_inputs_both_decoders_already_agreed_on(self):
        # Guards against over-tightening: these are not well-formed payloads
        # either, but Node and Python both decode them to zero bytes, so
        # rejecting them would break working behavior for no parity gain.
        self.assertEqual(decode_image("")[1], b"")
        self.assertEqual(decode_image("====")[1], b"")
        # Whitespace is stripped before validating, so a wrapped payload works.
        self.assertEqual(decode_image("YW  Jj")[1], b"abc")

    def test_strips_only_ascii_whitespace_so_both_ports_see_the_same_input(self):
        # Python's \s and JS's \s match different sets (JS also matches U+00A0
        # and U+FEFF), so both ports spell out an ASCII class instead. A
        # non-breaking space must survive stripping and then fail validation.
        with self.assertRaises(Exception):
            decode_image(" YWJj")
        with self.assertRaises(Exception):
            decode_image("YWJj﻿")


if __name__ == "__main__":
    unittest.main()
