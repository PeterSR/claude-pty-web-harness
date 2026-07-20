// @petersr/claude-pty-web-harness-protocol: the shared wire contract between the core/server
// and any client (the React hook, or a completely different UI). Types only,
// zero runtime, so every consumer agrees on one ChatEvent/Server/Client shape.

/**
 * One block of content within a ChatEvent's `parts` array: the lossless,
 * ordered breakdown of a message/tool_result's content blocks. Additive
 * alongside `text` (which stays exactly as it always was: a flattened summary
 * joining the text of every block that carries a string `text` field,
 * regardless of that block's `type` - the same rule the pre-fix parsing
 * always used) so old consumers reading `text` see no change. `unknown`
 * exists so a content-block type this library doesn't recognize (e.g. a
 * future Anthropic block type) surfaces visibly instead of silently vanishing
 * the way it used to; its optional `text` carries that block's own text (if
 * it had any) so a parts-reading renderer and a text-only one never disagree
 * about whether the block said something.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; blobId: string; mediaType: string; bytes: number }
  | { type: "unknown"; blockType: string; text?: string };

/** A single rendered item in the chat transcript, derived from Claude's JSONL. */
export type ChatEvent =
  | { id: string; ts?: string; kind: "user"; text: string; parts?: ContentPart[] }
  | { id: string; ts?: string; kind: "assistant_text"; text: string; parts?: ContentPart[] }
  | { id: string; ts?: string; kind: "thinking"; text: string }
  | { id: string; ts?: string; kind: "tool_use"; name: string; toolUseId: string; input: unknown }
  | { id: string; ts?: string; kind: "tool_result"; toolUseId: string; text: string; isError: boolean; parts?: ContentPart[] }
  | { id: string; ts?: string; kind: "system"; subtype?: string; text?: string }
  | { id: string; ts?: string; kind: "result"; subtype?: string; durationMs?: number; costUsd?: number; text?: string };

/**
 * Session lifecycle:
 *  - "starting": launched, driving past the startup modals.
 *  - "ready": input prompt is live and accepting prompts.
 *  - "exited": the claude process is gone (killed or ended).
 *  - "failed": startup never reached the input prompt. `SessionSummary.error`
 *    carries a short machine reason (see StartupFailure below).
 */
export type SessionStatus = "starting" | "ready" | "exited" | "failed";

/**
 * Machine-readable reason a session ended up "failed", surfaced in
 * `SessionSummary.error` and on the "status" wire message. "startup_timeout" is
 * the catch-all when the input prompt never appeared and no known surface was
 * recognized; the rest name a specific interactive block claude showed instead.
 */
export type StartupFailure =
  | "auth_blocked"
  | "rate_limit"
  | "workspace_trust_blocked"
  | "tool_approval_blocked"
  | "custom_api_key_detected"
  | "startup_timeout";

export interface SessionSummary {
  /** Claude's own session id (the --session-id we generated; names the JSONL file). */
  id: string;
  /** pupptyeer's pty session id. */
  ptyId: string;
  cwd: string;
  model?: string;
  status: SessionStatus;
  /** Reason when status is "failed" (a StartupFailure), else absent. */
  error?: string;
  createdAt: string;
}

/** Messages sent server -> client over the WebSocket. */
export type ServerMessage =
  | { type: "status"; status: SessionStatus; error?: string }
  | { type: "chat"; event: ChatEvent }
  | { type: "error"; message: string };

/** Messages sent client -> server over the WebSocket. */
export type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "interrupt" };
