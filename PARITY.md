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
| `pickerOwnsInput(screen)` (exported from the package entry) | `picker_owns_input(screen)` (exported from the package entry) |
| `hasBypassWarning(text)` | `has_bypass_warning(text)` |
| `hasTrustModal(text)` | `has_trust_modal(text)` |
| `hasStylePicker(text)` | `has_style_picker(text)` |
| `isReadyFooter(text)` | `is_ready_footer(text)` |
| `hasExitConfirm(text)` (new) | `has_exit_confirm(text)` (new) |
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
and this conformance-testable form). The two languages' underlying decoders do **not** agree on
their own: `Buffer.from(str, "base64")` never throws and leniently decodes `"abc"` to 2 bytes,
while Python's `base64.b64decode` raises on the same string. Left alone that divergence was
wire-visible - the same image block became an `image` ContentPart in TS and an `unknown` one in
Python - so both ports **validate before decoding** and reject identically: strip ASCII whitespace
(spelled out, because JS's `\s` matches a wider set than Python's), then require the base64
alphabet with trailing padding and a length that is a multiple of 4. A payload that fails is not
well-formed base64 and would decode to garbage that could never render, so an honest `unknown`
part beats a blobId pointing at junk. Pinned by `blob-decode-*-rejected` and, at the layer where
it actually surfaced, by the `sink: "real"` cases `jsonl-real-sink-valid-image` and
`jsonl-real-sink-unpadded-image-rejected`.

## Harness (`packages/core/src/harness.ts` / `claude_pty_web_harness/harness.py`)

| Capability | TypeScript | Python |
|---|---|---|
| connect (or scream) | `ClaudeHarness.create(opts?)` | `ClaudeHarness.create(socket_path=, readiness=, allowed_roots=)` |
| namespace constant | `HARNESS_NAMESPACE` | `HARNESS_NAMESPACE` |
| create a session | `createSession(opts)` - `opts.env` (new) merges over the daemon's own environment for the spawned process, omitted entirely from the call to the client when not supplied | `create_session(*, cwd, command=, model=, permission_mode=, extra_args=, cols=, rows=, env=)` (new) - same merge, sent as `None` (not `{}`) when not supplied |
| list sessions | `list()` | `list()` |
| get one session | `get(id)` | `get(session_id)` |
| full transcript (for WS replay) | `transcript(id)` | `transcript(session_id)` |
| image blob lookup (new) | `blob(sessionId, blobId): ImageBlob \| undefined` (`{bytes: Buffer, mediaType: string}`) | `blob(session_id, blob_id) -> Optional[Tuple[bytes, str]]` (`(data, media_type)`) - tuple vs. named object is idiomatic, not a wire shape |
| send a prompt, refusing an open picker (new) | `sendPrompt(id, text, opts?)` - `opts.force` bypasses the guard | `send_prompt(session_id, text, submit=True, force=False)` |
| interrupt (Ctrl-C) | `interrupt(id)` | `interrupt(session_id)` |
| graceful shutdown (new) | `shutdown(id)` - two Ctrl-C's, confirm the "Exit anyway" modal with Enter (screen mode only), wait a bounded time, fall back to `kill()` | `shutdown(session_id)` - same shape |
| kill a session | `kill(id)` (frees `session.blobs` as part of dropping the session) | `kill(session_id)` (frees `s.blobs` as part of popping the session) |
| chat/status events | `EventEmitter`: `"chat"`, `"status"` | `add_listener(fn)`: `fn(kind, session_id, payload)`, kind `"chat"` \| `"status"` |
| cwd allowlist rejection | throws `CwdNotAllowedError` (`code: "cwd_not_allowed"`) | raises `PermissionError` |
| picker-open rejection (new) | throws `PickerOpenError` (`code: "picker_open"`) | raises `PickerOpenError` (`code = "picker_open"` class attribute) |

The per-session image blob store (new) is an implementation detail behind `blob()`/`kill()` above,
not a separate capability row: both languages key it by the SHA-256 hex blobId, store decoded
bytes (never base64), dedupe identical images to one entry, and free it when the session is
killed (it's just a field on the session object that gets dropped/popped).

`shutdown()` (new) has the same behaviour in both languages: write `0x03` twice 150ms apart (the
TUI's quit gesture), poll `listSessions`/`list_sessions` for the pty to disappear (a private
`waitExit`/`_wait_exit` helper that treats a failed poll as "not exited yet", never as an exit,
the same not-evidence-of-death stance the exit watcher takes), and on the `hasExitConfirm`/
`has_exit_confirm` modal confirm with a single Enter and wait again, before falling back to
`kill()`. The two grace windows (`1000`ms after the Ctrl-C's, `3000`ms after the confirm) and the
`100`ms poll interval are shared module constants in both ports. The screen read is skipped
entirely in `readiness: "delay"` mode (capture wedges claude there, same as `sendPrompt`'s picker
check), so that mode gets the clean-exit path but goes straight to the `kill()` fallback when
background work holds claude open. Every terminal path leaves the session `"exited"`.

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

`DELETE {prefix}/sessions/:id` calls `shutdown()`/`shutdown(session_id)`, not
`kill()`, in both languages: a session close now tears down claude's background
work through its own quit path rather than orphaning it, falling back to a hard
kill internally if that wedges. This is bounded but slower than a bare kill in
the worst case (see PROTOCOL.md); the library's `kill()` is still there for a
caller that wants an immediate hard stop.

`POST {prefix}/sessions/:id/prompt` maps a `PickerOpenError`/`PickerOpenError`
(the picker-open guard, see the Harness section above) to 409 identically in
both languages; any other send failure (an unknown or already-gone session id)
keeps the prior 404. The WebSocket `stream` route's `prompt` message used to
swallow a failed `sendPrompt`/`send_prompt` silently in both languages; both
now surface it as a `{ type: "error", message }` frame instead, for a picker
collision and for any other send failure alike.

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

Building the generated fuzz corpus (`conformance/generate.mjs`) surfaced pre-existing divergences
unrelated to `ContentPart`/images. Recorded here rather than silently worked around, so they don't
get rediscovered by surprise later; the generator deliberately avoids fuzzing into them (see the
comments in `generate.mjs` next to each affected mutation) rather than fixing them, since they are
systemic and would need their own scoped change.

Note that **optional-field omission on the wire is no longer one of them.** TS object literals
carry absent fields as `undefined` and `JSON.stringify` drops those keys, while Python dicts
carried them as `None` and `json.dumps` kept them as `null`, so the same JSONL line produced no
`ts` key from the TS server and `"ts": null` from the Python one. Python now copies optional
fields only when the source line actually carried them, keyed on presence rather than on the value
being `None`, so an explicit `"timestamp": null` still crosses as null in both. This was invisible
to the corpus until the TS runner's `canon()` was taught to model `JSON.stringify` (it had been
comparing in-memory objects, where an `undefined`-valued key is indistinguishable from a `null`
one); it is pinned now by the `jsonl-optional-*` cases.

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
