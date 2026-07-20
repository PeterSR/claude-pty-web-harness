// Public surface of @petersr/claude-pty-web-harness-core: the transport-agnostic logic.
// Wire it to any transport (the reference @petersr/claude-pty-web-harness-server, an
// Electron main process, SSE, raw IPC, ...) by listening to the harness
// "chat"/"status" events and calling its imperative methods.
export { ClaudeHarness, HARNESS_NAMESPACE, CwdNotAllowedError } from "./harness.js";
export type { CreateSessionOptions, HarnessOptions, ImageBlob } from "./harness.js";
// Connect-or-scream and socket resolution now live in the pupptyeer client;
// re-export them so consumers keep a coherent surface without a local mirror.
export { PupptyeerClient, defaultSocketPath } from "pupptyeer-client";
export { findJsonlPath, parseEntry, JsonlTailer } from "./jsonl.js";
export type { ImageSink } from "./jsonl.js";
export { hashImageBytes } from "./blob.js";
export type {
  ChatEvent,
  ContentPart,
  SessionStatus,
  SessionSummary,
  ServerMessage,
  ClientMessage,
} from "@petersr/claude-pty-web-harness-protocol";
