#!/usr/bin/env -S npx tsx
// Deterministic fuzz-case generator for conformance/cases/generated/. Emits
// JSON fixtures (module/fn/input/expect), computed by running the REAL TS
// implementation (imported directly, same as ts.mjs) against generated,
// mostly-malformed inputs, so the corpus's `expect` values are correct by
// construction rather than hand-derived. Both languages must match these
// when conformance/run.sh runs (the JS-side run here is not itself a check -
// see conformance/scenario.md for why a shared, generated `expect` still
// proves cross-language parity).
//
// Deterministic: seeded PRNG (mulberry32), no wall-clock/Math.random. Every
// run with the same seed produces byte-identical files, so regenerating is
// idempotent and `git diff` after a regenerate is either empty or a real,
// reviewable change caused by an actual code change.
//
// Regenerate with:
//   npx tsx conformance/generate.mjs
//
// Output is committed to the repo (not generated in CI) so the corpus - and
// CI - stay reproducible without depending on this script matching some
// particular Node/tsx version at test time. Generated cases are committed
// artifacts: don't hand-edit files under cases/generated/, change this
// script and regenerate instead (see PARITY.md).
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEntry } from "../packages/core/src/jsonl.ts";
import { decodeImage } from "../packages/core/src/blob.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "cases", "generated");

// mulberry32: a small, widely-used deterministic PRNG (public-domain
// algorithm). The fixed seed is the entire point - a fuzz corpus that
// changes shape on every regenerate would make conformance/run.sh
// non-reproducible and any diff meaningless. Do not swap in Math.random.
const SEED = 0xc0ffee;
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const randInt = (maxExclusive) => Math.floor(rand() * maxExclusive);

// Every jsonl case is run with the same stub image sink used by ts.mjs/py.py:
// a fixed {blobId, bytes} regardless of input, never decoding. Malformed
// base64 fed to this stub is therefore harmless (nothing here decodes it) -
// the "blob" module's decodeImage/decode_image is the layer that actually
// decodes, and is what the malformed-base64 fuzzing further down targets.
const STUB_BLOB_ID = "stub-blob-id";
const STUB_BYTES = 999999;
const stubImageSink = () => ({ blobId: STUB_BLOB_ID, bytes: STUB_BYTES });

/** Short, filename-safe label for a fuzz input value, used to build unique,
 * self-describing case names. */
function describe(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return v.length === 0 ? "empty-array" : "array";
  if (typeof v === "object") return Object.keys(v).length === 0 ? "empty-object" : "object";
  if (typeof v === "string") return v === "" ? "empty-string" : "string";
  return String(v).replace(/[^a-zA-Z0-9]/g, "_");
}

const cases = [];
const seenNames = new Set();

function add(kase) {
  if (seenNames.has(kase.name)) throw new Error(`duplicate generated case name: ${kase.name}`);
  seenNames.add(kase.name);
  cases.push(kase);
}

/** A jsonl/parseEntry case: `expect` is computed by actually running
 * parseEntry (with the stub sink above), so it is correct by construction. */
function addJsonl(name, entry, lineNo = 1) {
  const expect = parseEntry(entry, lineNo, stubImageSink);
  add({ name, module: "jsonl", fn: "parseEntry", input: { entry, lineNo }, expect });
}

/** A blob/decodeImage case: `expect` is computed by actually running
 * decodeImage, so it is correct by construction. Only ever called with
 * well-formed base64 here (the fuzzer's random-bytes category below) - the
 * one class of input where TS/Python decode disagree (improperly padded
 * base64) is intentionally not fuzzed into the shared corpus; see
 * PARITY.md and the hand-picked cases/blob-decode-*.json fixtures. */
function addBlobDecode(name, base64) {
  const { blobId, bytes } = decodeImage(base64);
  add({ name, module: "blob", fn: "decodeImage", input: { base64 }, expect: { blobId, bytes: bytes.length } });
}

// ---------------------------------------------------------------------------
// Category: wrongly-typed fields on otherwise-recognized block types.
//
// This deliberately covers only `block.type` (matched by plain equality in
// both languages, e.g. `block.type === "tool_result"` / `block.get("type")
// == "tool_result"`, so a wrong-type value just falls through to the
// "unknown" branch identically in both - no coercion involved).
//
// It deliberately does NOT fuzz wrong types for tool_use_id/toolUseId,
// tool_use.name, tool_use.id, or tool_result.is_error: those fields are
// filled in via `?? fallback` + `String(...)` in jsonl.ts and `or fallback`
// + `str(...)` in jsonl.py, and that pairing is a genuine, pre-existing,
// systemic divergence unrelated to the ContentPart/image work this corpus is
// for - `??` only substitutes for null/undefined while Python's `or`
// substitutes for every falsy value (False, 0, "", [], {}), and
// `String(x)`/`str(x)` disagree on booleans ("true" vs "True") and objects
// ("[object Object]" vs "{}") anyway. Fuzzing those fields here would just
// rediscover the same known, separate bug family repeatedly rather than
// testing anything about this change - see PARITY.md's "known gaps" note.
// ---------------------------------------------------------------------------
const WRONG_VALUES = [123, true, false, null, [], {}, "unexpected-string"];

