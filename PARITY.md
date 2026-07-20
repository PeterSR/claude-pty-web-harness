# Parity matrix

`claude-pty-web-harness` ships two backends, TypeScript and Python, that speak the same
[wire protocol](PROTOCOL.md) so the same frontend works against either unchanged. **Behaviour**
must be identical; **naming** is idiomatic per language. Enforced by the conformance suite
([`conformance/`](conformance)) for the pure-function surface (`parseEntry`/`parse_entry`,
`detect`, the blob hash) and by hand-audit (this file, via
[`/check-parity`](.claude/skills/check-parity/SKILL.md)) for everything else. Any new capability
lands in **both** languages in the same change.

## Protocol (`packages/protocol` / `claude_pty_web_harness.protocol`)

| Type | TypeScript | Python |
|---|---|---|
| ChatEvent | `ChatEvent` (discriminated union on `kind`) | `ChatEvent = dict[str, Any]`, documented via a comment + kept in wire-parity by hand (no runtime validation, to guarantee byte-for-byte parity with the TS server) |
| ChatEvent variants | `user`, `assistant_text`, `thinking`, `tool_use`, `tool_result`, `system`, `result` | same seven `kind` values |
| ContentPart (new) | `ContentPart` union: `{type:"text",text}` \| `{type:"image",blobId,mediaType,bytes}` \| `{type:"unknown",blockType}` | `ContentPart = Union[TextPart, ImagePart, UnknownPart]` (TypedDicts, documentation-only - `ChatEvent` stays a plain dict at runtime) |
| `parts` field (new) | optional on the `user`, `assistant_text`, `tool_result` variants | optional key on the same three `kind` dicts |
| SessionSummary | `SessionSummary` interface | `SessionSummary` `TypedDict(total=False)` |
| SessionStatus | `"starting" \| "ready" \| "exited" \| "failed"` | same four `Literal` values |
| StartupFailure | 6-value union (see PROTOCOL.md) | same 6 `Literal` values |
| ServerMessage / ClientMessage | discriminated unions | plain dicts, same `type` values |

## Parsing (`packages/core/src/jsonl.ts` / `claude_pty_web_harness/jsonl.py`)

Covered by the conformance corpus (`conformance/cases/`, module `"jsonl"`).

| Capability | TypeScript | Python |
|---|---|---|
| parse one JSONL entry -> ChatEvent[] | `parseEntry(entry, lineNo, onImage?)` | `parse_entry(entry, line_no, on_image=None)` |
| image sink (moves bytes to the harness's blob store) | `type ImageSink = (payload: {base64, mediaType}) => {blobId, bytes}` | `ImageSink = Callable[[str, str], Tuple[str, int]]` - `(base64_data, media_type) -> (blob_id, byte_len)`, positional args and a tuple rather than a dict (idiomatic; not part of the wire format so this doesn't need to match shape). `bytes`/`byte_len` comes from the sink's own single decode, not a second independent one - see the blob hash section below. |
| sink call site is exception-safe | `blockToPart` wraps the `onImage(...)` call in try/catch | `_block_to_part` wraps the `on_image(...)` call in try/except |
| unrecognized content block | `{type:"unknown", blockType, text?}` part, event still emitted | same |
| legacy `text` field | joins the text of every block with a string `text` field, regardless of that block's `type` (byte-identical to the pre-fix `asText()`/`_as_text()`) | same |
| a bare array is not a content block | `typeof block !== "object" \|\| Array.isArray(block)` guard | `isinstance(block, dict)` already excludes lists |
| find the JSONL file for a session | `findJsonlPath(sessionId)` | `find_jsonl_path(session_id)` |
| tail a session's JSONL | `class JsonlTailer` (EventEmitter, `"event"`) | `class JsonlTailer` (`on_event` callback + `on_image` callback, both ctor args) |

## Detect predicates (`packages/core/src/detect.ts` / `claude_pty_web_harness/detect.py`)

Covered by the conformance corpus (module `"detect"`), including the historical parity break
(non-ASCII numbered-menu digits) as an explicit regression case.

| TypeScript | Python |
|---|---|
| `readyForInput(screen)` | `ready_for_input(screen)` |
| `hasInputPrompt(lines)` | `has_input_prompt(lines)` |
| `hasBypassWarning(text)` | `has_bypass_warning(text)` |
| `hasTrustModal(text)` | `has_trust_modal(text)` |
| `hasStylePicker(text)` | `has_style_picker(text)` |
| `isReadyFooter(text)` | `is_ready_footer(text)` |
| `classifyStartupFailure(text)` | `classify_startup_failure(text)` |
| `isHardStartupFailure(failure)` | `is_hard_startup_failure(failure)` |

