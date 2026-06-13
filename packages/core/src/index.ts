// Public surface of @claude-pty-harness/core: the transport-agnostic logic.
// Wire it to any transport (the reference @claude-pty-harness/server, an
// Electron main process, SSE, raw IPC, ...) by listening to the harness
// "chat"/"status" events and calling its imperative methods.
export { ClaudeHarness } from "./harness.js";
export type { CreateSessionOptions, HarnessOptions } from "./harness.js";
export { connectDaemon, resolveSocketPath } from "./daemon.js";
export type { DaemonOptions } from "./daemon.js";
export { findJsonlPath, parseEntry, JsonlTailer } from "./jsonl.js";
export type {
  ChatEvent,
  SessionStatus,
  SessionSummary,
  ServerMessage,
  ClientMessage,
} from "@claude-pty-harness/protocol";
