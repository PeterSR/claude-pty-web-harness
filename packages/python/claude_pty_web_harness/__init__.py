"""claude_pty_web_harness: Python backend parity for claude-pty-web-harness.

Drive Claude Code in a pupptyeer pty and stream its JSONL transcript over the
same HTTP/WS protocol as the TS server. The reusable core is ClaudeHarness;
server.py is the reference FastAPI adapter.
"""
from .harness import ClaudeHarness, HARNESS_NAMESPACE, PickerOpenError
from .jsonl import find_jsonl_path, parse_entry, JsonlTailer
# Connect-or-scream and socket resolution now live in the pupptyeer client;
# re-export them so consumers keep a coherent surface without a local mirror.
from ._pupptyeer import PupptyeerClient
from pupptyeer_client import default_socket_path

__all__ = [
    "ClaudeHarness",
    "HARNESS_NAMESPACE",
    "PickerOpenError",
    "PupptyeerClient",
    "default_socket_path",
    "find_jsonl_path",
    "parse_entry",
    "JsonlTailer",
]
