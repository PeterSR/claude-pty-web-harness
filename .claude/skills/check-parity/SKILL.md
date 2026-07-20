---
name: check-parity
description: Verify the TS and Python backends are in feature + behaviour parity with each other and the wire protocol. Use after changing the protocol, jsonl/detect/blob, the harness, or a server route, and before merging such a change.
---

# check-parity

Confirm the TypeScript and Python backends agree on the featureset and behaviour defined in
[`PROTOCOL.md`](../../../PROTOCOL.md) and [`PARITY.md`](../../../PARITY.md).

Run these and report a concise PASS/FAIL table.

1. **TypeScript typecheck + tests**
   ```sh
   npm run build:libs   # protocol -> core -> react -> server, in dependency order
   npm run typecheck
   npm run test --workspace @petersr/claude-pty-web-harness-core
   ```

2. **Python tests**
   ```sh
   cd packages/python
   uv run python -m unittest discover -s tests
   ```
   (or `pytest -q`, as CI does).

3. **Cross-language conformance** (loads `conformance/cases/`, runs every case through both
   languages' real implementations, byte-compares):
   ```sh
   bash conformance/run.sh
   ```
   A `FAIL[<lang>] <case>: ...` line is a **parity break**, never a flake - open the failing case
   in `conformance/cases/` and the corresponding source before doing anything else.

4. **API-surface audit** - open [`PARITY.md`](../../../PARITY.md) and confirm every row still
   matches the actual source: protocol `ChatEvent`/`ContentPart` shapes
   (`packages/protocol/src/index.ts` vs `packages/python/claude_pty_web_harness/protocol.py`),
   `parseEntry`/`parse_entry` and the `detect` predicates, the harness surface
   (`packages/core/src/harness.ts` vs `claude_pty_web_harness/harness.py`, including the blob
   store's `blob()`/`kill()` behaviour), and the server REST/WS routes (including the
   `/sessions/:id/blobs/:blobId` route, its security rules: blobId regex, Content-Type allowlist,
   `nosniff`, generic 404, `Cache-Control: immutable`, and its `authenticateBlob`/
   `authenticate_blob` guard - it must replace the REST guard for that one route, not layer on top
   of it, in both languages). A capability present in one language but missing or
   differently-behaved in the other is a parity break, even if naming is (correctly) idiomatic per
   language.

5. **New-case audit** - if this change added a new `parseEntry`/`parse_entry` block type, a new
   `detect` predicate, or touched the blob hash, confirm a case for it was added to
   `conformance/cases/` (see [`conformance/scenario.md`](../../../conformance/scenario.md)'s rule:
   a case is added to the corpus *before* the behaviour is implemented in either language). A
   behaviour change with no corpus case is a gap conformance cannot see. If it also warrants fuzz
   coverage, add a mutation to `conformance/generate.mjs` and regenerate
   (`npx tsx conformance/generate.mjs`) rather than hand-writing a file under `cases/generated/`;
   confirm the regenerate produced either an empty diff or a reviewable one, never an error.

Report: per-step PASS/FAIL, and for any failure the specific language/step and the assertion that
broke. Do not declare parity green unless steps 1-5 all pass.
