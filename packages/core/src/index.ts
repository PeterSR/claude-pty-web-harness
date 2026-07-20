// Public surface of @petersr/claude-pty-web-harness-core: the transport-agnostic logic.
// Wire it to any transport (the reference @petersr/claude-pty-web-harness-server, an
// Electron main process, SSE, raw IPC, ...) by listening to the harness
// "chat"/"status" events and calling its imperative methods.
export { ClaudeHarness, HARNESS_NAMESPACE, CwdNotAllowedError, PickerOpenError } from "./harness.js";
export type { CreateSessionOptions, HarnessOptions, ImageBlob } from "./harness.js";
// Connect-or-scream and socket resolution now live in the pupptyeer client;
// re-export them so consumers keep a coherent surface without a local mirror.
export { PupptyeerClient, defaultSocketPath } from "pupptyeer-client";
export { findJsonlPath, parseEntry, JsonlTailer } from "./jsonl.js";
export type { ImageSink } from "./jsonl.js";
export { hashImageBytes } from "./blob.js";
// Screen predicates. Exported because a consumer that drives pickers itself
// needs the same answer the harness's own guard uses, and the alternative is a
// local reimplementation that drifts from this one: cad-web had ported the
// cursor-ownership logic by hand before this export existed, which is exactly
// the duplicate worth removing. pickerOwnsInput is pinned against real
// captured screens (conformance/picker-screens), so a caller gets the version
// the corpus tests, not a copy of it. readyForInput and hasInputPrompt come
// along because pickerOwnsInput is defined in terms of them, and a consumer
// reasoning about who owns the keyboard needs to ask the same three questions.
export { pickerOwnsInput, readyForInput, hasInputPrompt } from "./detect.js";
export type {
  ChatEvent,
  ContentPart,
  SessionStatus,
  SessionSummary,
  ServerMessage,
  ClientMessage,
} from "@petersr/claude-pty-web-harness-protocol";
