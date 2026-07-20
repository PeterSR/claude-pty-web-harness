"""Locate, tail, and parse the JSONL transcript Claude Code persists at
~/.claude/projects/**/<session-id>.jsonl, turning each line into ChatEvents.
Mirrors jsonl.ts."""
from __future__ import annotations

import asyncio
import base64
import json
import os
from typing import Any, Callable, List, Optional, Tuple

from .protocol import ChatEvent

# Called once per image content block encountered while parsing, so the
# caller (the harness's per-session blob store) can decode the base64,
# compute its content hash, stash the bytes, and hand back the blobId to
# embed in the resulting part: on_image(base64_data, media_type) -> blob_id.
# This keeps parse_entry itself pure: it never decodes, hashes, or stores
# anything, and it never puts raw base64 into a ChatEvent. Without a sink
# there is nowhere for the bytes to go, so an image block degrades to an
# "unknown" part instead of inventing a placeholder id or leaking the
# payload. Mirrors ImageSink in jsonl.ts.
ImageSink = Callable[[str, str], str]


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


def _base64_decoded_length(data: str) -> int:
    """Decoded byte length of a base64 string, without raising on malformed
    input (falls back to 0 rather than propagating a decode error, matching
    the "fall back, don't throw" rule for malformed image blocks)."""
    try:
        return len(base64.b64decode(data, validate=False))
    except Exception:
        return 0


def _block_to_part(block: dict, on_image: Optional[ImageSink]) -> dict:
    """One non-text content block -> a ContentPart dict. `blockType` for an
    "unknown" part is the block's own `type` (or "unknown" if it didn't have
    one), so a caller/renderer can at least say what kind of block got
    dropped. Mirrors blockToPart in jsonl.ts."""
    block_type = block.get("type") if isinstance(block.get("type"), str) else "unknown"
    if block_type == "image":
        # Claude Code image blocks look like
        # {"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}.
        # Anything short of that (missing source/data/media_type) falls
        # through to the "unknown" return below rather than raising.
        source = block.get("source")
        data = source.get("data") if isinstance(source, dict) else None
        media_type = source.get("media_type") if isinstance(source, dict) else None
        if isinstance(data, str) and isinstance(media_type, str) and on_image is not None:
            return {
                "type": "image",
                "blobId": on_image(data, media_type),
                "mediaType": media_type,
                "bytes": _base64_decoded_length(data),
            }
    return {"type": "unknown", "blockType": block_type}


def _content_parts(content: Any, on_image: Optional[ImageSink]) -> Tuple[str, Optional[list]]:
    """Parse an Anthropic `content` field (a plain string, or a list of
    content blocks) into the flattened legacy text (joining only the `text`
    blocks, so this matches byte-for-byte what the old text-only parsing
    produced) plus, only when a block beyond plain text is present, the full
    ordered part list. Returns (text, None) rather than (text, all-text-parts)
    so pure-text output stays identical to before this fix (no new key
    appears). Mirrors parseContent in jsonl.ts."""
    if isinstance(content, str):
        return content, None
    if not isinstance(content, list):
        return "", None

    text_chunks: List[str] = []
    parts: List[dict] = []
    has_non_text = False

    for raw in content:
        if not isinstance(raw, dict):
            continue
        if raw.get("type") == "text":
            t = str(raw.get("text") or "")
            text_chunks.append(t)
            parts.append({"type": "text", "text": t})
        else:
            has_non_text = True
            parts.append(_block_to_part(raw, on_image))

    text = "".join(text_chunks)
    return (text, parts) if has_non_text else (text, None)


def parse_entry(entry: dict, line_no: int, on_image: Optional[ImageSink] = None) -> List[ChatEvent]:
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
                    text, parts = _content_parts(block.get("content"), on_image)
                    ev = {
                        "id": f"{base_id}:tr:{n}", "ts": ts, "kind": "tool_result",
                        "toolUseId": block.get("tool_use_id") or "",
                        "text": text,
                        "isError": bool(block.get("is_error")),
                    }
                    if parts is not None:
                        ev["parts"] = parts
                    out.append(ev)
                    n += 1
                elif block.get("type") == "text" or isinstance(block.get("text"), str):
                    out.append({"id": f"{base_id}:u:{n}", "ts": ts, "kind": "user", "text": str(block.get("text") or "")})
                    n += 1
                else:
                    # A non-text, non-tool_result block (e.g. a user-pasted
                    # image) used to match neither branch above and vanish
                    # with no trace.
                    out.append({
                        "id": f"{base_id}:x:{n}", "ts": ts, "kind": "user", "text": "",
                        "parts": [_block_to_part(block, on_image)],
                    })
                    n += 1
        else:
            text, _ = _content_parts(content, on_image)
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
            else:
                # Unrecognized block type (e.g. redacted_thinking) used to
                # fall through with no branch and vanish; surface it instead.
                out.append({
                    "id": f"{base_id}:x:{n}", "ts": ts, "kind": "assistant_text", "text": "",
                    "parts": [_block_to_part(block, on_image)],
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

    def __init__(
        self,
        session_id: str,
        on_event: Callable[[ChatEvent], None],
        interval: float = 0.2,
        on_image: Optional[ImageSink] = None,
    ):
        self.session_id = session_id
        self.on_event = on_event
        self.interval = interval
        self.on_image = on_image

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
                        for ev in parse_entry(entry, line_no, self.on_image):
                            self.on_event(ev)
            except asyncio.CancelledError:
                raise
            except Exception:
                # file vanished or transient error; rediscover
                path = None
            await asyncio.sleep(self.interval)
