# @petersr/claude-pty-web-harness-protocol

The shared wire contract for the
[claude-pty-web-harness](https://github.com/PeterSR/claude-pty-web-harness):
TypeScript types only, zero runtime. Every consumer (the core/server backend,
the React hook, or a completely different UI) imports these so they agree on one
`ChatEvent` / `SessionSummary` / `ServerMessage` / `ClientMessage` shape.

## Install

```sh
npm i @petersr/claude-pty-web-harness-protocol
```

Requires Node >= 20. Types-only, so it adds nothing to your runtime bundle.

## Usage

```ts
import type {
  ChatEvent,
  SessionStatus,
  SessionSummary,
  ServerMessage,
  ClientMessage,
} from "@petersr/claude-pty-web-harness-protocol";
```

- `ChatEvent` is a discriminated union on `kind`: `user`, `assistant_text`,
  `thinking`, `tool_use`, `tool_result`, `system`, `result`.
- `SessionStatus` is `"starting" | "ready" | "exited" | "failed"`; a `"failed"`
  session carries a `StartupFailure` reason in `SessionSummary.error`.
- `ServerMessage` / `ClientMessage` are the WebSocket frames in each direction.

See the [project README](https://github.com/PeterSR/claude-pty-web-harness#readme),
the [wire protocol](https://github.com/PeterSR/claude-pty-web-harness/blob/main/PROTOCOL.md),
and [USAGE.md](https://github.com/PeterSR/claude-pty-web-harness/blob/main/USAGE.md)
for the full picture.

## License

MIT
