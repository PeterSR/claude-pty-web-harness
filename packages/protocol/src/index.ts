// @claude-pty-harness/protocol: the shared wire contract between the core/server
// and any client (the React hook, or a completely different UI). Types only,
// zero runtime, so every consumer agrees on one ChatEvent/Server/Client shape.

/** A single rendered item in the chat transcript, derived from Claude's JSONL. */
export type ChatEvent =
  | { id: string; ts?: string; kind: "user"; text: string }
  | { id: string; ts?: string; kind: "assistant_text"; text: string }
  | { id: string; ts?: string; kind: "thinking"; text: string }
  | { id: string; ts?: string; kind: "tool_use"; name: string; toolUseId: string; input: unknown }
  | { id: string; ts?: string; kind: "tool_result"; toolUseId: string; text: string; isError: boolean }
  | { id: string; ts?: string; kind: "system"; subtype?: string; text?: string }
  | { id: string; ts?: string; kind: "result"; subtype?: string; durationMs?: number; costUsd?: number; text?: string };

export type SessionStatus = "starting" | "ready" | "exited";

export interface SessionSummary {
  /** Claude's own session id (the --session-id we generated; names the JSONL file). */
  id: string;
  /** pupptyeer's pty session id. */
  ptyId: string;
  cwd: string;
  model?: string;
  status: SessionStatus;
  createdAt: string;
}

/** Messages sent server -> client over the WebSocket. */
export type ServerMessage =
  | { type: "status"; status: SessionStatus }
  | { type: "chat"; event: ChatEvent }
  | { type: "error"; message: string };

/** Messages sent client -> server over the WebSocket. */
export type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "interrupt" };
