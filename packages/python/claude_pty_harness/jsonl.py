"""Locate, tail, and parse the JSONL transcript Claude Code persists at
~/.claude/projects/**/<session-id>.jsonl, turning each line into ChatEvents.
Mirrors jsonl.ts."""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Callable, List, Optional

from .protocol import ChatEvent


def find_jsonl_path(session_id: str) -> Optional[str]:
    """Newest ~/.claude/projects/*/<session_id>.jsonl, or None. Claude encodes
    the cwd into the project dir name, so we match by suffix across all dirs."""
    if not session_id:
        return None
    root = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    target = f"{session_id}.jsonl"
    best: Optional[str] = None
    best_mtime = -1.0
    try:
        dirs = os.listdir(root)
    except OSError:
        return None
    for d in dirs:
        full = os.path.join(root, d, target)
        try:
            mtime = os.stat(full).st_mtime
        except OSError:
            continue
        if mtime > best_mtime:
            best, best_mtime = full, mtime
    return best


def _as_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for b in content:
            if isinstance(b, dict) and "text" in b:
                out.append(str(b.get("text") or ""))
        return "".join(out)
    return ""


def parse_entry(entry: dict, line_no: int) -> List[ChatEvent]:
    """One parsed JSONL line -> zero or more ChatEvents (wire dicts)."""
    base_id = entry.get("uuid") or f"line-{line_no}"
    ts = entry.get("timestamp")
    out: List[ChatEvent] = []
    etype = entry.get("type")
    msg = entry.get("message") or {}

    if etype == "user":
        content = msg.get("content")
        if isinstance(content, list):
            n = 0
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_result":
                    out.append({
                        "id": f"{base_id}:tr:{n}", "ts": ts, "kind": "tool_result",
                        "toolUseId": block.get("tool_use_id") or "",
                        "text": _as_text(block.get("content")),
                        "isError": bool(block.get("is_error")),
                    })
                    n += 1
                elif block.get("type") == "text" or isinstance(block.get("text"), str):
                    out.append({"id": f"{base_id}:u:{n}", "ts": ts, "kind": "user", "text": str(block.get("text") or "")})
                    n += 1
        else:
            text = _as_text(content)
            if text.strip():
                out.append({"id": base_id, "ts": ts, "kind": "user", "text": text})

    elif etype == "assistant":
        content = msg.get("content")
        blocks = content if isinstance(content, list) else []
        n = 0
        for block in blocks:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text":
                if str(block.get("text") or "").strip():
                    out.append({"id": f"{base_id}:a:{n}", "ts": ts, "kind": "assistant_text", "text": str(block.get("text"))})
                    n += 1
            elif btype == "thinking":
                out.append({"id": f"{base_id}:t:{n}", "ts": ts, "kind": "thinking", "text": str(block.get("thinking") or block.get("text") or "")})
                n += 1
            elif btype == "tool_use":
                out.append({
                    "id": f"{base_id}:tu:{n}", "ts": ts, "kind": "tool_use",
                    "name": str(block.get("name") or "tool"),
                    "toolUseId": str(block.get("id") or ""),
                    "input": block.get("input"),
                })
                n += 1

    elif etype == "system":
        # turn_duration is claude's reliable end-of-turn marker; surface it as a
        # "turn complete" chip. Other system lines are noise.
        if entry.get("subtype") == "turn_duration":
            out.append({"id": base_id, "ts": ts, "kind": "result", "subtype": "turn_duration", "durationMs": entry.get("duration_ms")})

    elif etype == "result":
        out.append({
            "id": base_id, "ts": ts, "kind": "result", "subtype": entry.get("subtype"),
            "durationMs": entry.get("duration_ms"), "costUsd": entry.get("total_cost_usd"),
            "text": entry.get("result"),
        })

    return out


def _read_range(path: str, start: int, end: int) -> bytes:
    with open(path, "rb") as f:
        f.seek(start)
        return f.read(end - start)


class JsonlTailer:
    """Async task that tails a session's JSONL file and calls on_event for each
    parsed ChatEvent. Waits for the file to appear (claude creates it after the
    first turn). Polling-based for robustness."""

    def __init__(self, session_id: str, on_event: Callable[[ChatEvent], None], interval: float = 0.2):
        self.session_id = session_id
        self.on_event = on_event
        self.interval = interval

    async def run(self) -> None:
        offset = 0
        partial = b""
        line_no = 0
        path: Optional[str] = None
        while True:
            try:
                if path is None:
                    path = await asyncio.to_thread(find_jsonl_path, self.session_id)
                    if path is None:
                        await asyncio.sleep(self.interval)
                        continue
                size = await asyncio.to_thread(os.path.getsize, path)
                if size > offset:
                    chunk = await asyncio.to_thread(_read_range, path, offset, size)
                    offset = size
                    partial += chunk
                    while b"\n" in partial:
                        raw, partial = partial.split(b"\n", 1)
                        if not raw.strip():
                            continue
                        line_no += 1
                        try:
                            entry = json.loads(raw.decode("utf-8", "replace"))
                        except json.JSONDecodeError:
                            continue
                        for ev in parse_entry(entry, line_no):
                            self.on_event(ev)
            except asyncio.CancelledError:
                raise
            except Exception:
                # file vanished or transient error; rediscover
                path = None
            await asyncio.sleep(self.interval)
