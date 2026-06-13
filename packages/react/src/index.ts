// @claude-pty-harness/react: headless client + hook. Bring your own UI; render
// the `events` array (typed by @claude-pty-harness/protocol) however you want.
export { useHarnessSession } from "./useHarnessSession";
export type { HarnessSession, UseHarnessSessionOptions } from "./useHarnessSession";
export { createHarnessClient } from "./api";
export type { HarnessClient } from "./api";
export type {
  ChatEvent,
  SessionStatus,
  SessionSummary,
  ServerMessage,
  ClientMessage,
} from "@claude-pty-harness/protocol";
