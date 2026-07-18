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

Errors return a non-2xx status with `{ "error": string }`. `POST /api/sessions`
returns 400 (missing `cwd`), 403 (`cwd` outside `allowedRoots`), or 500.

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
user           { kind: "user",           text }
assistant_text { kind: "assistant_text", text }
thinking       { kind: "thinking",       text }
tool_use       { kind: "tool_use",       name, toolUseId, input }
tool_result    { kind: "tool_result",    toolUseId, text, isError }
system         { kind: "system",         subtype?, text? }
result         { kind: "result",         subtype?, durationMs?, costUsd?, text? }
```
