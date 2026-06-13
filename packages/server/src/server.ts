// Runnable reference server: builds a ClaudeHarness and serves it on HTTP/WS.
// This is the demo's transport; a real app would call registerHarnessRoutes on
// its own Fastify instance (see ./index.ts).
import path from "node:path";
import Fastify from "fastify";
import { ClaudeHarness } from "@claude-pty-harness/core";
import { registerHarnessRoutes } from "./index.js";

const PORT = Number(process.env.PORT ?? 4318);
const HOST = process.env.HOST ?? "127.0.0.1";

// pupptyeer isn't on PATH in this monorepo; default to the sibling build.
// In a real deployment set PUPPTYEER_BIN (or put pupptyeer on PATH).
const pupptyeerBin =
  process.env.PUPPTYEER_BIN ?? path.resolve(import.meta.dirname, "../../../../pty-supervisor/bin/pupptyeer");

// "screen" (default) uses pupptyeer 0.2.0 daemon rendering; "delay" avoids
// capture (set READINESS=delay if the daemon's capture wedges claude).
const readiness = process.env.READINESS === "delay" ? "delay" : "screen";

const harness = await ClaudeHarness.create({ pupptyeerBin, readiness });

const app = Fastify({ logger: false });
await registerHarnessRoutes(app, harness);

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`[server] listening on http://${HOST}:${PORT}`);
});
