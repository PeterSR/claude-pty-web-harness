// Public surface of @claude-pty-harness/core: the transport-agnostic logic.
// Wire it to any transport (the reference @claude-pty-harness/server, an
// Electron main process, SSE, raw IPC, ...) by listening to the harness
// "chat"/"status" events and calling its imperative methods.
export { ClaudeHarness, HARNESS_NAMESPACE } from "./harness.js";
export type { CreateSessionOptions, HarnessOptions } from "./harness.js";
// Connect-or-scream and socket resolution now live in the pupptyeer client;
// re-export them so consumers keep a coherent surface without a local mirror.
export { PupptyeerClient, defaultSocketPath } from "pupptyeer-client";
export { findJsonlPath, parseEntry, JsonlTailer } from "./jsonl.js";
export type {
  ChatEvent,
  SessionStatus,
  SessionSummary,
  ServerMessage,
  ClientMessage,
} from "@claude-pty-harness/protocol";
