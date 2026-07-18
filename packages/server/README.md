# @petersr/claude-pty-web-harness-server

A reference Fastify + WebSocket adapter for the
[claude-pty-web-harness](https://github.com/PeterSR/claude-pty-web-harness).
`registerHarnessRoutes` mounts the harness REST + WebSocket endpoints onto any
Fastify instance, so you can embed it in an existing app, or run the bundled
server as-is. It speaks the same HTTP/WS protocol as the Python backend, so any
frontend works against either.

## Install

```sh
npm i @petersr/claude-pty-web-harness-server
```

Requires Node >= 20, plus the prerequisites of
[`@petersr/claude-pty-web-harness-core`](https://www.npmjs.com/package/@petersr/claude-pty-web-harness-core)
(a running pupptyeer daemon and `claude` on `PATH`).

## Usage

Mount the routes on your own Fastify app:

```ts
import Fastify from "fastify";
import { ClaudeHarness } from "@petersr/claude-pty-web-harness-core";
import { registerHarnessRoutes } from "@petersr/claude-pty-web-harness-server";

const harness = await ClaudeHarness.create();
const app = Fastify();
await registerHarnessRoutes(app, harness, { prefix: "/api" });
await app.listen({ port: 4318, host: "127.0.0.1" });
```

`registerHarnessRoutes` accepts `authenticate(req)` and `authenticateWs(req)`
hooks so you can put it behind your app's auth; `/health` stays open. Or run the
bundled entry directly:

```sh
npx @petersr/claude-pty-web-harness-server   # listens on :4318
```

See the [project README](https://github.com/PeterSR/claude-pty-web-harness#readme),
the [wire protocol](https://github.com/PeterSR/claude-pty-web-harness/blob/main/PROTOCOL.md),
and [USAGE.md](https://github.com/PeterSR/claude-pty-web-harness/blob/main/USAGE.md).

## License

MIT