## Image blob hash (`packages/core/src/blob.ts` / `claude_pty_web_harness/blob.py`)

Covered by the conformance corpus (module `"blob"`) with golden SHA-256 vectors - the
highest-value cases in the corpus, since they prove both languages hash the same decoded bytes the
same way (a blobId is only a valid cache key / dedupe key if it is).

| TypeScript | Python |
|---|---|
| `hashImageBytes(bytes: Buffer): string` | `hash_image_bytes(data: bytes) -> str` |
| `decodeImage(base64: string): {blobId, bytes: Buffer}` | `decode_image(base64_data: str) -> Tuple[str, bytes]` |

`decodeImage`/`decode_image` is the one decode per image (used by both the harness's `ImageSink`
and this conformance-testable form): `Buffer.from(str, "base64")` never throws and is lenient
about padding (`"abc"` -> 2 bytes), while Python's `base64.b64decode(str, validate=False)` raises
on improperly padded input (`"abc"` -> `binascii.Error`). **This is intentional and not
reconciled** - see "Known gaps" below. For well-formed, properly-padded base64 (every real image
payload, and the only kind fuzzed into the shared corpus) both decode identically.

## Harness (`packages/core/src/harness.ts` / `claude_pty_web_harness/harness.py`)

| Capability | TypeScript | Python |
|---|---|---|
| connect (or scream) | `ClaudeHarness.create(opts?)` | `ClaudeHarness.create(socket_path=, readiness=, allowed_roots=)` |
| namespace constant | `HARNESS_NAMESPACE` | `HARNESS_NAMESPACE` |
| create a session | `createSession(opts)` | `create_session(*, cwd, command=, model=, permission_mode=, extra_args=, cols=, rows=)` |
| list sessions | `list()` | `list()` |
| get one session | `get(id)` | `get(session_id)` |
| full transcript (for WS replay) | `transcript(id)` | `transcript(session_id)` |
| image blob lookup (new) | `blob(sessionId, blobId): ImageBlob \| undefined` (`{bytes: Buffer, mediaType: string}`) | `blob(session_id, blob_id) -> Optional[Tuple[bytes, str]]` (`(data, media_type)`) - tuple vs. named object is idiomatic, not a wire shape |
| send a prompt | `sendPrompt(id, text, opts?)` | `send_prompt(session_id, text, submit=True)` |
| interrupt (Ctrl-C) | `interrupt(id)` | `interrupt(session_id)` |
| kill a session | `kill(id)` (frees `session.blobs` as part of dropping the session) | `kill(session_id)` (frees `s.blobs` as part of popping the session) |
| chat/status events | `EventEmitter`: `"chat"`, `"status"` | `add_listener(fn)`: `fn(kind, session_id, payload)`, kind `"chat"` \| `"status"` |
| cwd allowlist rejection | throws `CwdNotAllowedError` (`code: "cwd_not_allowed"`) | raises `PermissionError` |

