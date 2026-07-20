# @petersr/claude-pty-web-harness-react

A headless React hook and REST client for a
[claude-pty-web-harness](https://github.com/PeterSR/claude-pty-web-harness)
server. No UI and no styling: `useHarnessSession` owns the WebSocket, tracks the
live transcript and status, and exposes `sendPrompt` / `interrupt`. Render the
returned `events` however you like.

## Install

```sh
npm i @petersr/claude-pty-web-harness-react
```

Requires Node >= 20 to build and React >= 18 at runtime (a peer dependency). It
talks to a running harness server (the reference
[server](https://www.npmjs.com/package/@petersr/claude-pty-web-harness-server) or
the Python backend).

## Usage

```tsx
import { useHarnessSession, createHarnessClient } from "@petersr/claude-pty-web-harness-react";

// REST client (create/list/kill sessions). baseUrl "" = same-origin.
const client = createHarnessClient(""); // or "http://localhost:4318"
const { id } = await client.createSession("/repo", "sonnet");

function Chat({ sessionId }: { sessionId: string }) {
  const { events, status, error, connected, sendPrompt, interrupt, blobUrl } =
    useHarnessSession(sessionId, { baseUrl: "" });
  // status "failed" -> `error` holds the reason (e.g. "auth_blocked")
  // render `events` (ChatEvent[]) however you like; an event's optional
  // `parts` may include an `image` part - render it as <img src={blobUrl(part.blobId)} />
}
```

Types come from
[`@petersr/claude-pty-web-harness-protocol`](https://www.npmjs.com/package/@petersr/claude-pty-web-harness-protocol).
A non-React UI can skip this package and speak the protocol JSON over the same
WebSocket.

See the [project README](https://github.com/PeterSR/claude-pty-web-harness#readme)
and [USAGE.md](https://github.com/PeterSR/claude-pty-web-harness/blob/main/USAGE.md).

## License

MIT
