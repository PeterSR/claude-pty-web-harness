"""claude_pty_harness: Python backend parity for claude-pty-harness.

Drive Claude Code in a pupptyeer pty and stream its JSONL transcript over the
same HTTP/WS protocol as the TS server. The reusable core is ClaudeHarness;
server.py is the reference FastAPI adapter.
"""
from .harness import ClaudeHarness
from .daemon import connect_daemon, resolve_socket_path, DaemonOptions
from .jsonl import find_jsonl_path, parse_entry, JsonlTailer

__all__ = [
    "ClaudeHarness",
    "connect_daemon",
    "resolve_socket_path",
    "DaemonOptions",
    "find_jsonl_path",
    "parse_entry",
    "JsonlTailer",
]
