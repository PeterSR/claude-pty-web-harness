// Runnable reference server: builds a ClaudeHarness and serves it on HTTP/WS.
// This is the demo's transport; a real app would call registerHarnessRoutes on
// its own Fastify instance (see ./index.ts).
import Fastify from "fastify";
import { ClaudeHarness } from "@petersr/claude-pty-web-harness-core";
import { registerHarnessRoutes } from "./index.js";

const PORT = Number(process.env.PORT ?? 4318);
const HOST = process.env.HOST ?? "127.0.0.1";

// "screen" (default) uses the daemon's rendered grid; "delay" avoids capture
// (set READINESS=delay if the daemon's capture wedges claude).
const readiness = process.env.READINESS === "delay" ? "delay" : "screen";

// Connects to the global pupptyeer daemon (camp A): the client resolves the
// default socket and fails loud if it is unreachable. Set PUPPTYEER_SOCK to
// point at a non-default socket.
const harness = await ClaudeHarness.create({ readiness });

const app = Fastify({ logger: false });
await registerHarnessRoutes(app, harness);

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`[server] listening on http://${HOST}:${PORT}`);
});
