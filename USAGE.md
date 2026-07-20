# Usage

How to use the claude-pty-web-harness libraries from JavaScript/TypeScript and from
Python. Both speak the **same HTTP/WS protocol**, so any frontend works against
either backend, and you can mix and match.

- [What you get](#what-you-get)
- [Prerequisites](#prerequisites)
- [Quick start (run the demo)](#quick-start-run-the-demo)
- [JavaScript / TypeScript](#javascript--typescript)
- [Python](#python)
- [The wire protocol](#the-wire-protocol)
- [Install](#install)
- [Notes and gotchas](#notes-and-gotchas)
- [Configuration](#configuration)

## What you get

Two interchangeable backends plus a React UI. Each backend exposes the same API,
so the React app (or any client) talks to whichever is behind the proxy.

| Package | Lang | Role |
|---|---|---|
| `@petersr/claude-pty-web-harness-protocol` | TS | wire types (`ChatEvent`, messages, summaries), zero runtime |
| `@petersr/claude-pty-web-harness-core` | TS | `ClaudeHarness`: transport-agnostic logic (pupptyeer + JSONL + modal/readiness detection) |
| `@petersr/claude-pty-web-harness-server` | TS | reference Fastify + WebSocket adapter |
| `@petersr/claude-pty-web-harness-react` | TS | headless `useHarnessSession` hook + `createHarnessClient` |
| `@petersr/claude-pty-web-harness-app` | TS | the reference chat UI (the POC) |
| `claude_pty_web_harness` | Python | parity backend: `ClaudeHarness` + FastAPI/WS server |

The reuse surface for your own project is **protocol + core** (backend) and
**protocol + react** (frontend), or the Python `claude_pty_web_harness` package.
`server` and `app` are reference wiring you can copy or replace.

## Prerequisites

- A running **pupptyeer** daemon. The binary ships as `@petersr/pupptyeer`:

  ```bash
  npm i -g @petersr/pupptyeer
  pupptyeer daemon install   # supervises a user daemon at the default socket
  ```

  The harness connects to that daemon and fails loud if it is unreachable; it
  never spawns one. Restart it after upgrading pupptyeer (`pupptyeer daemon
  restart`) so capture-based readiness keeps working.
- `claude` on `PATH`, logged in.
- Node 20+ for the TS side; Python 3.10+ (and ideally `uv`) for the Python side.

## Quick start (run the demo)

```bash
npm install

# Backend: pick ONE (same port 4318)
npm run dev:server                         # TS (Fastify)
# or:
cd packages/python && uv venv && uv pip install -e . \
  && PORT=4318 uv run uvicorn claude_pty_web_harness.server:app

# Frontend (Vite on 4316, proxies /api + ws to 4318)
npm run dev:app
```

Open http://localhost:4316, set a working directory, click **New session**, chat.

## JavaScript / TypeScript

### Use the core in any backend

`ClaudeHarness` is an `EventEmitter` with imperative methods and no HTTP imports.
Wire it to any transport.

```ts
import { ClaudeHarness } from "@petersr/claude-pty-web-harness-core";
import type { ChatEvent, SessionStatus } from "@petersr/claude-pty-web-harness-protocol";

const harness = await ClaudeHarness.create({
  // all optional:
  // socketPath, readiness: "screen" | "delay", allowedRoots
});

harness.on("chat", (sessionId: string, event: ChatEvent) => { /* ... */ });
harness.on("status", (sessionId: string, status: SessionStatus) => { /* ... */ });

const session = await harness.createSession({
  cwd: "/repo",
  model: "sonnet",          // optional
  // command, permissionMode, extraArgs, cols, rows
});

await harness.sendPrompt(session.id, "first line\nsecond line"); // multi-line, one paste
harness.interrupt(session.id);     // Ctrl-C the current turn
harness.list();                    // SessionSummary[]
harness.get(session.id);           // SessionSummary | undefined
harness.transcript(session.id);    // ChatEvent[] captured so far
harness.blob(session.id, blobId);  // { bytes, mediaType } | undefined, for an image ContentPart
await harness.kill(session.id);
```

### Use the reference HTTP/WS server

Mount the routes on your own Fastify app, or run the bundled server.

```ts
import Fastify from "fastify";
import { ClaudeHarness } from "@petersr/claude-pty-web-harness-core";
import { registerHarnessRoutes } from "@petersr/claude-pty-web-harness-server";

const harness = await ClaudeHarness.create();
const app = Fastify();
await registerHarnessRoutes(app, harness, { prefix: "/api" });
await app.listen({ port: 4318, host: "127.0.0.1" });
```

`registerHarnessRoutes` accepts auth hooks so you can put it behind your app's
auth: `authenticate(req)` guards the REST routes (401 on false) and
`authenticateWs(req)` guards the WebSocket upgrade (browsers can't send an
`Authorization` header on a WS, so validate a short-lived ticket / query token
there). `/health` stays open.

> **Security.** The reference servers (TS and Python) are development tools with
> **no authentication**. They bind `127.0.0.1` by default, and sessions default
> to `permissionMode "bypassPermissions"`, so a spawned `claude` runs without
> tool approval prompts in any `cwd` a client requests. Never expose them beyond
> localhost as-is. Before any wider exposure, set `authenticate` /
> `authenticateWs` and `allowedRoots` (Python: `authenticate_ws` /
> `allowed_roots`) and consider a stricter permission mode.

### Use the React hook (bring your own components)

```tsx
import { useHarnessSession, createHarnessClient } from "@petersr/claude-pty-web-harness-react";

// REST client (create/list/kill sessions). baseUrl "" = same-origin.
const client = createHarnessClient(""); // or "http://localhost:4318"
const { id } = await client.createSession("/repo", "sonnet");

// In a component: owns the WebSocket, returns the live transcript.
function Chat({ sessionId }: { sessionId: string }) {
  const { events, status, connected, sendPrompt, interrupt, blobUrl } =
    useHarnessSession(sessionId, { baseUrl: "" });
  // render `events` (ChatEvent[]) however you like; an image ContentPart's
  // bytes live at blobUrl(part.blobId), e.g. <img src={blobUrl(part.blobId)} />
}
```

`ChatEvent` is a discriminated union on `kind`: `user`, `assistant_text`,
`thinking`, `tool_use`, `tool_result`, `result`. The `user`, `assistant_text`,
and `tool_result` variants also carry an optional `parts` (a `ContentPart[]`):
the lossless ordered breakdown of that message/tool result's content blocks
(text, image, or `unknown` for a block type this library doesn't recognize).
It's additive - `text` is unchanged, a flattened text-only summary - and only
present when there's something beyond plain text.

## Python

The Python package mirrors core + server. The pupptyeer client is sync; the
harness is asyncio and runs the client's calls in a thread executor.

### Install

```bash
pip install claude-pty-web-harness
# or, from a checkout: cd packages/python && uv venv && uv pip install -e .
```

### Use the core

```python
import asyncio
from claude_pty_web_harness import ClaudeHarness

async def main():
    harness = await ClaudeHarness.create(
        # all optional: socket_path=..., readiness="screen" | "delay",
        # allowed_roots=[...]
    )

    # listener(kind, session_id, payload): kind is "chat" (ChatEvent dict)
    # or "status" (SessionStatus string)
    remove = harness.add_listener(lambda kind, sid, payload: print(kind, payload))

    session = await harness.create_session(
        cwd="/repo",
        model="sonnet",        # optional
        # command, permission_mode, extra_args, cols, rows
    )
    await harness.send_prompt(session["id"], "first line\nsecond line")  # multi-line, one paste
    await harness.interrupt(session["id"])
    harness.list()                       # list[SessionSummary]
    harness.get(session["id"])           # SessionSummary | None
    harness.transcript(session["id"])    # list[ChatEvent]
    harness.blob(session["id"], blob_id) # (bytes, media_type) | None, for an image ContentPart
    await harness.kill(session["id"])

asyncio.run(main())
```

ChatEvents are plain dicts with the same (camelCase) keys as the TS protocol.

### Run the reference FastAPI server

```bash
PORT=4318 uv run uvicorn claude_pty_web_harness.server:app
# or: PORT=4318 uv run python -m claude_pty_web_harness.server
```

Or mount the harness on your own FastAPI app: see `claude_pty_web_harness/server.py`
(`lifespan` creates the harness; each route reads `app.state.harness`). REST
routes accept FastAPI `dependencies` for auth; the WebSocket is guarded
separately via `authenticate_ws`.

## The wire protocol

Both backends serve this. A completely different UI or backend can interoperate
by speaking it directly.

REST (prefix `/api`):

- `GET    /api/health` -> `{ ok: true }`
- `GET    /api/sessions` -> `SessionSummary[]`
- `POST   /api/sessions` `{ cwd, model? }` -> `SessionSummary`
- `GET    /api/sessions/:id` -> `SessionSummary` (404 if unknown)
- `DELETE /api/sessions/:id` -> `{ ok: true }`
- `POST   /api/sessions/:id/prompt` `{ text }` -> `{ ok: true }`
- `GET    /api/sessions/:id/blobs/:blobId` -> raw image bytes (404 if unknown;
  `blobId` is the SHA-256 hex hash from an `image` `ContentPart`)

WebSocket `/api/sessions/:id/stream`:

- On connect the server sends a `status` message, then replays the transcript as
  `chat` messages, then streams live.
- Server -> client: `{ type: "status", status, error? }` | `{ type: "chat", event }` | `{ type: "error", message }`
- Client -> server: `{ type: "prompt", text }` | `{ type: "interrupt" }`

`SessionSummary`: `{ id, ptyId, cwd, model, status, error?, createdAt }`.
`status`: `"starting" | "ready" | "exited" | "failed"`. A `"failed"` session
never reached the input prompt; `error` then holds a machine reason (a
`StartupFailure`): `auth_blocked`, `rate_limit`, `workspace_trust_blocked`,
`tool_approval_blocked`, `custom_api_key_detected`, or `startup_timeout`.

`ChatEvent` (discriminated by `kind`, all carry `id` and optional `ts`):

```
user           { kind:"user", text, parts? }
assistant_text { kind:"assistant_text", text, parts? }
thinking       { kind:"thinking", text }
tool_use       { kind:"tool_use", name, toolUseId, input }
tool_result    { kind:"tool_result", toolUseId, text, isError, parts? }
result         { kind:"result", subtype?, durationMs?, costUsd?, text? }
```

`parts` (a `ContentPart[]`) is optional and additive: present only when a
message/tool result has something beyond plain text, so `text` stays exactly
what it always was (a flattened text-only summary) and old consumers see no
change.

```
text    { type:"text", text }
image   { type:"image", blobId, mediaType, bytes }
unknown { type:"unknown", blockType }
```

An `image` part's bytes live at `GET /api/sessions/:id/blobs/:blobId`
(`blobId` is the SHA-256 hex hash of the decoded bytes); they never travel
inside the `ChatEvent` itself, since the harness holds the full transcript in
memory and replays it on every WebSocket reconnect. `unknown` is a content
block this library doesn't recognize (e.g. a future Anthropic block type);
`blockType` names it, so it surfaces instead of silently vanishing.

Chat is built from the JSONL Claude persists (we generate the `--session-id`);
the pty is used for input and for driving the startup modals.

## Install

### JS (npm)

The libraries are published under the `@petersr/` scope:

```bash
npm i @petersr/claude-pty-web-harness-core @petersr/claude-pty-web-harness-protocol
# frontend:
npm i @petersr/claude-pty-web-harness-react
```

`core` pulls in the `pupptyeer-client` npm package automatically.

**Developing in this repo:** these are npm workspaces, so `npm install` at the
root links every package and resolves them to source. The reference `server`
(via `tsx`) and `app` (via Vite) run the TypeScript directly, so there is no
per-package build step for the demo.

### Python

```bash
pip install claude-pty-web-harness   # pulls pupptyeer-client from PyPI
```

Or, from a checkout (editable, live changes):

```toml
# consumer pyproject.toml (uv)
[project]
dependencies = ["claude-pty-web-harness"]

[tool.uv.sources]
claude-pty-web-harness = { path = "../claude-pty-web-harness/packages/python", editable = true }
```

For local development against an unpublished pupptyeer checkout, set
`PUPPTYEER_PY_CLIENT=/path/to/pupptyeer/clients/python` to import that copy
instead of the installed `pupptyeer-client`.

## Notes and gotchas

### Permission modes (read this before exposing it)

Sessions default to `--permission-mode bypassPermissions`, which approves every
tool call with no checks: the agent can run arbitrary commands and edit any file
inside the session's `cwd` without prompting. The default favors low friction
and is **not** safe for untrusted input. Contain it with `allowedRoots` (reject a
`cwd` outside an allowlist) and the server auth hooks, and only point it at
directories you trust.

Because the harness drives the real `claude` TUI in a pty, it can use claude's
interactive **auto mode**, where a classifier vets each action, auto-approving
safe ones and prompting/denying risky ones. It is the best overall balance for a
web-driven agent and works here precisely because we own the pty (it is not
available in headless `claude -p`). Select it per session:

```ts
await harness.createSession({ cwd, permissionMode: "auto" });
```
```python
await harness.create_session(cwd="/repo", permission_mode="auto")
```

`permissionMode` / `permission_mode` is passed straight through to
`claude --permission-mode <value>`, so `default`, `plan`, `acceptEdits`, `auto`,
and `bypassPermissions` all work (use `extraArgs` for anything else). Auto mode
needs a recent claude CLI and an eligible model; if it is unavailable claude
falls back, so confirm it actually engaged.

### Daemon must be restarted after a pupptyeer upgrade

A long-running daemon keeps its old code. After upgrading pupptyeer, restart the
daemon (`pupptyeer daemon restart`) or `captureScreen` can return an empty grid
(readiness silently never fires; chat still works via JSONL). To run against a
private daemon instead of the shared default-socket one:

```bash
PUPPTYEER_SOCK=/tmp/cph/d.sock pupptyeer daemon &
PORT=4318 PUPPTYEER_SOCK=/tmp/cph/d.sock npm run dev:server   # or the Python server
```

### Driving claude's interactive TUI in a pty

Because a pty is a real TTY, claude shows startup modals that the harness drives
blind off the rendered grid:

- **Bypass Permissions warning**: cursor defaults to "1. No, exit" (a bare Enter
  would quit claude), so the harness sends Down then Enter to pick "Yes, I
  accept". claude remembers acceptance, so it often does not reappear.
- **Trust this folder**: confirmed with Enter.
- If a daemon's capture is unavailable, `READINESS=delay` skips capture entirely
  and marks ready after a short delay (relies on claude's remembered config).

### A stuck startup ends in `failed`, with a reason

If claude never reaches the input prompt, the session does not hang in
`starting`: it transitions to `failed` and carries a machine reason. The harness
classifies the rendered screen the way [claude-p](https://github.com/PeterSR/claude-p)
does, fast-failing on terminal surfaces it cannot drive past:

- `auth_blocked`: not logged in / `API Error: 403` / `please run /login`.
- `rate_limit`: a usage limit was hit before startup finished.
- `custom_api_key_detected`: the "Detected a custom API key" modal (unset
  `ANTHROPIC_API_KEY`/`AUTH_TOKEN`, or accept it).
- `workspace_trust_blocked`: the trust modal could not be cleared.
- `tool_approval_blocked`: a permission prompt is waiting.
- `startup_timeout`: the deadline elapsed with nothing recognizable on screen.

The reason rides on `SessionSummary.error` (REST `GET /api/sessions/:id`) and on
the `{ type: "status", status: "failed", error }` WebSocket frame. In React it is
the `error` field returned by `useHarnessSession`. A failed session's pty is left
alive so you can inspect or `kill()` it; it will not accept prompts.

### Multi-line prompts

`sendPrompt` delivers the text as a bracketed paste so multi-line input lands in
the TUI intact, then submits with one Enter. Pass `{ submit: false }` (TS) /
`submit=False` (Python) to stage the text without sending.

### Optimistic echo in the React hook

`useHarnessSession` shows your prompt immediately as a local `user` event, then
de-dupes it by text when the real JSONL `user` entry arrives. Harmless, but it is
why a just-sent prompt can briefly exist twice in state.

### Port 4318, not 4317

The default backend port is 4318. Override with `PORT`. The Vite app proxies
`/api` to `BACKEND_URL` (default `http://127.0.0.1:4318`).

## Configuration

Environment variables (read by both reference servers):

| Var | Meaning |
|---|---|
| `PORT` | server port (default 4318) |
| `HOST` | bind host (default 127.0.0.1) |
| `PUPPTYEER_SOCK` | daemon socket (else `$XDG_RUNTIME_DIR/pupptyeer/daemon.sock`) |
| `READINESS` | `screen` (default, daemon-rendered) or `delay` (no capture; fallback) |
| `PUPPTYEER_PY_CLIENT` | (Python, dev only) dir of a pupptyeer Python client checkout to import instead of the installed package |
| `BACKEND_URL` | (app/Vite) proxy target (default `http://127.0.0.1:4318`) |

Programmatic equivalents: TS `ClaudeHarness.create({ socketPath, readiness,
allowedRoots })` and `createSession({ cwd, command, model, permissionMode,
extraArgs, cols, rows })`; Python `ClaudeHarness.create(socket_path=...,
readiness=..., allowed_roots=...)` and `create_session(cwd=..., command=...,
model=..., permission_mode=..., extra_args=..., cols=..., rows=...)`.
