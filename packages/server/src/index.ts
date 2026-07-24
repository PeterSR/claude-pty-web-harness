// @petersr/claude-pty-web-harness-server: a reference adapter. registerHarnessRoutes mounts
// the harness REST + WebSocket endpoints onto any Fastify instance, so you can
// embed it in an existing app instead of running the bundled server.
import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ClaudeHarness } from "@petersr/claude-pty-web-harness-core";
import type { ChatEvent, ClientMessage, ServerMessage, SessionStatus } from "@petersr/claude-pty-web-harness-protocol";

// Minimal structural type for the ws socket (@fastify/websocket passes a `ws`
// WebSocket); avoids depending on @types/ws.
interface WebSocket {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "message", cb: (data: Buffer) => void): void;
  on(event: "close", cb: () => void): void;
}

export interface HarnessRouteOptions {
  /** Path prefix for the routes. Default "/api". */
  prefix?: string;
  /**
   * Guard for the REST routes (everything except /health). Return false to
   * reject with 401. Runs as a Fastify preHandler, so you can also throw your
   * own reply. Omit for no auth (default).
   */
  authenticate?: (req: FastifyRequest) => boolean | Promise<boolean>;
  /**
   * Guard for the WebSocket upgrade. Browsers can't set an Authorization header
   * on a WebSocket, so validate a short-lived ticket / query token here. Return
   * false to reject the connection. Omit for no auth (default).
   */
  authenticateWs?: (req: FastifyRequest) => boolean | Promise<boolean>;
  /**
   * Guard for the blob route (`GET {prefix}/sessions/:id/blobs/:blobId`),
   * used *instead of* `authenticate` for that one route - not in addition to
   * it. Same reason as `authenticateWs`: a browser `<img src>` can't send an
   * Authorization header either, so header-based `authenticate` guards this
   * route in name only and every image renders broken under it. If you set
   * `authenticate` to anything header-based, you MUST also set
   * `authenticateBlob` or images will 401.
   *
   * Recommended: a path-scoped `HttpOnly`, `SameSite=Strict` cookie minted at
   * session start and scoped to the blob route, so the browser attaches it to
   * `<img src>` automatically and nothing sensitive ever enters a URL. A
   * query-string ticket token is the other common option, but it leaks
   * through access logs, browser history, and the `Referer` header on
   * outbound links; a short expiry narrows that window without closing those
   * channels, and if you go this route the ticket should be scoped to a
   * single blobId rather than being a general pass to the whole blob route.
   * This library does not pick the mechanism for you - auth lives at the
   * edge, and the harness stays transport-agnostic - so there is no bundled
   * ticket or cookie helper; implement whichever fits your deployment.
   * Omit to keep the current REST guarding (`authenticate`, or none) on this
   * route, which is correct for the no-auth default and for cookie-based
   * auth that Fastify's normal request handling already sees.
   */
  authenticateBlob?: (req: FastifyRequest) => boolean | Promise<boolean>;
}

/**
 * Wire a ClaudeHarness onto a Fastify app:
 *   GET    {prefix}/health
 *   GET    {prefix}/sessions
 *   POST   {prefix}/sessions                   { cwd, model? }
 *   GET    {prefix}/sessions/:id
 *   DELETE {prefix}/sessions/:id
 *   POST   {prefix}/sessions/:id/prompt        { text }
 *   GET    {prefix}/sessions/:id/blobs/:blobId
 *   WS     {prefix}/sessions/:id/stream
 */