for (const wv of WRONG_VALUES) {
  addJsonl(`jsonl-fuzz-block-type-wrong-type-${describe(wv)}`, {
    type: "assistant",
    uuid: `a-btype-${describe(wv)}`,
    timestamp: "t1",
    message: { role: "assistant", content: [{ type: wv, text: "salvaged" }] },
  });
}

// ---------------------------------------------------------------------------
// Category: missing fields on otherwise-recognized block types.
// ---------------------------------------------------------------------------
addJsonl("jsonl-fuzz-tool-result-missing-tool-use-id", {
  type: "user",
  uuid: "u1",
  timestamp: "t1",
  message: { role: "user", content: [{ type: "tool_result", is_error: true, content: "oops" }] },
});
addJsonl("jsonl-fuzz-tool-result-missing-is-error", {
  type: "user",
  uuid: "u1",
  timestamp: "t1",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
});
// `input` is deliberately given a real value (not omitted) here: TS's
// `input: block.input` becomes an explicit `undefined` own-property when
// absent, which JSON.stringify then drops, while Python's
// `"input": block.get("input")` becomes `None`, which json.dumps keeps as
// `null`. That is a genuine, pre-existing cross-language wire-format gap
// (JSON.stringify drops undefined-valued keys; json.dumps does not drop
// None-valued keys) - real, but about optional-field serialization in
// general, not the ContentPart/image work this corpus is otherwise for. Not
// fixed here; avoided so the corpus doesn't fail on something unrelated.
addJsonl("jsonl-fuzz-tool-use-missing-name-and-id", {
  type: "assistant",
  uuid: "a1",
  timestamp: "t1",
  message: { role: "assistant", content: [{ type: "tool_use", input: { some: "value" } }] },
});
addJsonl("jsonl-fuzz-thinking-missing-thinking-and-text", {
  type: "assistant",
  uuid: "a1",
  timestamp: "t1",
  message: { role: "assistant", content: [{ type: "thinking" }] },
});
addJsonl("jsonl-fuzz-entry-missing-message", {
  type: "user",
  uuid: "u1",
  timestamp: "t1",
});
// timestamp is deliberately kept present here (only uuid is omitted): an
// absent timestamp hits the same undefined-vs-None wire-format gap noted
// above (TS drops the key, Python sends null for it) - out of scope for this
// corpus, so this case sticks to exercising the uuid fallback alone.
addJsonl("jsonl-fuzz-entry-missing-uuid", {
  type: "user",
  timestamp: "t1",
  message: { role: "user", content: "hi" },
});

// ---------------------------------------------------------------------------
// Category: extra, unexpected fields alongside valid ones.
// ---------------------------------------------------------------------------
addJsonl("jsonl-fuzz-text-block-extra-fields", {
  type: "assistant",
  uuid: "a1",
  timestamp: "t1",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "hi", unexpected: 123, nested: { deep: [1, 2, 3] } }],
  },
});
addJsonl("jsonl-fuzz-tool-result-extra-fields", {
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
        content: "ok",
        cache_control: { type: "ephemeral" },
        extra: "field",
      },
    ],
  },
});
addJsonl("jsonl-fuzz-image-block-extra-fields", {
  type: "user",
  uuid: "u1",
  timestamp: "t1",
  message: {
    role: "user",
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGk=", extra_source_field: true },
        cache_control: null,
      },
    ],
  },
});

// ---------------------------------------------------------------------------
// Category: absent / malformed `source` on an image block.
// ---------------------------------------------------------------------------
const SOURCE_VARIANTS = [
  ["absent", undefined],
  ["null", null],
  ["string", "a-string-not-an-object"],
  ["number", 42],
  ["array", []],
  ["empty-object", {}],
  ["only-data", { data: "onlydata" }],
  ["only-media-type", { media_type: "image/png" }],
  ["data-wrong-type", { data: 123, media_type: "image/png" }],
  ["media-type-wrong-type", { data: "abc", media_type: 456 }],
  ["data-null", { data: null, media_type: "image/png" }],
];
for (const [label, sv] of SOURCE_VARIANTS) {
  const block = sv === undefined ? { type: "image" } : { type: "image", source: sv };
  addJsonl(`jsonl-fuzz-image-source-${label}`, {
    type: "user",
    uuid: `u-src-${label}`,
    timestamp: "t1",
    message: { role: "user", content: [block] },
  });
}

