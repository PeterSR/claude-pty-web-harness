# claude-pty-web-harness

[![CI](https://github.com/PeterSR/claude-pty-web-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/PeterSR/claude-pty-web-harness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Drive the interactive **Claude Code** TUI inside a pseudo-terminal and stream its
transcript into a chat UI. It launches `claude` via
[pupptyeer](https://github.com/PeterSR/pupptyeer), tails the JSONL transcript Claude persists, and
renders it as chat while the input box drives the same pty.

> Status: **v0, first public release.** Backends in TypeScript and Python speak
> one HTTP/WS protocol; the libraries publish to npm (`@petersr/`) and PyPI. See
> [USAGE.md](USAGE.md) for the full API, [PROTOCOL.md](PROTOCOL.md) for the wire
> spec, and [PUBLISHING.md](PUBLISHING.md) for the release process.

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
| `@petersr/claude-pty-web-harness-protocol` | Wire types (`ChatEvent`, `Server/ClientMessage`, ...). Zero runtime. | none |
| `@petersr/claude-pty-web-harness-core` | `ClaudeHarness`: transport-agnostic logic (pupptyeer + JSONL + VT modal handling). | pupptyeer-client |
| `@petersr/claude-pty-web-harness-server` | Reference Fastify/WS adapter (`registerHarnessRoutes`) + runnable entry. | core, protocol |
| `@petersr/claude-pty-web-harness-react` | Headless `useHarnessSession` hook + `createHarnessClient`. No UI. | protocol, react |
| `@petersr/claude-pty-web-harness-app` | The reference chat UI (POC), built on the libs. | react |

## Prerequisites

- Node 20+ (22 recommended)
- `claude` on `PATH` (logged in)
- A running **pupptyeer** daemon. The binary ships as the `@petersr/pupptyeer`
  npm package; install and start it once:

  ```bash
  npm i -g @petersr/pupptyeer
  pupptyeer daemon install   # supervises a user daemon at the default socket
  ```

  The harness connects to that daemon and fails loud if it is unreachable; it
  never spawns one. Point at a non-default socket with `PUPPTYEER_SOCK`.

The pupptyeer Node client is the `pupptyeer-client` npm package (a dependency of
`core`); it is pulled in automatically.

## Run

```bash
npm install
npm run dev:server     # @petersr/claude-pty-web-harness-server on :4318
npm run dev:app        # @petersr/claude-pty-web-harness-app on :4316 (proxies /api + ws to :4318)
```

Open http://localhost:4316, set a working directory, click **New session**, chat.

## Permission modes

> [!WARNING]
> Sessions launch with `--permission-mode bypassPermissions` by default. That
> approves **every** tool call with no checks, so the agent can run arbitrary
> commands and edit any file inside the session's `cwd` without prompting. Only
> point it at directories you trust, and contain it with `allowedRoots` (reject
> a `cwd` outside an allowlist) plus the server auth hooks. The default favors
> low friction; it is not a safe default for untrusted input.

Because the harness drives the real `claude` TUI in a pty, it can use claude's
**interactive auto mode**, where a classifier vets each action and auto-approves
the safe ones while still prompting/denying the risky ones. This is the best
overall balance for a web-driven agent, and (unlike headless `claude -p`) it
works here precisely because we own the pty. Select it per session:

```ts
await harness.createSession({ cwd, permissionMode: "auto" }); // classifier-gated
```

`permissionMode` is passed straight through to `claude --permission-mode <value>`,
so any of `default`, `plan`, `acceptEdits`, `auto`, or `bypassPermissions` works
(use `extraArgs` for anything else). Auto mode needs a recent claude CLI and an
eligible model; if it is unavailable claude falls back, so verify it engaged.

## Reusing the libs in another project

**Backend** (any transport, not just Fastify):

```ts
import { ClaudeHarness } from "@petersr/claude-pty-web-harness-core";

const harness = await ClaudeHarness.create({
  // socketPath and readiness are optional; the daemon socket defaults to
  // $PUPPTYEER_SOCK / $XDG_RUNTIME_DIR/pupptyeer/daemon.sock.
  allowedRoots: ["/home/me/dev"], // optional: reject createSession outside these
});
harness.on("chat", (sessionId, event) => send(sessionId, event));   // event: ChatEvent
harness.on("status", (sessionId, status) => send(sessionId, status));

const { id } = await harness.createSession({ cwd, model: "sonnet" });
await harness.sendPrompt(id, "first line\nsecond line"); // multi-line, sent as one paste
// also: harness.list(), harness.transcript(id), harness.interrupt(id), harness.kill(id)
```

`createSession` also takes `command`, `permissionMode` (see [Permission
modes](#permission-modes)), and `extraArgs` if you want to drive something other
than the default `claude --permission-mode bypassPermissions`.
`sendPrompt` delivers the text as a bracketed paste so multi-line input lands in
the TUI intact, then submits with one Enter (pass `{ submit: false }` to stage
without sending).

To embed the reference HTTP/WS API on your own Fastify app:
`registerHarnessRoutes(app, harness, { prefix: "/api" })`. It accepts auth hooks
so you can put it behind your app's auth: `authenticate(req)` guards the REST
routes (401 on false) and `authenticateWs(req)` guards the WebSocket upgrade
(browsers can't send an `Authorization` header on a WS, so validate a
short-lived ticket / query token there). `/health` stays open.

**Frontend** (bring your own components):

```tsx
import { useHarnessSession } from "@petersr/claude-pty-web-harness-react";

const { events, status, sendPrompt, interrupt } = useHarnessSession(sessionId, {
  baseUrl: "http://localhost:4318", // omit for same-origin
});
// render `events` (typed by @petersr/claude-pty-web-harness-protocol) however you want
```

A non-React or non-JS UI can skip `react` entirely and speak the
`@petersr/claude-pty-web-harness-protocol` JSON over the same WebSocket.

## How the startup modals are handled

A real pty is a TTY, so `claude` shows interactive startup modals:

1. **Bypass Permissions warning**: cursor defaults to "1. No, exit" (a bare
   Enter would quit). The harness selects "2. Yes, I accept" (Down, Enter).
2. **Trust this folder**: confirmed with Enter.

The TUI paints with cursor-column escapes (e.g. `ESC[12G`), not spaces, so
stripping ANSI concatenates words. Instead the harness reads the **rendered
grid** (lines with real spacing) and matches against it. `core/src/detect.ts`
holds the predicates; `core/src/harness.ts` drives the keystrokes.

The grid comes from the pupptyeer daemon via `captureScreen` (rendering is done
in the daemon, the Go analogue of `charmbracelet/x/vt`). Readiness mode is
configurable:

- `readiness: "screen"` (default): read the daemon's rendered grid and drive the
  startup modals.
- `readiness: "delay"` (set `READINESS=delay` on the server): never capture; mark
  ready after a short delay and rely on claude's remembered trust/permission
  config. A fallback for daemons without working capture.

> A long-running daemon keeps its old code, so after upgrading pupptyeer restart
> the daemon (`pupptyeer daemon restart`); otherwise `captureScreen` can return
> an empty grid and readiness never fires (chat still works via JSONL). Set
> `READINESS=delay` to skip capture entirely.

## API (server)

- `POST   /api/sessions` `{ cwd, model? }` → session summary
- `GET    /api/sessions` → list
- `DELETE /api/sessions/:id` → kill
- `POST   /api/sessions/:id/prompt` `{ text }` → type a prompt
- `GET    /api/sessions/:id/blobs/:blobId` → raw bytes for an `image` `ContentPart`
- `WS     /api/sessions/:id/stream` → replays transcript + status, then streams
  `{type:"chat",event}` / `{type:"status",status,error?}`; accepts
  `{type:"prompt",text}` / `{type:"interrupt"}`.

Session `status` is `starting → ready`, or `failed` if startup never reaches the
input prompt. A `failed` status carries a machine reason in `error`
(`auth_blocked`, `rate_limit`, `workspace_trust_blocked`, `tool_approval_blocked`,
`custom_api_key_detected`, or `startup_timeout`), so a wedged session (an auth
wall, a usage limit, an unaccepted trust modal) surfaces *why* instead of hanging
in `starting`.

## Security

The reference servers (TS and Python) are development tools with **no
authentication**. They bind `127.0.0.1` by default, and sessions default to
`permissionMode "bypassPermissions"`, so a spawned `claude` runs without tool
approval prompts in any `cwd` a client requests. Never expose them beyond
localhost as-is. Before any wider exposure, set `authenticate` / `authenticateWs`
and `allowedRoots` (Python: `authenticate_ws` / `allowed_roots`) and consider a
stricter permission mode.

## Related projects

Both siblings are MIT-licensed FOSS and already published:

- [pupptyeer](https://github.com/PeterSR/pupptyeer): the local PTY
  session-manager daemon this harness drives. Prebuilt daemon + CLI via
  `npm i -g @petersr/pupptyeer` (or GitHub Releases); client libraries ship as
  `pupptyeer-client` on npm and PyPI.
- [claude-p](https://github.com/PeterSR/claude-p): a Go drop-in for `claude -p`
  built on the interactive TUI, published as a Go module
  ([pkg.go.dev](https://pkg.go.dev/github.com/PeterSR/claude-p)). The startup
  readiness and failure-classification logic here is a port of its interactive
  driver.

## License

[MIT](LICENSE). © Peter Severin Rasmussen.