// Only a lowercase hex SHA-256 digest is ever a real blobId (see
// ClaudeHarness's blob store); reject anything else before it ever reaches
// harness.blob(), since this content comes from MCP tool output and is not
// fully trusted.
const BLOB_ID_RE = /^[a-f0-9]{64}$/;
// Anything outside this allowlist is served as application/octet-stream
// rather than trusting the mediaType a tool reported, so a browser is never
// handed a Content-Type it might sniff into executing.
const BLOB_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function registerHarnessRoutes(
  app: FastifyInstance,
  harness: ClaudeHarness,
  opts: HarnessRouteOptions = {},
): Promise<void> {
  const prefix = opts.prefix ?? "/api";
  await app.register(websocket);

  // REST guard as a preHandler; only attached when an authenticator is given so
  // the unauthenticated default path stays untouched. /health is left open.
  const restGuard = opts.authenticate
    ? async (req: FastifyRequest, reply: FastifyReply) => {
        if (!(await opts.authenticate!(req))) {
          reply.code(401);
          return reply.send({ error: "unauthorized" });
        }
      }
    : undefined;
  const guarded = restGuard ? { preHandler: restGuard } : {};

  // The blob route needs its own guard, same reasoning as the WS upgrade:
  // when set, it replaces the REST guard for this one route (not layered
  // on top of it) because a browser <img src> can't carry the REST guard's
  // Authorization header either. No authenticateBlob -> keep whatever REST
  // guarding is already in effect (none, or `authenticate`), unchanged.
  const blobGuard = opts.authenticateBlob
    ? {
        preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
          if (!(await opts.authenticateBlob!(req))) {
            reply.code(401);
            return reply.send({ error: "unauthorized" });
          }
        },
      }
    : guarded;

  // Per-session set of connected WebSocket clients.
  const subscribers = new Map<string, Set<WebSocket>>();

  const broadcast = (sessionId: string, msg: ServerMessage) => {
    const set = subscribers.get(sessionId);
    if (!set) return;
    const data = JSON.stringify(msg);
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  };

  harness.on("chat", (sessionId: string, event: ChatEvent) => broadcast(sessionId, { type: "chat", event }));
  harness.on("status", (sessionId: string, status: SessionStatus, error?: string) =>
    broadcast(sessionId, { type: "status", status, ...(error ? { error } : {}) }),
  );

  app.get(`${prefix}/health`, async () => ({ ok: true }));

  app.get(`${prefix}/sessions`, guarded, async () => harness.list());

  app.post(`${prefix}/sessions`, guarded, async (req, reply) => {
    const body = (req.body ?? {}) as { cwd?: string; model?: string };
    const cwd = body.cwd?.trim();
    if (!cwd) {
      reply.code(400);
      return { error: "cwd is required" };
    }
    try {
      return await harness.createSession({ cwd, model: body.model });
    } catch (err) {
      req.log.error(err);
      // A cwd outside allowedRoots is a client error (403); anything else is 500.
      reply.code((err as { code?: string }).code === "cwd_not_allowed" ? 403 : 500);
      return { error: String((err as Error).message ?? err) };
    }
  });

  app.get(`${prefix}/sessions/:id`, guarded, async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = harness.get(id);
    if (!session) {
      reply.code(404);
      return { error: "not found" };
    }
    return session;
  });

  app.delete(`${prefix}/sessions/:id`, guarded, async (req) => {
    const { id } = req.params as { id: string };
    // Graceful shutdown, not a bare kill: let claude quit through its own TUI
    // path (confirming the "Exit anyway" modal) so any background work it armed
    // is torn down rather than orphaned, falling back to a hard kill() if that
    // wedges. Bounded, but slower than kill() in the worst case (see PROTOCOL.md).
    await harness.shutdown(id);
    // Drop the subscriber set so closed sessions don't leave empty sets behind.
    subscribers.delete(id);
    return { ok: true };
  });

  app.post(`${prefix}/sessions/:id/prompt`, guarded, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { text?: string };
    if (!body.text) {
      reply.code(400);
      return { error: "text is required" };
    }
    try {
      await harness.sendPrompt(id, body.text);
      return { ok: true };
    } catch (err) {
      // A picker on screen is a client-observable conflict (409); everything
      // else (an unknown/gone session id) keeps the prior 404.
      reply.code((err as { code?: string }).code === "picker_open" ? 409 : 404);
      return { error: String((err as Error).message ?? err) };
    }
  });

  app.get(`${prefix}/sessions/:id/blobs/:blobId`, blobGuard, async (req, reply) => {
    const { id, blobId } = req.params as { id: string; blobId: string };
    // Unknown session and unknown blob (and a malformed blobId) all 404 with
    // the same body, so a caller can't use the response to probe which of the
    // two didn't exist.
    if (!BLOB_ID_RE.test(blobId)) {
      reply.code(404);
      return { error: "not found" };
    }
    const found = harness.blob(id, blobId);
    if (!found) {
      reply.code(404);
      return { error: "not found" };
    }
    const contentType = BLOB_CONTENT_TYPES.has(found.mediaType) ? found.mediaType : "application/octet-stream";
    reply
      .header("content-type", contentType)
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", "inline")
      // Content-addressed and immutable: the blobId is a hash of the bytes,
      // so this response can never go stale.
      .header("cache-control", "public, max-age=31536000, immutable");
    return reply.send(found.bytes);
  });

  app.get(`${prefix}/sessions/:id/stream`, { websocket: true }, async (socket: WebSocket, req) => {
    if (opts.authenticateWs && !(await opts.authenticateWs(req))) {
      socket.send(JSON.stringify({ type: "error", message: "unauthorized" } satisfies ServerMessage));
      socket.close();
      return;
    }
    const { id } = req.params as { id: string };
    const session = harness.get(id);
    if (!session) {
      socket.send(JSON.stringify({ type: "error", message: "unknown session" } satisfies ServerMessage));
      socket.close();
      return;
    }

    let set = subscribers.get(id);
    if (!set) {
      set = new Set();
      subscribers.set(id, set);
    }
    set.add(socket);

    // Replay status + transcript so a fresh/reconnecting client catches up.
    socket.send(
      JSON.stringify({
        type: "status",
        status: session.status,
        ...(session.error ? { error: session.error } : {}),
      } satisfies ServerMessage),
    );
    for (const event of harness.transcript(id)) {
      socket.send(JSON.stringify({ type: "chat", event } satisfies ServerMessage));
    }

    socket.on("message", (raw: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "prompt") {
        if (typeof msg.text !== "string") {
          socket.send(
            JSON.stringify({ type: "error", message: "prompt text must be a string" } satisfies ServerMessage),
          );
          return;
        }
        // Surface every send failure to the socket rather than swallowing it:
        // an open picker (PickerOpenError) is the case this guard exists for,
        // but a session that vanished mid-flight deserves the same treatment
        // rather than the caller believing its message was sent.
        harness.sendPrompt(id, msg.text).catch((err: unknown) => {
          if (socket.readyState !== socket.OPEN) return;
          socket.send(
            JSON.stringify({
              type: "error",
              message: String((err as Error).message ?? err),
            } satisfies ServerMessage),
          );
        });
      } else if (msg.type === "interrupt") {
        harness.interrupt(id);
      }
    });

    socket.on("close", () => {
      set?.delete(socket);
      // Drop the set once its last socket closes so empty sets don't accumulate.
      if (set && set.size === 0 && subscribers.get(id) === set) subscribers.delete(id);
    });
  });
}
