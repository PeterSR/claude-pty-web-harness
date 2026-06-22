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
- [Referencing the libs without a registry](#referencing-the-libs-without-a-registry)
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

- A running **pupptyeer** daemon (built at commit `e667d9b` or later, where
  capturing a live claude session no longer wedges it). Restart any long-running
  daemon so it loads that build.
- `claude` on `PATH`, logged in.
- Node 20+ for the TS side; Python 3.10+ (and ideally `uv`) for the Python side.

The harness auto-spawns a daemon if its socket is dead; point it at the binary
with `PUPPTYEER_BIN` (defaults to the sibling `../pupptyeer/bin/pupptyeer`).

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
  pupptyeerBin: "/path/to/pupptyeer", // optional; else env / PATH
  // socketPath, readiness: "screen" | "delay"
});

harness.on("chat", (sessionId: string, event: ChatEvent) => { /* ... */ });
harness.on("status", (sessionId: string, status: SessionStatus) => { /* ... */ });

const session = await harness.createSession({
  cwd: "/repo",
  model: "sonnet",          // optional
  // command, permissionMode, extraArgs, cols, rows
});

await harness.sendPrompt(session.id, "List the files here");
harness.interrupt(session.id);     // Ctrl-C the current turn
harness.list();                    // SessionSummary[]
harness.get(session.id);           // SessionSummary | undefined
harness.transcript(session.id);    // ChatEvent[] captured so far
await harness.kill(session.id);
```

### Use the reference HTTP/WS server

Mount the routes on your own Fastify app, or run the bundled server.

```ts
import Fastify from "fastify";
import { ClaudeHarness } from "@petersr/claude-pty-web-harness-core";
import { registerHarnessRoutes } from "@petersr/claude-pty-web-harness-server";

const harness = await ClaudeHarness.create({ pupptyeerBin });
const app = Fastify();
await registerHarnessRoutes(app, harness, { prefix: "/api" });
await app.listen({ port: 4318, host: "127.0.0.1" });
```

### Use the React hook (bring your own components)

```tsx
import { useHarnessSession, createHarnessClient } from "@petersr/claude-pty-web-harness-react";

// REST client (create/list/kill sessions). baseUrl "" = same-origin.
const client = createHarnessClient(""); // or "http://localhost:4318"
const { id } = await client.createSession("/repo", "sonnet");

// In a component: owns the WebSocket, returns the live transcript.
function Chat({ sessionId }: { sessionId: string }) {
  const { events, status, connected, sendPrompt, interrupt } =
    useHarnessSession(sessionId, { baseUrl: "" });
  // render `events` (ChatEvent[]) however you like
}
```

`ChatEvent` is a discriminated union on `kind`: `user`, `assistant_text`,
`thinking`, `tool_use`, `tool_result`, `result`.

## Python

The Python package mirrors core + server. The pupptyeer client is sync; the
harness is asyncio and runs the client's calls in a thread executor.

### Install

```bash
cd packages/python
uv venv && uv pip install -e .
# or: pip install -e packages/python
```

### Use the core

```python
import asyncio
from claude_pty_web_harness import ClaudeHarness

async def main():
    harness = await ClaudeHarness.create(
        pupptyeer_bin="/path/to/pupptyeer",   # optional; else env / PATH
        # socket_path=..., readiness="screen" | "delay",
    )

    # listener(kind, session_id, payload): kind is "chat" (ChatEvent dict)
    # or "status" (SessionStatus string)
    remove = harness.add_listener(lambda kind, sid, payload: print(kind, payload))

    session = await harness.create_session(
        cwd="/repo",
        model="sonnet",        # optional
        # command, permission_mode, extra_args, cols, rows
    )
    await harness.send_prompt(session["id"], "List the files here")
    harness.interrupt(session["id"])
    harness.list()                       # list[SessionSummary]
    harness.get(session["id"])           # SessionSummary | None
    harness.transcript(session["id"])    # list[ChatEvent]
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
(`lifespan` creates the harness; each route reads `app.state.harness`).

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

WebSocket `/api/sessions/:id/stream`:

- On connect the server sends a `status` message, then replays the transcript as
  `chat` messages, then streams live.
- Server -> client: `{ type: "status", status }` | `{ type: "chat", event }` | `{ type: "error", message }`
- Client -> server: `{ type: "prompt", text }` | `{ type: "interrupt" }`

`SessionSummary`: `{ id, ptyId, cwd, model, status, createdAt }`.
`status`: `"starting" | "ready" | "exited"`.

`ChatEvent` (discriminated by `kind`, all carry `id` and optional `ts`):

```
user           { kind:"user", text }
assistant_text { kind:"assistant_text", text }
thinking       { kind:"thinking", text }
tool_use       { kind:"tool_use", name, toolUseId, input }
tool_result    { kind:"tool_result", toolUseId, text, isError }
result         { kind:"result", subtype?, durationMs?, costUsd?, text? }
```

Chat is built from the JSONL Claude persists (we generate the `--session-id`);
the pty is used for input and for driving the startup modals.

## Referencing the libs without a registry

Neither side needs npm/PyPI. The pupptyeer client itself is referenced locally
the same way.

### JS (npm)

These are npm workspaces, so inside this repo they resolve to source. From
another project, use a `file:` dependency:

```jsonc
// consumer package.json
{
  "dependencies": {
    "@petersr/claude-pty-web-harness-core": "file:../claude-pty-web-harness/packages/core",
    "@petersr/claude-pty-web-harness-protocol": "file:../claude-pty-web-harness/packages/protocol"
  }
}
```

