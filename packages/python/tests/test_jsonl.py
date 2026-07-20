"""Run with: uv run python -m unittest discover -s tests (stdlib only).
Mirrors jsonl.test.ts."""
import unittest

from claude_pty_web_harness.jsonl import parse_entry

# base64 of "hello world" (11 bytes) / "hello" (5 bytes); used across cases so
# the expected "bytes" counts below are easy to eyeball.
HELLO_WORLD_B64 = "aGVsbG8gd29ybGQ="
HELLO_B64 = "aGVsbG8="


class TestParseEntryTextOnly(unittest.TestCase):
    def test_byte_identical_to_pre_fix_output(self):
        user_string = parse_entry(
            {"type": "user", "uuid": "u1", "timestamp": "t1", "message": {"role": "user", "content": "hi there"}},
            1,
        )
        self.assertEqual(user_string, [{"id": "u1", "ts": "t1", "kind": "user", "text": "hi there"}])
        self.assertNotIn("parts", user_string[0], "pure-text user event must not gain a parts key")

        user_array = parse_entry(
            {
                "type": "user", "uuid": "u2", "timestamp": "t2",
                "message": {"role": "user", "content": [{"type": "text", "text": "block text"}]},
            },
            2,
        )
        self.assertEqual(user_array, [{"id": "u2:u:0", "ts": "t2", "kind": "user", "text": "block text"}])

        assistant_text = parse_entry(
            {
                "type": "assistant", "uuid": "a1", "timestamp": "t3",
                "message": {"role": "assistant", "content": [{"type": "text", "text": "reply"}]},
            },
            3,
        )
        self.assertEqual(assistant_text, [{"id": "a1:a:0", "ts": "t3", "kind": "assistant_text", "text": "reply"}])

        tool_result_text_only = parse_entry(
            {
                "type": "user", "uuid": "u3", "timestamp": "t4",
                "message": {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "tu1", "is_error": False,
                         "content": [{"type": "text", "text": "ok"}]},
                    ],
                },
            },
            4,
        )
        self.assertEqual(tool_result_text_only, [
            {"id": "u3:tr:0", "ts": "t4", "kind": "tool_result", "toolUseId": "tu1", "text": "ok", "isError": False},
        ])
        self.assertNotIn("parts", tool_result_text_only[0], "pure-text tool_result must not gain a parts key")


class TestParseEntryToolResultImage(unittest.TestCase):
    def test_tool_result_with_text_block_plus_image_block(self):
        calls = []

        def on_image(base64_data, media_type):
            calls.append((base64_data, media_type))
            return "stub-blob-id"

        events = parse_entry(
            {
                "type": "user", "uuid": "u1", "timestamp": "t1",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result", "tool_use_id": "tu1", "is_error": False,
                            "content": [
                                {"type": "text", "text": "here is the result"},
                                {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                              "data": HELLO_WORLD_B64}},
                            ],
                        },
                    ],
                },
            },
            1,
            on_image,
        )

        self.assertEqual(events, [
            {
                "id": "u1:tr:0", "ts": "t1", "kind": "tool_result", "toolUseId": "tu1",
                # The legacy text field keeps joining only the text blocks, so
                # an image alongside text doesn't change what "text" says.
                "text": "here is the result",
                "isError": False,
                "parts": [
                    {"type": "text", "text": "here is the result"},
                    {"type": "image", "blobId": "stub-blob-id", "mediaType": "image/png", "bytes": 11},
                ],
            },
        ])
        self.assertEqual(calls, [(HELLO_WORLD_B64, "image/png")])


class TestParseEntryUserImageBlock(unittest.TestCase):
    def test_no_sink_falls_back_to_unknown_instead_of_vanishing(self):
        events = parse_entry(
            {
                "type": "user", "uuid": "u2", "timestamp": "t2",
                "message": {
                    "role": "user",
                    "content": [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                              "data": HELLO_B64}}],
                },
            },
            2,
            # No on_image sink: without one the image degrades to "unknown"
            # rather than parse_entry inventing a placeholder blob_id or
            # leaking the payload.
        )
        self.assertEqual(events, [
            {"id": "u2:x:0", "ts": "t2", "kind": "user", "text": "", "parts": [{"type": "unknown", "blockType": "image"}]},
        ])

    def test_with_sink_produces_a_real_image_part(self):
        events = parse_entry(
            {
                "type": "user", "uuid": "u2", "timestamp": "t2",
                "message": {
                    "role": "user",
                    "content": [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                              "data": HELLO_B64}}],
                },
            },
            2,
            lambda data, media_type: "blob-abc",
        )
        self.assertEqual(events, [
            {
                "id": "u2:x:0", "ts": "t2", "kind": "user", "text": "",
                "parts": [{"type": "image", "blobId": "blob-abc", "mediaType": "image/jpeg", "bytes": 5}],
            },
        ])


class TestParseEntryUnknownAssistantBlock(unittest.TestCase):
    def test_unknown_block_type_surfaces_instead_of_vanishing(self):
        events = parse_entry(
            {
                "type": "assistant", "uuid": "a1", "timestamp": "t1",
                "message": {"role": "assistant", "content": [{"type": "redacted_thinking", "data": "opaque"}]},
            },
            1,
        )
        self.assertEqual(events, [
            {
                "id": "a1:x:0", "ts": "t1", "kind": "assistant_text", "text": "",
                "parts": [{"type": "unknown", "blockType": "redacted_thinking"}],
            },
        ])


class TestParseEntryMalformedImageBlock(unittest.TestCase):
    def test_missing_source_falls_back_to_unknown_instead_of_raising(self):
        def on_image(data, media_type):
            raise AssertionError("on_image must not be called for a malformed image block")

        events = parse_entry(
            {
                "type": "user", "uuid": "u1", "timestamp": "t1",
                "message": {"role": "user", "content": [{"type": "image"}]},
            },
            1,
            on_image,
        )
        self.assertEqual(events, [
            {"id": "u1:x:0", "ts": "t1", "kind": "user", "text": "", "parts": [{"type": "unknown", "blockType": "image"}]},
        ])

    def test_source_missing_data_or_media_type_also_falls_back(self):
        def on_image(data, media_type):
            raise AssertionError("on_image must not be called for a malformed image block")

        events = parse_entry(
            {
                "type": "user", "uuid": "u1", "timestamp": "t1",
                "message": {"role": "user", "content": [{"type": "image", "source": {"type": "base64"}}]},
            },
            1,
            on_image,
        )
        self.assertEqual(events, [
            {"id": "u1:x:0", "ts": "t1", "kind": "user", "text": "", "parts": [{"type": "unknown", "blockType": "image"}]},
        ])


if __name__ == "__main__":
    unittest.main()
