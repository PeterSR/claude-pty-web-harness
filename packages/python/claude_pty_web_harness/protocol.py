"""The shared wire contract, mirroring @petersr/claude-pty-web-harness-protocol so the same
React frontend talks to this backend unchanged. ChatEvents and session
summaries travel as plain JSON dicts with these exact (camelCase) keys; the
TypedDicts below document the shapes. Kept as dicts at runtime to guarantee
byte-for-byte parity with the TS server."""
from __future__ import annotations

from typing import Any, List, Literal, TypedDict

SessionStatus = Literal["starting", "ready", "exited", "failed"]

# Machine-readable reason a session ended up "failed" (surfaced in
# SessionSummary["error"] and on the "status" wire message). "startup_timeout"
# is the catch-all when the input prompt never appeared and no known surface was
# recognized; the rest name a specific interactive block claude showed instead.
StartupFailure = Literal[
    "auth_blocked",
    "rate_limit",
    "workspace_trust_blocked",
    "tool_approval_blocked",
    "custom_api_key_detected",
    "startup_timeout",
]

# ChatEvent variants (discriminated by "kind"). All carry id and optional ts.
#   user           { id, ts?, kind:"user", text }
#   assistant_text { id, ts?, kind:"assistant_text", text }
#   thinking       { id, ts?, kind:"thinking", text }
#   tool_use       { id, ts?, kind:"tool_use", name, toolUseId, input }
#   tool_result    { id, ts?, kind:"tool_result", toolUseId, text, isError }
#   system         { id, ts?, kind:"system", subtype?, text? }
#   result         { id, ts?, kind:"result", subtype?, durationMs?, costUsd?, text? }
ChatEvent = dict[str, Any]


class SessionSummary(TypedDict, total=False):
    id: str
    ptyId: str
    cwd: str
    model: str | None
    status: SessionStatus
    # Reason when status is "failed" (a StartupFailure), else absent.
    error: str
    createdAt: str


# Server -> client:
#   { "type": "status", "status": SessionStatus, "error"?: str }
#   { "type": "chat", "event": ChatEvent }
#   { "type": "error", "message": str }
# Client -> server:
#   { "type": "prompt", "text": str }
#   { "type": "interrupt" }

__all__ = ["SessionStatus", "StartupFailure", "ChatEvent", "SessionSummary"]
