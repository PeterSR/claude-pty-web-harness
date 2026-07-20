// Run with: npx tsx --test src/jsonl.test.ts  (no extra test deps; uses node:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEntry } from "./jsonl.js";

// base64 of "hello world" (11 bytes) / "hello" (5 bytes); used across cases so
// the expected `bytes` counts below are easy to eyeball.
const HELLO_WORLD_B64 = "aGVsbG8gd29ybGQ=";
const HELLO_B64 = "aGVsbG8=";

test("parseEntry: text-only entries are byte-identical to the pre-fix output (no `parts` key)", () => {
  const userString = parseEntry(
    { type: "user", uuid: "u1", timestamp: "t1", message: { role: "user", content: "hi there" } },
    1,
  );
  assert.deepEqual(userString, [{ id: "u1", ts: "t1", kind: "user", text: "hi there" }]);
  assert.ok(!("parts" in userString[0]), "pure-text user event must not gain a parts key");

  const userArray = parseEntry(
    {
      type: "user",
      uuid: "u2",
      timestamp: "t2",
      message: { role: "user", content: [{ type: "text", text: "block text" }] },
    },
    2,
  );
  assert.deepEqual(userArray, [{ id: "u2:u:0", ts: "t2", kind: "user", text: "block text" }]);

  const assistantText = parseEntry(
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "t3",
      message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
    },
    3,
  );
  assert.deepEqual(assistantText, [{ id: "a1:a:0", ts: "t3", kind: "assistant_text", text: "reply" }]);

  const toolResultTextOnly = parseEntry(
    {
      type: "user",
      uuid: "u3",
      timestamp: "t4",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu1", is_error: false, content: [{ type: "text", text: "ok" }] },
        ],
      },
    },
    4,
  );
  assert.deepEqual(toolResultTextOnly, [
    { id: "u3:tr:0", ts: "t4", kind: "tool_result", toolUseId: "tu1", text: "ok", isError: false },
  ]);
  assert.ok(!("parts" in toolResultTextOnly[0]), "pure-text tool_result must not gain a parts key");
});

test("parseEntry: tool_result with a text block plus an image block", () => {
  const calls: Array<{ base64: string; mediaType: string }> = [];
  const onImage = (payload: { base64: string; mediaType: string }) => {
    calls.push(payload);
    return "stub-blob-id";
  };

  const events = parseEntry(
    {
      type: "user",
      uuid: "u1",
      timestamp: "t1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu1",
            is_error: false,
            content: [
              { type: "text", text: "here is the result" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: HELLO_WORLD_B64 } },
            ],
          },
        ],
      },
    },
    1,
    onImage,
  );

  assert.deepEqual(events, [
    {
      id: "u1:tr:0",
      ts: "t1",
      kind: "tool_result",
      toolUseId: "tu1",
      // The legacy text field keeps joining only the text blocks, so an
      // image alongside text doesn't change what `text` says.
      text: "here is the result",
      isError: false,
      parts: [
        { type: "text", text: "here is the result" },
        { type: "image", blobId: "stub-blob-id", mediaType: "image/png", bytes: 11 },
      ],
    },
  ]);
  assert.deepEqual(calls, [{ base64: HELLO_WORLD_B64, mediaType: "image/png" }]);
});

test("parseEntry: a user-message image block (no sink) yields an event instead of vanishing", () => {
  const events = parseEntry(
    {
      type: "user",
      uuid: "u2",
      timestamp: "t2",
      message: {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: HELLO_B64 } }],
      },
    },
    2,
    // No onImage sink: without one the image degrades to "unknown" rather
    // than parseEntry inventing a placeholder blobId or leaking the payload.
  );

  assert.deepEqual(events, [
    { id: "u2:x:0", ts: "t2", kind: "user", text: "", parts: [{ type: "unknown", blockType: "image" }] },
  ]);
});

test("parseEntry: a user-message image block with a sink produces a real image part", () => {
  const events = parseEntry(
    {
      type: "user",
      uuid: "u2",
      timestamp: "t2",
      message: {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: HELLO_B64 } }],
      },
    },
    2,
    () => "blob-abc",
  );

  assert.deepEqual(events, [
    {
      id: "u2:x:0",
      ts: "t2",
      kind: "user",
      text: "",
      parts: [{ type: "image", blobId: "blob-abc", mediaType: "image/jpeg", bytes: 5 }],
    },
  ]);
});

test("parseEntry: an unknown assistant block type (e.g. redacted_thinking) surfaces instead of vanishing", () => {
  const events = parseEntry(
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "t1",
      message: {
        role: "assistant",
        content: [{ type: "redacted_thinking", data: "opaque" }],
      },
    },
    1,
  );

  assert.deepEqual(events, [
    {
      id: "a1:x:0",
      ts: "t1",
      kind: "assistant_text",
      text: "",
      parts: [{ type: "unknown", blockType: "redacted_thinking" }],
    },
  ]);
});

test("parseEntry: a malformed image block (missing source) falls back to unknown instead of throwing", () => {
  const events = parseEntry(
    {
      type: "user",
      uuid: "u1",
      timestamp: "t1",
      message: { role: "user", content: [{ type: "image" }] },
    },
    1,
    () => {
      throw new Error("onImage must not be called for a malformed image block");
    },
  );

  assert.deepEqual(events, [
    { id: "u1:x:0", ts: "t1", kind: "user", text: "", parts: [{ type: "unknown", blockType: "image" }] },
  ]);
});

test("parseEntry: an image block with a source missing data/media_type also falls back to unknown", () => {
  const events = parseEntry(
    {
      type: "user",
      uuid: "u1",
      timestamp: "t1",
      message: { role: "user", content: [{ type: "image", source: { type: "base64" } }] },
    },
    1,
    () => {
      throw new Error("onImage must not be called for a malformed image block");
    },
  );

  assert.deepEqual(events, [
    { id: "u1:x:0", ts: "t1", kind: "user", text: "", parts: [{ type: "unknown", blockType: "image" }] },
  ]);
});
