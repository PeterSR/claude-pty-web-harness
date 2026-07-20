// Run with: npx tsx --test src/blob.test.ts  (no extra test deps; uses node:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashImageBytes, decodeImage } from "./blob.js";

test("hashImageBytes: matches the known SHA-256 test vectors (proves TS/Python hash the same bytes the same way)", () => {
  assert.equal(
    hashImageBytes(Buffer.from("hello world")),
    "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
  );
  assert.equal(hashImageBytes(Buffer.from("hello")), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
});

test("hashImageBytes: identical bytes hash identically (the dedupe property the blob store relies on)", () => {
  const a = hashImageBytes(Buffer.from([1, 2, 3, 4]));
  const b = hashImageBytes(Buffer.from([1, 2, 3, 4]));
  assert.equal(a, b);
});

test("hashImageBytes: returns a lowercase hex digest matching the blobId regex the server validates against", () => {
  const id = hashImageBytes(Buffer.from("anything"));
  assert.match(id, /^[a-f0-9]{64}$/);
});

test("decodeImage: decodes properly-padded base64 and reports the matching blobId + bytes", () => {
  const { blobId, bytes } = decodeImage("aGVsbG8gd29ybGQ="); // "hello world"
  assert.equal(blobId, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  assert.equal(bytes.length, 11);
  assert.equal(bytes.toString(), "hello world");
});

test("decodeImage: rejects improperly padded base64 rather than leniently decoding it", () => {
  // Node's Buffer.from would happily turn "abc" into 2 bytes while Python's
  // base64.b64decode raises on the same string, which made one image block
  // parse into an "image" ContentPart in TS and an "unknown" one in Python.
  // Validating first is what reconciles the two ports; see the doc comment on
  // decodeImage and the blob-decode-*-rejected conformance cases.
  assert.throws(() => decodeImage("abc"));
  assert.throws(() => decodeImage("YQ"));
});

test("decodeImage: accepts the malformed-looking inputs both decoders already agreed on", () => {
  // Guards against over-tightening: these are not well-formed payloads either,
  // but Node and Python both decode them to zero bytes, so rejecting them
  // would break working behavior for no parity gain.
  assert.equal(decodeImage("").bytes.length, 0);
  assert.equal(decodeImage("====").bytes.length, 0);
  // Whitespace is stripped before validating, so a wrapped payload still works.
  assert.equal(decodeImage("YW  Jj").bytes.toString(), "abc");
});

test("decodeImage: strips only ASCII whitespace, so the two ports see the same input", () => {
  // JS's \s matches more than Python's (U+00A0, U+FEFF and friends), so both
  // ports spell out an ASCII class instead. A non-breaking space must survive
  // stripping and then fail validation, in both languages.
  assert.throws(() => decodeImage(" YWJj"));
  assert.throws(() => decodeImage("YWJj﻿"));
});
