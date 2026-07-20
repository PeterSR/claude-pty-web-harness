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
| image sink (moves bytes to the harness's blob store) | `type ImageSink = (payload: {base64, mediaType}) => string` | `ImageSink = Callable[[str, str], str]` - `(base64_data, media_type) -> blob_id`, positional args rather than a dict (idiomatic; not part of the wire format so this doesn't need to match shape) |
| unrecognized content block | `{type:"unknown", blockType}` part, event still emitted | same |
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

Covered by the conformance corpus (module `"blob"`) with a golden SHA-256 vector - the
highest-value case in the corpus, since it proves both languages hash the same decoded bytes the
same way (a blobId is only a valid cache key / dedupe key if it is).

| TypeScript | Python |
|---|---|
| `hashImageBytes(bytes: Buffer): string` | `hash_image_bytes(data: bytes) -> str` |

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
| mount the routes | `registerHarnessRoutes(app, harness, opts)` | `include_harness_routes(app, harness, prefix=, dependencies=, authenticate_ws=)` / `create_router(...)` |
| `GET {prefix}/health` | yes, unauthenticated | yes, unauthenticated |
| `GET {prefix}/sessions` | yes, guarded | yes, guarded (`dependencies=dep`) |
| `POST {prefix}/sessions` | yes, guarded | yes, guarded |
| `GET {prefix}/sessions/:id` | yes, guarded | yes, guarded |
| `DELETE {prefix}/sessions/:id` | yes, guarded | yes, guarded |
| `POST {prefix}/sessions/:id/prompt` | yes, guarded | yes, guarded |
| `GET {prefix}/sessions/:id/blobs/:blobId` (new) | yes, guarded (same `preHandler` as the other REST routes) | yes, guarded (same `dependencies=dep` as the other REST routes) |
| `WS {prefix}/sessions/:id/stream` | yes, separate `authenticateWs` guard | yes, separate `authenticate_ws` guard |

The blob route's security rules apply identically in both languages: `blobId` validated against
`^[a-f0-9]{64}$` before any lookup, `Content-Type` served only from an allowlist (`image/png`,
`image/jpeg`, `image/gif`, `image/webp`; anything else -> `application/octet-stream`),
`X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, a single generic 404 for both an
unknown session and an unknown blob (never distinguishing which), and
`Cache-Control: public, max-age=31536000, immutable`.

## Rules

- **Behaviour parity is the contract; naming is idiomatic.** A capability present in one language
  and missing in the other is a parity break.
- **The wire format comes from [PROTOCOL.md](PROTOCOL.md)** - never re-derive it per language.
- **The pure-function surface (`jsonl`, `detect`, `blob`) is proven by a shared golden corpus**
  ([`conformance/cases/`](conformance/cases)), not by each language's own hand-written
  expectations - a case is added to the corpus before the behaviour is implemented in either
  language (see [`conformance/scenario.md`](conformance/scenario.md)).
- Run [`/check-parity`](.claude/skills/check-parity/SKILL.md) (or `conformance/run.sh` plus the
  test suites) before merging any change that touches the protocol, `jsonl`, `detect`, `blob`, the
  harness, or a server route.
