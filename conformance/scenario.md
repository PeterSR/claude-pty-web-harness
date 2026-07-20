# Conformance scenario

Cross-language parity check for the pieces of this codebase that are pure
functions: JSONL parsing (`parseEntry` / `parse_entry`), the startup-detection
predicates (`detect.ts` / `detect.py`), and the image blob hash
(`blob.ts` / `blob.py`). Unlike [pupptyeer's conformance
suite](https://github.com/PeterSR/pupptyeer/blob/main/conformance/scenario.md)
(which drives a live daemon through a scripted end-to-end scenario), nothing
here needs a daemon, a server, or a process: both languages are handed the
exact same input and must produce the exact same output.

## The corpus is the source of truth

[`conformance/cases/`](cases) holds one JSON file per case, each shaped:

```json
{
  "name": "...",
  "module": "jsonl" | "detect" | "blob",
  "fn": "...",
  "input": { ... },
  "expect": ...
}
```

Neither language owns its own copy of the expectations - `conformance/ts.mjs`
and `conformance/py.py` both load the same files from `cases/` and run them
through that language's real implementation (TS sources directly via `tsx`,
no build step; Python via the editable `claude_pty_web_harness` install).
The comparison is a canonical (recursively key-sorted) JSON string compare,
so it is a genuine byte-level check, not a shape-approximate deep-equal that
might tolerate a missing, extra, or reordered key.

**Rule: a case is added to `cases/` before the behavior is implemented in
either language.** The corpus describes the contract; the two languages race
to satisfy it, not the other way around.

## What the corpus covers

- **`jsonl` / `parseEntry`**: every case from the parseEntry test spec -
  text-only entries produce byte-identical output (no `parts` key appears),
  a `tool_result` with a text block plus an image block, a user-message image
  block, an unknown assistant block type (e.g. `redacted_thinking`), and a
  malformed image block with a missing/incomplete `source` (falls back to an
  `unknown` part instead of throwing). All jsonl cases run through a stub
  image sink (`() => "stub-blob-id"`) - it exists to prove the sink is wired
  correctly (an image block gets *some* blobId instead of vanishing or
  leaking raw base64), not to test the hash itself; that's `blob`'s job.

- **`detect`**: the historical parity break this corpus exists to catch -
  numbered menu options using non-ASCII digits (Arabic-Indic, fullwidth,
  superscript) must classify identically in both languages. An over-eager
  digit check (e.g. Python's `str.isdigit()`, which is true for all three of
  those) would misclassify a row like `"❯ ٢. Trust this folder"` as a
  numbered menu option and report the session not ready; the correct
  (ASCII-only) check in both languages must not. Also covers a cursor sitting
  plainly on the `❯` prompt, an absent cursor, a not-visible cursor, a
  same-language regression on an ASCII numbered menu, `hasInputPrompt`,
  `classifyStartupFailure`, `isHardStartupFailure`, and `hasStylePicker`.

- **`blob` / the blobId hash**: `hashImageBytes` / `hash_image_bytes` against
  known SHA-256 test vectors. This is the highest-value case in the corpus -
  blobIds are content hashes, so a golden expected digest proves both
  languages hash the same decoded bytes the same way. If this ever diverged,
  identical images would dedupe under different ids per language, and the
  blob route's `Cache-Control: immutable` guarantee (the response can never go
  stale because the id is a hash of the bytes) would be unsound.

## Running it

```sh
bash conformance/run.sh
```

Runs both languages against every case in `cases/`, printing `OK <lang>` (all
cases passed) or `FAIL[<lang>] <case>: <assertion>` per failing case, then a
`PASS`/`FAIL` line per language and a non-zero exit if either failed. See
[`.claude/skills/check-parity/SKILL.md`](../.claude/skills/check-parity/SKILL.md)
for the full parity-check checklist this fits into.
