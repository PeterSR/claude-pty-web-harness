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
  ContentPart,
  SessionStatus,
  SessionSummary,
  ServerMessage,
  ClientMessage,
} from "@petersr/claude-pty-web-harness-protocol";
```

- `ChatEvent` is a discriminated union on `kind`: `user`, `assistant_text`,
  `thinking`, `tool_use`, `tool_result`, `system`, `result`. The `user`,
  `assistant_text`, and `tool_result` variants carry an optional `parts`: a
  `ContentPart[]`, the lossless ordered breakdown of that message/tool
  result's content blocks (text, image, or an `unknown` block this library
  doesn't recognize). It's additive - `text` stays exactly as it always was, a
  flattened text-only summary - and only present when there's something beyond
  plain text to say.
- `ContentPart` is a discriminated union on `type`: `text` (`{text}`), `image`
  (`{blobId, mediaType, bytes}` - fetch the bytes from the server's blob
  route), and `unknown` (`{blockType}`, so an unrecognized content-block type
  surfaces visibly instead of silently vanishing).
- `SessionStatus` is `"starting" | "ready" | "exited" | "failed"`; a `"failed"`
  session carries a `StartupFailure` reason in `SessionSummary.error`.
- `ServerMessage` / `ClientMessage` are the WebSocket frames in each direction.

See the [project README](https://github.com/PeterSR/claude-pty-web-harness#readme),
the [wire protocol](https://github.com/PeterSR/claude-pty-web-harness/blob/main/PROTOCOL.md),
and [USAGE.md](https://github.com/PeterSR/claude-pty-web-harness/blob/main/USAGE.md)
for the full picture.

## License

MIT