// ---------------------------------------------------------------------------
// Category: null / empty content at every level content can appear.
// ---------------------------------------------------------------------------
const CONTENT_VARIANTS = [null, "", [], {}, 42, false];
for (const cv of CONTENT_VARIANTS) {
  addJsonl(`jsonl-fuzz-user-content-${describe(cv)}`, {
    type: "user",
    uuid: `u-content-${describe(cv)}`,
    timestamp: "t1",
    message: { role: "user", content: cv },
  });
  addJsonl(`jsonl-fuzz-assistant-content-${describe(cv)}`, {
    type: "assistant",
    uuid: `a-content-${describe(cv)}`,
    timestamp: "t1",
    message: { role: "assistant", content: cv },
  });
  addJsonl(`jsonl-fuzz-tool-result-nested-content-${describe(cv)}`, {
    type: "user",
    uuid: `u-tr-content-${describe(cv)}`,
    timestamp: "t1",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu1", is_error: false, content: cv }],
    },
  });
}

// ---------------------------------------------------------------------------
// Category: deeply nested or empty block arrays.
// ---------------------------------------------------------------------------
addJsonl("jsonl-fuzz-content-array-empty", {
  type: "user",
  uuid: "u1",
  timestamp: "t1",
  message: { role: "user", content: [] },
});
addJsonl("jsonl-fuzz-content-array-with-nested-array-element", {
  type: "user",
  uuid: "u1",
  timestamp: "t1",
  message: { role: "user", content: [[]] },
});
addJsonl("jsonl-fuzz-content-array-with-deeply-nested-array-element", {
  type: "user",
  uuid: "u1",
  timestamp: "t1",
  message: { role: "user", content: [[[[[]]]]] },
});
addJsonl("jsonl-fuzz-content-array-mixed-nested-and-real-blocks", {
  type: "user",
  uuid: "u1",
  timestamp: "t1",
  message: { role: "user", content: [[], "not-a-dict-either", 42, null, [[]], { type: "text", text: "real" }, []] },
});
addJsonl("jsonl-fuzz-assistant-content-array-mixed-nested-and-real-blocks", {
  type: "assistant",
  uuid: "a1",
  timestamp: "t1",
  message: {
    role: "assistant",
    content: [[], "nope", { type: "tool_use", name: "t", id: "i", input: {} }, [[]], { type: "text", text: "ok" }],
  },
});

// ---------------------------------------------------------------------------
// Category: non-ASCII and unicode text, in every place text can appear.
// ---------------------------------------------------------------------------
const UNICODE_SAMPLES = [
  "héllo wörld",
  "こんにちは世界",
  "مرحبا بالعالم",
  "🚀✨🔥 emoji text with surrogate pairs",
  "é́́ stacked combining marks",
  "​‍ zero-width space and joiner",
  'line1\nline2\ttab"quote\\backslash',
  "𝔘𝔫𝔦𝔠𝔬𝔡𝔣 astral-plane math letters",
];
UNICODE_SAMPLES.forEach((s, i) => {
  addJsonl(`jsonl-fuzz-unicode-user-string-content-${i}`, {
    type: "user",
    uuid: `u-uni-${i}`,
    timestamp: "t1",
    message: { role: "user", content: s },
  });
  addJsonl(`jsonl-fuzz-unicode-assistant-text-block-${i}`, {
    type: "assistant",
    uuid: `a-uni-${i}`,
    timestamp: "t1",
    message: { role: "assistant", content: [{ type: "text", text: s }] },
  });
  addJsonl(`jsonl-fuzz-unicode-salvaged-from-unknown-block-${i}`, {
    type: "assistant",
    uuid: `a-uniu-${i}`,
    timestamp: "t1",
    message: { role: "assistant", content: [{ type: "a_future_block_type", text: s }] },
  });
});

// ---------------------------------------------------------------------------
// Category: random well-formed base64 (blob module) - the "positive" fuzz
// side, expanding the two hand-written golden vectors into many random
// payloads so hashImageBytes/decodeImage agreement is proven broadly, not
// just for two fixed strings. Always properly padded (Buffer.toString runs
// once here to produce it), so this never touches the known padding
// divergence - see PARITY.md.
// ---------------------------------------------------------------------------
const RANDOM_BASE64_COUNT = 40;
const RANDOM_BASE64_MAX_LEN = 96;
for (let i = 0; i < RANDOM_BASE64_COUNT; i++) {
  const len = randInt(RANDOM_BASE64_MAX_LEN + 1); // 0..RANDOM_BASE64_MAX_LEN inclusive
  const bytes = Buffer.alloc(len);
  for (let j = 0; j < len; j++) bytes[j] = randInt(256);
  const b64 = bytes.toString("base64");
  addBlobDecode(`blob-fuzz-random-${String(i).padStart(3, "0")}-len${len}`, b64);
}

// ---------------------------------------------------------------------------
// Write out. Clear stale files first so a shrunk generator doesn't leave
// orphaned cases from a previous run behind.
// ---------------------------------------------------------------------------
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const kase of cases) {
  const file = path.join(outDir, `${kase.name}.json`);
  writeFileSync(file, JSON.stringify(kase, null, 2) + "\n");
}
console.log(`wrote ${cases.length} generated cases to ${path.relative(process.cwd(), outDir)}/`);
