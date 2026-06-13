# claude-pty-harness

Drive the interactive **Claude Code** TUI inside a pseudo-terminal and stream its
transcript into a chat UI. It launches `claude` via
[pupptyeer](https://github.com/PeterSR/pupptyeer), tails the JSONL transcript Claude persists, and
renders it as chat while the input box drives the same pty.

```
 browser (React chat)  ──HTTP/WS──>  server  ──in-process──>  core (ClaudeHarness)  ──unix socket──>  pupptyeer  ──pty──>  claude
        ▲                                                          │
        └──────────────── chat events ◀── tail ~/.claude/projects/**/<session>.jsonl
```

Two streams, one session:

- **Input**: the chat box writes keystrokes into the pty (prompt + Enter).
- **Output**: the structured chat is built by tailing the JSONL Claude persists
  per session. We generate the `--session-id` UUID, so we know which file to
  tail. Raw pty bytes are used only to detect and dismiss the startup modals.

## Packages

The logic is split so it drops into a project with a completely different UI.
The reuse surface is `protocol` + `core` (backend) and `protocol` + `react`
(frontend). `server` and `app` are the reference wiring.

| Package | What it is | Depends on |
|---|---|---|
| `@claude-pty-harness/protocol` | Wire types (`ChatEvent`, `Server/ClientMessage`, ...). Zero runtime. | none |
| `@claude-pty-harness/core` | `ClaudeHarness`: transport-agnostic logic (pupptyeer + JSONL + VT modal handling). | pupptyeer, @xterm/headless |
| `@claude-pty-harness/server` | Reference Fastify/WS adapter (`registerHarnessRoutes`) + runnable entry. | core |
| `@claude-pty-harness/react` | Headless `useHarnessSession` hook + `createHarnessClient`. No UI. | protocol, react |
| `@claude-pty-harness/app` | The reference chat UI (POC), built on the libs. | react |

## Prerequisites

- Node 20+ (22 recommended)
- `claude` on `PATH` (logged in)
- The pupptyeer daemon binary. The reference server defaults to
  `../pupptyeer/bin/pupptyeer`; override with `PUPPTYEER_BIN` (or put
  `pupptyeer` on `PATH`). The daemon is auto-spawned if its socket is dead.

The pupptyeer Node client is the `pupptyeer-client` npm package (a dependency of
`core`). The daemon binary is still resolved from the sibling checkout by default
(see `PUPPTYEER_BIN` above); a prebuilt binary is also published as the
`@petersr/pupptyeer` npm package.

## Run

```bash
npm install
npm run dev:server     # @claude-pty-harness/server on :4318
npm run dev:app        # @claude-pty-harness/app on :4316 (proxies /api + ws to :4318)
```

Open http://localhost:4316, set a working directory, click **New session**, chat.
Sessions launch with `--permission-mode bypassPermissions` by default.

## Reusing the libs in another project

**Backend** (any transport, not just Fastify):

```ts
import { ClaudeHarness } from "@claude-pty-harness/core";

const harness = await ClaudeHarness.create({
  pupptyeerBin: "/path/to/pupptyeer",
  allowedRoots: ["/home/me/dev"], // optional: reject createSession outside these
});
harness.on("chat", (sessionId, event) => send(sessionId, event));   // event: ChatEvent
harness.on("status", (sessionId, status) => send(sessionId, status));

const { id } = await harness.createSession({ cwd, model: "sonnet" });
await harness.sendPrompt(id, "first line\nsecond line"); // multi-line, sent as one paste
// also: harness.list(), harness.transcript(id), harness.interrupt(id), harness.kill(id)
```

`createSession` also takes `command`, `permissionMode`, and `extraArgs` if you
want to drive something other than `claude --permission-mode bypassPermissions`.
`sendPrompt` delivers the text as a bracketed paste so multi-line input lands in
the TUI intact, then submits with one Enter (pass `{ submit: false }` to stage
without sending).

To embed the reference HTTP/WS API on your own Fastify app:
`registerHarnessRoutes(app, harness, { prefix: "/api" })`. It accepts auth hooks
so you can put it behind your app's auth — `authenticate(req)` guards the REST
routes (401 on false) and `authenticateWs(req)` guards the WebSocket upgrade
(browsers can't send an `Authorization` header on a WS, so validate a
short-lived ticket / query token there). `/health` stays open.

**Frontend** (bring your own components):

```tsx
import { useHarnessSession } from "@claude-pty-harness/react";

const { events, status, sendPrompt, interrupt } = useHarnessSession(sessionId, {
  baseUrl: "http://localhost:4318", // omit for same-origin
});
// render `events` (typed by @claude-pty-harness/protocol) however you want
```

A non-React or non-JS UI can skip `react` entirely and speak the
`@claude-pty-harness/protocol` JSON over the same WebSocket.

## How the startup modals are handled

A real pty is a TTY, so `claude` shows interactive startup modals:

1. **Bypass Permissions warning**: cursor defaults to "1. No, exit" (a bare
   Enter would quit). The harness selects "2. Yes, I accept" (Down, Enter).
2. **Trust this folder**: confirmed with Enter.

The TUI paints with cursor-column escapes (e.g. `ESC[12G`), not spaces, so
stripping ANSI concatenates words. Instead the harness reads the **rendered
grid** (lines with real spacing) and matches against it. `core/src/detect.ts`
holds the predicates; `core/src/harness.ts` drives the keystrokes.

The grid comes from the pupptyeer 0.2.0 daemon via `captureScreen` (rendering is
done in the daemon, the Go analogue of `charmbracelet/x/vt`; we used to do this
in-process with `@xterm/headless`). Readiness mode is configurable:

- `readiness: "screen"` (default): read the daemon's rendered grid and drive the
  startup modals.
- `readiness: "delay"` (set `READINESS=delay` on the server): never capture; mark
  ready after a short delay and rely on claude's remembered trust/permission
  config. A fallback for daemons without working capture.

> Requires a pupptyeer daemon built at commit `e667d9b` or later (the fix for an
> earlier 0.2.0 bug where capturing a live `claude` session wedged it). If your
> daemon has been running since before that, restart it so it loads the new
> binary; otherwise `captureScreen` returns an empty grid and readiness never
> fires (chat still works via JSONL). `npm run dev:server` auto-spawns a daemon
> only if the socket is dead.

## API (server)

- `POST   /api/sessions` `{ cwd, model? }` → session summary
- `GET    /api/sessions` → list
- `DELETE /api/sessions/:id` → kill
- `POST   /api/sessions/:id/prompt` `{ text }` → type a prompt
- `WS     /api/sessions/:id/stream` → replays transcript + status, then streams
  `{type:"chat",event}` / `{type:"status",status}`; accepts
  `{type:"prompt",text}` / `{type:"interrupt"}`.
