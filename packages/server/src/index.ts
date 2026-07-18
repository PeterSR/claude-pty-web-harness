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
}

/**
 * Wire a ClaudeHarness onto a Fastify app:
 *   GET    {prefix}/health
 *   GET    {prefix}/sessions
 *   POST   {prefix}/sessions            { cwd, model? }
 *   GET    {prefix}/sessions/:id
 *   DELETE {prefix}/sessions/:id
 *   POST   {prefix}/sessions/:id/prompt { text }
 *   WS     {prefix}/sessions/:id/stream
 */
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
    await harness.kill(id);
    // Drop the subscriber set so killed sessions don't leave empty sets behind.
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
      reply.code(404);
      return { error: String((err as Error).message ?? err) };
    }
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
        harness.sendPrompt(id, msg.text).catch(() => {});
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