The TS packages ship source (no build step); a bundler (Vite, tsx, etc.)
transpiles them. The pupptyeer client is itself a `file:` dependency of `core`.

### Python

```toml
# consumer pyproject.toml (uv) - editable, live changes
[project]
dependencies = ["claude-pty-web-harness"]

[tool.uv.sources]
claude-pty-web-harness = { path = "../claude-pty-web-harness/packages/python", editable = true }
```

Other options: `pip install -e packages/python`; a PEP 508 file URL
(`"claude-pty-web-harness @ file:///abs/path/packages/python"`); a built wheel
(`uv build` then `pip install dist/*.whl`); or a git URL with
`#subdirectory=packages/python`.

Caveat: the Python package imports the pupptyeer client by path (it is not on
PyPI). Keep the repos side by side, or set
`PUPPTYEER_PY_CLIENT=/path/to/pupptyeer/clients/python`.

## Local-only hacks and workarounds

This project runs fully locally against unpublished pupptyeer and consumes its
own libs from source. The non-obvious bits, in one place:

### Repo layout assumption

Several defaults assume the repos sit side by side:

```
~/dev/personal/
  pupptyeer/          # pupptyeer (daemon + clients), not published
  claude-pty-web-harness/      # this repo
```

If yours differ, set `PUPPTYEER_BIN`, `PUPPTYEER_SOCK`, and `PUPPTYEER_PY_CLIENT`
(below) accordingly.

### pupptyeer is not on npm or PyPI

- **TS**: `@petersr/claude-pty-web-harness-core` depends on the client by path:
  `"@petersr/pupptyeer-client": "file:../../../pupptyeer/clients/typescript"`.
  npm symlinks it into `node_modules`.
- **Python**: the client is a single stdlib file with no packaging, so it can't
  be a normal dependency. `claude_pty_web_harness/_pupptyeer.py` inserts its dir onto
  `sys.path` and imports it. Default dir is the sibling repo; override with
  `PUPPTYEER_PY_CLIENT=/path/to/pupptyeer/clients/python`.

### pupptyeer binary is not on PATH

Both reference servers default `PUPPTYEER_BIN` to the sibling build
`../pupptyeer/bin/pupptyeer` (resolved relative to the server file). Set
`PUPPTYEER_BIN` if it lives elsewhere, or put `pupptyeer` on `PATH`. If the
daemon socket is dead, the harness spawns `<bin> daemon` for you.

### The untyped JS client needs an ambient .d.ts

The pupptyeer Node client ships as plain `.mjs` with no types. `core` carries a
hand-written `src/pupptyeer-client.d.ts` declaring the module so TypeScript is
happy. If the client's API changes, update that file.

### TS libs are consumed from source (no build step)

Each TS package's `main`/`exports` points at `src/*.ts`, not a compiled `dist`.
Inside the repo, npm workspaces resolve them; `tsx` (server) and Vite (app) run
the TS directly. The app additionally pins them via Vite `resolve.alias` and
tsconfig `paths` to the packages' `src/index.ts` so Vite treats them as source.
Consequence: there is no `npm run build` of the libs yet. To `npm publish` them
you'd add a per-package build (tsup/tsc).

### Port 4318, not 4317

The default backend port is 4318 because 4317 was taken by an unrelated local
service. Override with `PORT`. The Vite app proxies `/api` to `BACKEND_URL`
(default `http://127.0.0.1:4318`).

### Daemon must be restarted after a rebuild

A long-running daemon keeps its old code. After rebuilding pupptyeer, restart the
daemon or `captureScreen` returns an empty grid (readiness silently never fires;
chat still works via JSONL). If you cannot restart the shared default-socket
daemon, run a private one and point the server at it:

```bash
PUPPTYEER_SOCK=/tmp/cph/d.sock /path/to/pupptyeer daemon &
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

### Prompts are submitted as a single line

`sendPrompt` replaces newlines with spaces before typing, because Enter submits
in the TUI and a multi-line paste would submit early. Multi-line prompts are not
supported by the prototype.

### Optimistic echo in the React hook

`useHarnessSession` shows your prompt immediately as a local `user` event, then
de-dupes it by text when the real JSONL `user` entry arrives. Harmless, but it is
why a just-sent prompt can briefly exist twice in state.

## Configuration

Environment variables (read by both reference servers):

| Var | Meaning |
|---|---|
| `PORT` | server port (default 4318) |
| `HOST` | bind host (default 127.0.0.1) |
| `PUPPTYEER_BIN` | path to the pupptyeer binary (else the sibling build, else PATH) |
| `PUPPTYEER_SOCK` | daemon socket (else `$XDG_RUNTIME_DIR/pupptyeer/daemon.sock`) |
| `READINESS` | `screen` (default, daemon-rendered) or `delay` (no capture; fallback) |
| `PUPPTYEER_PY_CLIENT` | (Python) dir of the pupptyeer Python client |
| `BACKEND_URL` | (app/Vite) proxy target (default `http://127.0.0.1:4318`) |

Programmatic equivalents: TS `ClaudeHarness.create({ pupptyeerBin, socketPath,
readiness })` and `createSession({ cwd, command, model, permissionMode,
extraArgs, cols, rows })`; Python `ClaudeHarness.create(pupptyeer_bin=...,
socket_path=..., readiness=...)` and `create_session(cwd=..., command=...,
model=..., permission_mode=..., extra_args=..., cols=..., rows=...)`.
