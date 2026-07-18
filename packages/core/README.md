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

Also: `harness.list()`, `harness.get(id)`, `harness.transcript(id)`,
`harness.interrupt(id)`, `harness.kill(id)`.

See the [project README](https://github.com/PeterSR/claude-pty-web-harness#readme)
and [USAGE.md](https://github.com/PeterSR/claude-pty-web-harness/blob/main/USAGE.md)
for the full API and the permission-mode notes.

## License

MIT