The per-session image blob store (new) is an implementation detail behind `blob()`/`kill()` above,
not a separate capability row: both languages key it by the SHA-256 hex blobId, store decoded
bytes (never base64), dedupe identical images to one entry, and free it when the session is
killed (it's just a field on the session object that gets dropped/popped).

## Server routes (`packages/server/src/index.ts` / `claude_pty_web_harness/server.py`)

| Route | TypeScript | Python |
|---|---|---|
| mount the routes | `registerHarnessRoutes(app, harness, opts)` | `include_harness_routes(app, harness, prefix=, dependencies=, authenticate_ws=, authenticate_blob=)` / `create_router(...)` |
| `GET {prefix}/health` | yes, unauthenticated | yes, unauthenticated |
| `GET {prefix}/sessions` | yes, guarded | yes, guarded (`dependencies=dep`) |
| `POST {prefix}/sessions` | yes, guarded | yes, guarded |
| `GET {prefix}/sessions/:id` | yes, guarded | yes, guarded |
| `DELETE {prefix}/sessions/:id` | yes, guarded | yes, guarded |
| `POST {prefix}/sessions/:id/prompt` | yes, guarded | yes, guarded |
| `GET {prefix}/sessions/:id/blobs/:blobId` (new) | yes, guarded by `authenticateBlob` if set, else the same REST guard as the other routes | yes, guarded by `authenticate_blob` if set, else the same `dependencies=dep` as the other routes |
| `WS {prefix}/sessions/:id/stream` | yes, separate `authenticateWs` guard | yes, separate `authenticate_ws` guard |

The blob route's security rules apply identically in both languages: `blobId` validated against
`^[a-f0-9]{64}$` before any lookup, `Content-Type` served only from an allowlist (`image/png`,
`image/jpeg`, `image/gif`, `image/webp`; anything else -> `application/octet-stream`),
`X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, a single generic 404 for both an
unknown session and an unknown blob (never distinguishing which), and
`Cache-Control: public, max-age=31536000, immutable`.

`authenticateBlob` / `authenticate_blob` exists because a browser `<img src>` can't send an
`Authorization` header, the same constraint documented for `authenticateWs`/`authenticate_ws`: a
header-based REST `authenticate`/`dependencies` guards the blob route in name only, and every
image renders broken under it. When set, it replaces the REST guard for that one route rather than
layering on top of it. A deployment setting header-based `authenticate` **must** also set
`authenticateBlob` or images 401. Recommended: a path-scoped `HttpOnly`, `SameSite=Strict` cookie
minted at session start; a query-string ticket is the fallback but leaks through access logs,
browser history, and `Referer`, so scope it to a single blobId if used. Neither language ships a
cookie/ticket helper - auth lives at the edge by design, so this is a hook only.

## Known gaps (found by the fuzz corpus, not fixed here - out of scope for this change)

Building the generated fuzz corpus (`conformance/generate.mjs`) surfaced two pre-existing
divergences unrelated to `ContentPart`/images. Recorded here rather than silently worked around, so
they don't get rediscovered by surprise later; the generator deliberately avoids fuzzing into them
(see the comments in `generate.mjs` next to each affected mutation) rather than fixing them, since
both are systemic and would need their own scoped change.

- **Optional-field omission on the wire.** When a field is absent (e.g. an entry with no
  `timestamp`, a `tool_use` block with no `input`), TS's object literals still carry the key with
  value `undefined`, which `JSON.stringify` then *drops* entirely. Python's dicts carry the same
  key with value `None`, which `json.dumps` *keeps* as `null`. Net effect: the same "field is
  absent" JSONL input produces a wire message with no `ts` key at all from the TS server, but
  `"ts": null` from the Python one. Only observable for a malformed/incomplete JSONL line (real
  Claude Code transcripts always write these fields) and harmless to the existing renderers (which
  treat both as falsy), but it is a real byte-level difference a strict consumer could notice.
- **`?? fallback` (TS) vs. `or fallback` (Python) disagree on falsy-but-not-null values.** `??`
  only substitutes for `null`/`undefined`; Python's `or` substitutes for *every* falsy value
  (`False`, `0`, `""`, `[]`, `{}`). Several fields in `jsonl.ts`/`jsonl.py` use this pattern
  (`tool_use_id`/`toolUseId`, `tool_use.name`, `tool_use.id`, `tool_result.is_error`), so a
  malformed block carrying e.g. `tool_use_id: false` or `is_error: []` produces different results
  per language (and `String(x)`/`str(x)` further disagree on booleans - `"true"` vs `"True"` - and
  on objects - `"[object Object]"` vs a dict repr - compounding it). `is_error`'s own divergence is
  narrower (`Boolean([])` is `true` in JS, `bool([])` is `False` in Python - only empty
  arrays/objects trip it, not `false`/`0`/`""`, since `is_error` casts directly with no `?? `/`or`
  fallback in front of it).

## Rules

- **Behaviour parity is the contract; naming is idiomatic.** A capability present in one language
  and missing in the other is a parity break.
- **The wire format comes from [PROTOCOL.md](PROTOCOL.md)** - never re-derive it per language.
- **The pure-function surface (`jsonl`, `detect`, `blob`) is proven by a shared golden corpus**
  ([`conformance/cases/`](conformance/cases)), not by each language's own hand-written
  expectations - a case is added to the corpus before the behaviour is implemented in either
  language (see [`conformance/scenario.md`](conformance/scenario.md)).
- **Generated cases (`conformance/cases/generated/`) are committed artifacts, not hand-edited
  ones.** They come from `conformance/generate.mjs`, a deterministic (seeded-PRNG), idempotent
  script - regenerate with `npx tsx conformance/generate.mjs` and commit the diff (empty if nothing
  changed) rather than editing a generated file directly.
- Run [`/check-parity`](.claude/skills/check-parity/SKILL.md) (or `conformance/run.sh` plus the
  test suites) before merging any change that touches the protocol, `jsonl`, `detect`, `blob`, the
  harness, or a server route.
