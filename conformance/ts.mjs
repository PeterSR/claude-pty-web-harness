#!/usr/bin/env -S npx tsx
// Conformance runner (TypeScript) - implements conformance/scenario.md: load
// every case in conformance/cases/, run it through this language's actual
// implementation, and byte-compare the result against the shared `expect`.
// Imports the .ts sources directly (via tsx) rather than a built package, so
// this always exercises the real, current implementation with no build step
// in between.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEntry } from "../packages/core/src/jsonl.ts";
import { hashImageBytes, decodeImage } from "../packages/core/src/blob.ts";
import {
  readyForInput,
  hasInputPrompt,
  hasStylePicker,
  classifyStartupFailure,
  isHardStartupFailure,
} from "../packages/core/src/detect.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.join(here, "cases");

// Recurse into subdirectories (cases/generated/ holds the fuzz corpus - see
// generate.mjs) so both hand-written and generated cases run the same way.
function listCaseFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listCaseFiles(full));
    } else if (entry.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

// Canonical JSON: object keys sorted recursively, so the comparison below is
// a genuine byte-level string compare rather than a shape-approximate deep
// equal that might tolerate a missing/extra/reordered key.
// Models what JSON.stringify actually puts on the wire, not what the
// in-memory object holds: a key whose value is `undefined` is dropped, and an
// `undefined` array element becomes null. Without this the comparison is
// blind to an entire class of divergence - a TS event carrying `ts:
// undefined` (omitted on the wire) would look identical to a Python event
// carrying `ts: None` (serialized as null), which is precisely the gap that
// made the absent-versus-null optional-field bug untestable here.
function canon(value) {
  if (Array.isArray(value)) return "[" + value.map((v) => (v === undefined ? "null" : canon(v))).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canon(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function screenFromInput(input) {
  return {
    cols: 80,
    rows: input.lines.length,
    lines: input.lines,
    cursor: input.cursor ?? null,
    altScreen: false,
  };
}

// Every jsonl case is run with the same stub image sink: a fixed
// {blobId, bytes} regardless of input, never attempting to decode the given
// base64 at all. Both hash correctness (the "blob" module's job, pinned by
// its own golden-vector cases) and decode-byte-count correctness are
// deliberately out of scope here - this stub exists only to prove parseEntry
// wires the sink correctly and reports back exactly what it returns, nothing
// recomputed independently. Cases that need the real decode opt in with
// "sink": "real" (see realImageSink); those are what prove both ports accept
// and reject the same payloads.
const STUB_BLOB_ID = "stub-blob-id";
const STUB_BYTES = 999999;
const stubImageSink = () => ({ blobId: STUB_BLOB_ID, bytes: STUB_BYTES });

// The stub above is right for proving wiring, but a corpus built only on it
// is blind to the one thing that actually crosses the language boundary here:
// whether both ports' decoders accept and reject the same payloads. A case
// with "sink": "real" runs parseEntry against the production decode instead,
// so a divergence shows up as a different ContentPart type rather than
// hiding behind a fixed stub value.
const realImageSink = ({ base64 }) => {
  const { blobId, bytes } = decodeImage(base64);
  return { blobId, bytes: bytes.length };
};

function run(kase) {
  const { module: mod, fn, input } = kase;
  if (mod === "jsonl") {
    if (fn === "parseEntry") {
      const sink = kase.sink === "real" ? realImageSink : stubImageSink;
      return parseEntry(input.entry, input.lineNo, sink);
    }
    throw new Error(`unknown jsonl fn: ${fn}`);
  }
  if (mod === "detect") {
    switch (fn) {
      case "readyForInput":
        return readyForInput(screenFromInput(input));
      case "hasInputPrompt":
        return hasInputPrompt(input.lines);
      case "classifyStartupFailure":
        return classifyStartupFailure(input.text);
      case "isHardStartupFailure":
        return isHardStartupFailure(input.failure);
      case "hasStylePicker":
        return hasStylePicker(input.text);
      default:
        throw new Error(`unknown detect fn: ${fn}`);
    }
  }
  if (mod === "blob") {
    if (fn === "hashImageBytes") return hashImageBytes(Buffer.from(input.base64, "base64"));
    if (fn === "decodeImage") {
      const { blobId, bytes } = decodeImage(input.base64);
      return { blobId, bytes: bytes.length };
    }
    throw new Error(`unknown blob fn: ${fn}`);
  }
  throw new Error(`unknown module: ${mod}`);
}

const files = listCaseFiles(casesDir).sort();

let failed = false;
for (const file of files) {
  const kase = JSON.parse(readFileSync(file, "utf8"));
  // `"expect": { "throws": true }` pins rejection itself as the contract, so
  // both ports must refuse the same inputs rather than one throwing and the
  // other quietly returning something.
  const wantsThrow = kase.expect && kase.expect.throws === true;
  let got;
  try {
    got = run(kase);
  } catch (err) {
    if (wantsThrow) continue;
    console.error(`FAIL[ts] ${kase.name}: threw ${err && err.message ? err.message : err}`);
    failed = true;
    continue;
  }
  if (wantsThrow) {
    console.error(`FAIL[ts] ${kase.name}: expected a throw, got ${canon(got)}`);
    failed = true;
    continue;
  }
  const gotCanon = canon(got);
  const wantCanon = canon(kase.expect);
  if (gotCanon !== wantCanon) {
    console.error(`FAIL[ts] ${kase.name}: expected ${wantCanon}, got ${gotCanon}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
} else {
  console.log(`OK ts (${files.length} cases)`);
}
