#!/usr/bin/env -S npx tsx
// Conformance runner (TypeScript) - implements conformance/scenario.md: load
// every case in conformance/cases/, run it through this language's actual
// implementation, and byte-compare the result against the shared `expect`.
// Imports the .ts sources directly (via tsx) rather than a built package, so
// this always exercises the real, current implementation with no build step
// in between.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEntry } from "../packages/core/src/jsonl.ts";
import { hashImageBytes } from "../packages/core/src/blob.ts";
import {
  readyForInput,
  hasInputPrompt,
  hasStylePicker,
  classifyStartupFailure,
  isHardStartupFailure,
} from "../packages/core/src/detect.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.join(here, "cases");

// Canonical JSON: object keys sorted recursively, so the comparison below is
// a genuine byte-level string compare rather than a shape-approximate deep
// equal that might tolerate a missing/extra/reordered key.
function canon(value) {
  if (Array.isArray(value)) return "[" + value.map(canon).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
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

// Every jsonl case is run with the same stub image sink: it never touches the
// real hash (that's what the "blob" module cases pin), it just proves the
// wiring - an image block gets *some* blobId embedded rather than vanishing
// or leaking raw base64.
const STUB_BLOB_ID = "stub-blob-id";

function run(kase) {
  const { module: mod, fn, input } = kase;
  if (mod === "jsonl") {
    if (fn === "parseEntry") return parseEntry(input.entry, input.lineNo, () => STUB_BLOB_ID);
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
    throw new Error(`unknown blob fn: ${fn}`);
  }
  throw new Error(`unknown module: ${mod}`);
}

const files = readdirSync(casesDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

let failed = false;
for (const file of files) {
  const kase = JSON.parse(readFileSync(path.join(casesDir, file), "utf8"));
  let got;
  try {
    got = run(kase);
  } catch (err) {
    console.error(`FAIL[ts] ${kase.name}: threw ${err && err.message ? err.message : err}`);
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
