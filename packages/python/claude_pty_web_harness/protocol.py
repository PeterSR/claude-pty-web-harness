"""The shared wire contract, mirroring @petersr/claude-pty-web-harness-protocol so the same
React frontend talks to this backend unchanged. ChatEvents and session
summaries travel as plain JSON dicts with these exact (camelCase) keys; the
TypedDicts below document the shapes. Kept as dicts at runtime to guarantee
byte-for-byte parity with the TS server."""
from __future__ import annotations

from typing import Any, List, Literal, TypedDict, Union

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
# "user", "assistant_text", and "tool_result" additionally carry an optional
# "parts" (a ContentPart list): the lossless, ordered breakdown of a
# message/tool_result's content blocks. Additive alongside "text" (which stays
# exactly as it always was, a flattened text-only summary joining only the
# text parts) so old consumers reading "text" see no change; "parts" is only
# present when the content had something beyond plain text.
#   user           { id, ts?, kind:"user", text, parts? }
#   assistant_text { id, ts?, kind:"assistant_text", text, parts? }
#   thinking       { id, ts?, kind:"thinking", text }
#   tool_use       { id, ts?, kind:"tool_use", name, toolUseId, input }
#   tool_result    { id, ts?, kind:"tool_result", toolUseId, text, isError, parts? }
#   system         { id, ts?, kind:"system", subtype?, text? }
#   result         { id, ts?, kind:"result", subtype?, durationMs?, costUsd?, text? }
ChatEvent = dict[str, Any]


# ContentPart variants (discriminated by "type"), documenting the shape of the
# dicts inside ChatEvent["parts"]. "unknown" exists so a content-block type
# this library doesn't recognize (e.g. a future Anthropic block type) surfaces
# visibly instead of silently vanishing the way it used to. Kept as TypedDicts
# purely for documentation/type-checking; ChatEvent itself stays a plain dict
# at runtime, same as everywhere else in this file.
class TextPart(TypedDict):
    type: Literal["text"]
    text: str


class ImagePart(TypedDict):
    type: Literal["image"]
    blobId: str
    mediaType: str
    bytes: int


class UnknownPart(TypedDict):
    type: Literal["unknown"]
    blockType: str


ContentPart = Union[TextPart, ImagePart, UnknownPart]


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

__all__ = [
    "SessionStatus",
    "StartupFailure",
    "ChatEvent",
    "ContentPart",
    "TextPart",
    "ImagePart",
    "UnknownPart",
    "SessionSummary",
]
