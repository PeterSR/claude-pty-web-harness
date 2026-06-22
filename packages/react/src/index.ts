// @petersr/claude-pty-web-harness-react: headless client + hook. Bring your own UI; render
// the `events` array (typed by @petersr/claude-pty-web-harness-protocol) however you want.
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
} from "@petersr/claude-pty-web-harness-protocol";
