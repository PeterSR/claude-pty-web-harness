// Run with: npx tsx --test src/blob.test.ts  (no extra test deps; uses node:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashImageBytes } from "./blob.js";

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
