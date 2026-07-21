# @petersr/claude-pty-web-harness-core

The transport-agnostic core of the
[claude-pty-web-harness](https://github.com/PeterSR/claude-pty-web-harness).
`ClaudeHarness` drives the interactive Claude Code TUI inside a
[pupptyeer](https://github.com/PeterSR/pupptyeer) pty, tails the JSONL transcript
Claude persists, and turns it into a stream of typed `ChatEvent`s. No HTTP, no
UI: wire it to any transport (see the reference
[server](https://www.npmjs.com/package/@petersr/claude-pty-web-harness-server)).

## Install

```sh
npm i @petersr/claude-pty-web-harness-core
```

Requires Node >= 20, `claude` on `PATH` (logged in), and a running **pupptyeer**
daemon (`npm i -g @petersr/pupptyeer && pupptyeer daemon install`). The
`pupptyeer-client` dependency is pulled in automatically; the harness connects to
the daemon and fails loud if it is unreachable (it never spawns one).

## Usage

```ts
import { ClaudeHarness } from "@petersr/claude-pty-web-harness-core";
import type { ChatEvent, SessionStatus } from "@petersr/claude-pty-web-harness-protocol";

const harness = await ClaudeHarness.create({
  // all optional: socketPath, readiness: "screen" | "delay", allowedRoots
});

harness.on("chat", (sessionId: string, event: ChatEvent) => { /* render */ });
harness.on("status", (sessionId: string, status: SessionStatus, error?: string) => {
  // status "failed" carries a StartupFailure reason in `error`
  // (auth_blocked, rate_limit, workspace_trust_blocked, tool_approval_blocked,
  //  custom_api_key_detected, startup_timeout)
});

const session = await harness.createSession({ cwd: "/repo", model: "sonnet" });
await harness.sendPrompt(session.id, "first line\nsecond line"); // multi-line, one paste
```

`createSession` also takes `command`, `permissionMode`, `extraArgs`, `env`
(merged over the daemon's own environment for the spawned process), `cols`,
and `rows`; see USAGE.md for the full option list and why `env` is there.

Also: `harness.list()`, `harness.get(id)`, `harness.transcript(id)`,
`harness.interrupt(id)`, `harness.kill(id)`, and `harness.blob(sessionId,
blobId)` (bytes + mediaType for an `image` `ContentPart`, or `undefined` -
back the `GET /:id/blobs/:blobId` route with it; never inline the bytes into a
`ChatEvent`).

`sendPrompt` captures the screen once before writing anything (in
`readiness: "screen"` mode only) and throws `PickerOpenError` (`code:
"picker_open"`, exported from this package) if a numbered picker - an
`AskUserQuestion` prompt, a tool-permission prompt, and the trust modal all
render identically, so it cannot say which one - is open: the trailing Enter
that submits a prompt would otherwise confirm whichever option is highlighted.
It fails open on a capture timeout, and it still leaves a narrow race between
the capture and the Enter, so treat it as reducing collisions, not eliminating
them. A caller that already knows what is on screen can pass `{ force: true }`
to skip the check; it is not available over the reference HTTP/WS server.

See the [project README](https://github.com/PeterSR/claude-pty-web-harness#readme)
and [USAGE.md](https://github.com/PeterSR/claude-pty-web-harness/blob/main/USAGE.md)
for the full API and the permission-mode notes.

## License

MIT
