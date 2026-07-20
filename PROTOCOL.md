# Protocol

The wire contract between a `claude-pty-web-harness` backend and any client. Both
reference backends (the TypeScript
[`@petersr/claude-pty-web-harness-server`](packages/server) and the Python
[`claude_pty_web_harness.server`](packages/python)) serve exactly this, so a
frontend works against either, and a completely different UI or backend can
interoperate by speaking it directly. The canonical TypeScript types live in
[`@petersr/claude-pty-web-harness-protocol`](packages/protocol/src/index.ts); the
Python mirror is [`protocol.py`](packages/python/claude_pty_web_harness/protocol.py).

All JSON uses camelCase keys. The default route prefix is `/api` (configurable).

## REST

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| `GET` | `/api/health` | | `{ "ok": true }` (unauthenticated) |
| `GET` | `/api/sessions` | | `SessionSummary[]` |
| `POST` | `/api/sessions` | `{ cwd, model? }` | `SessionSummary` |
| `GET` | `/api/sessions/:id` | | `SessionSummary` (404 if unknown) |
| `DELETE` | `/api/sessions/:id` | | `{ "ok": true }` (kills the session) |
| `POST` | `/api/sessions/:id/prompt` | `{ text }` | `{ "ok": true }` |
| `GET` | `/api/sessions/:id/blobs/:blobId` | | raw image bytes (404 if unknown) |

Errors return a non-2xx status with `{ "error": string }`. `POST /api/sessions`
returns 400 (missing `cwd`), 403 (`cwd` outside `allowedRoots`), or 500.

`POST /api/sessions/:id/prompt` returns 404 for an unknown or already-gone
session, and 409 when the screen shows an open numbered picker. An
`AskUserQuestion` prompt, a tool-permission prompt, and the trust modal all
render as the same "1. ..." rows, so the check behind the 409 only knows that
some picker is open, never which one - sending the prompt as written would
confirm whatever option is highlighted instead of submitting it, so the
request is rejected before anything is written rather than let that happen
silently. The guard depends on a screen capture: it only runs when the server
is configured with `readiness: "screen"` (the default); a server started with
`READINESS=delay` never captures a screen at all, so it never sees a picker
either, and the prompt always sends the old unconditional way in that mode
(see USAGE.md's Configuration section). Even in `"screen"` mode the guard only
narrows the window in which a collision can happen, it does not close it: a
picker that opens in the moment between the capture and the trailing Enter
still gets confirmed.

`GET /api/sessions/:id/blobs/:blobId` serves the bytes behind an `image`
`ContentPart` (see below): decoded, never-base64 bytes from the harness's
per-session blob store, keyed by the SHA-256 hex content hash embedded as
`blobId`. `blobId` is validated against `^[a-f0-9]{64}$` before any lookup;
`Content-Type` is served only from an allowlist (`image/png`, `image/jpeg`,
`image/gif`, `image/webp` - anything else becomes `application/octet-stream`),
with `X-Content-Type-Options: nosniff` and `Content-Disposition: inline`. An
unknown session and an unknown blob both 404 identically, so the response
never reveals which one missed. The content is hash-addressed and immutable,
so the response also carries `Cache-Control: public, max-age=31536000, immutable`.

## WebSocket

`WS /api/sessions/:id/stream`

On connect the server sends the current `status`, then replays the transcript so
far as `chat` messages, then streams live. Browsers cannot set an `Authorization`
header on a WebSocket, so guard the upgrade with a short-lived ticket / query
token (`authenticateWs` / `authenticate_ws`) rather than a bearer header.

Server -> client (`ServerMessage`):

```
{ "type": "status", "status": SessionStatus, "error"?: string }
{ "type": "chat",   "event": ChatEvent }
{ "type": "error",  "message": string }
```

An `error` message reports a failure that has no dedicated status/`ok` field to
ride on over this transport: an unauthorized or unknown-session upgrade, a
malformed `prompt` payload, or - the case this section exists to call out -
any failed `sendPrompt`/`send_prompt`, including a rejected picker collision.
The REST route can answer synchronously with 409 because it awaits the send;
the WebSocket's `prompt` message is fire-and-forget, so a failed send - picker
collision or otherwise - now surfaces afterward as this message instead of
being silently swallowed, which is how every kind of send failure on this path
used to behave.

Client -> server (`ClientMessage`):

```
{ "type": "prompt", "text": string }
{ "type": "interrupt" }
```

## Types

### SessionSummary

```
{ id, ptyId, cwd, model?, status, error?, createdAt }
```

- `id`: Claude's own session id (the `--session-id` the harness generated; it
  names the JSONL transcript file).
- `ptyId`: pupptyeer's pty session id.
- `error`: present only when `status` is `"failed"` (a `StartupFailure`).

### SessionStatus

```
"starting" | "ready" | "exited" | "failed"
```

- `starting`: launched, driving past the startup modals.
- `ready`: the input prompt is live and accepting prompts.
- `exited`: the claude process is gone (killed or ended).
- `failed`: startup never reached the input prompt; `SessionSummary.error`
  carries the reason.

### StartupFailure

The machine reason attached to a `"failed"` status:

```
"auth_blocked" | "rate_limit" | "workspace_trust_blocked"
| "tool_approval_blocked" | "custom_api_key_detected" | "startup_timeout"
```

`startup_timeout` is the catch-all when the deadline elapsed with nothing
recognizable on screen; the rest name a specific interactive block claude showed.

### ChatEvent

A discriminated union on `kind`. Every variant carries `id` and optional `ts`;
built from the JSONL Claude persists (the pty is used for input and to drive the
startup modals).

```
user           { kind: "user",           text, parts? }
assistant_text { kind: "assistant_text", text, parts? }
thinking       { kind: "thinking",       text }
tool_use       { kind: "tool_use",       name, toolUseId, input }
tool_result    { kind: "tool_result",    toolUseId, text, isError, parts? }
system         { kind: "system",         subtype?, text? }
result         { kind: "result",         subtype?, durationMs?, costUsd?, text? }
```

- `text` stays exactly as it always was: a flattened, text-only summary
  (joining only the plain-text content blocks). Old consumers that only read
  `text` see no change.
- `parts`, present only when there is something beyond plain text, is the
  lossless ordered breakdown of that message/tool result's content blocks (see
  `ContentPart` below). A pure-text event never gains a `parts` key.

### ContentPart

A discriminated union on `type`, one entry per content block:

```
text    { type: "text",    text }
image   { type: "image",   blobId, mediaType, bytes }
unknown { type: "unknown", blockType }
```

- `image`: `blobId` is the SHA-256 hex content hash of the decoded bytes -
  fetch them from `GET /api/sessions/:id/blobs/:blobId` (above). `bytes` is
  the decoded byte size. The raw bytes never travel inside a `ChatEvent`
  (they'd sit in the in-memory transcript for the session's life and get
  re-sent on every WebSocket reconnect); only the id, media type, and size do.
- `unknown`: a content-block type this library doesn't recognize (e.g. a
  future Anthropic block type). `blockType` is that block's own `type` string,
  so a renderer can at least say what kind of content it can't show yet,
  instead of silently dropping it the way earlier versions did.
