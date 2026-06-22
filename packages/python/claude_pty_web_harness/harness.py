"""ClaudeHarness: the transport-agnostic core. Drives Claude Code inside a
pupptyeer pty and turns its JSONL transcript into a stream of ChatEvents.
Async (asyncio) port of harness.ts; the synchronous pupptyeer client's
request/reply calls run in a thread executor so they never block the loop."""
from __future__ import annotations

import asyncio
import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, List, Optional

# Bracketed-paste markers. Wrapping prompt text in these makes the TUI insert it
# literally (newlines and all) instead of submitting at the first newline, the
# same way a real terminal delivers a paste. A separate Enter then submits.
_PASTE_START = b"\x1b[200~"
_PASTE_END = b"\x1b[201~"


def _normalize_root(path: str) -> str:
    return os.path.abspath(os.path.expanduser(path))

from . import detect
from ._pupptyeer import PupptyeerClient, Screen
from .jsonl import JsonlTailer
from .protocol import ChatEvent, SessionStatus, SessionSummary

# The pupptyeer namespace all harness sessions live in. Isolates them from
# other apps sharing the global daemon (TS and Python share this app, so they
# share the namespace). See .agent-workspace/pupptyeer-namespaces-plan.md.
HARNESS_NAMESPACE = "claude-pty-web-harness"

# Listener(kind, session_id, payload): kind is "chat" (payload=ChatEvent) or
# "status" (payload=SessionStatus).
Listener = Callable[[str, str, Any], None]


@dataclass
class _Session:
    id: str
    pty_id: str
    cwd: str
    model: Optional[str]
    status: SessionStatus
    created_at: str
    events: List[ChatEvent] = field(default_factory=list)
    ready: bool = False
    tasks: List[asyncio.Task] = field(default_factory=list)


class ClaudeHarness:
    def __init__(
        self,
        client: PupptyeerClient,
        readiness: str = "screen",
        allowed_roots: Optional[List[str]] = None,
    ):
        self._client = client
        self._readiness = readiness
        # When non-empty, sessions may only be spawned inside one of these roots.
        # Empty means unrestricted (back-compat). Normalized once here.
        self._allowed_roots = [_normalize_root(r) for r in (allowed_roots or [])]
        self._sessions: dict[str, _Session] = {}
        self._listeners: List[Listener] = []

    @classmethod
    async def create(
        cls,
        *,
        socket_path: Optional[str] = None,
        readiness: str = "screen",
        allowed_roots: Optional[List[str]] = None,
    ) -> "ClaudeHarness":
        # Connect-or-scream is the client's job: it resolves the default socket,
        # never spawns, and raises one canonical error if the daemon is down.
        client = await asyncio.to_thread(
            PupptyeerClient.connect, socket_path, HARNESS_NAMESPACE
        )
        return cls(client, readiness=readiness, allowed_roots=allowed_roots)

    def _check_cwd(self, cwd: str) -> str:
        """Resolve cwd and, if an allowlist is configured, reject anything that
        escapes it. Returns the normalized path actually handed to claude."""
        resolved = _normalize_root(cwd)
        if not self._allowed_roots:
            return resolved
        for root in self._allowed_roots:
            if resolved == root or resolved.startswith(root + os.sep):
                return resolved
        raise PermissionError(f"cwd {resolved!r} is outside the allowed roots")

    # --- pub/sub ----------------------------------------------------------

    def add_listener(self, fn: Listener) -> Callable[[], None]:
        self._listeners.append(fn)

        def remove() -> None:
            try:
                self._listeners.remove(fn)
            except ValueError:
                pass

        return remove

    def _emit(self, kind: str, session_id: str, payload: Any) -> None:
        for fn in list(self._listeners):
            try:
                fn(kind, session_id, payload)
            except Exception:
                pass

    # --- queries ----------------------------------------------------------

    def list(self) -> List[SessionSummary]:
        return [self._summary(s) for s in self._sessions.values()]

    def get(self, session_id: str) -> Optional[SessionSummary]:
        s = self._sessions.get(session_id)
        return self._summary(s) if s else None

    def transcript(self, session_id: str) -> List[ChatEvent]:
        s = self._sessions.get(session_id)
        return s.events if s else []

    def _summary(self, s: _Session) -> SessionSummary:
        return {
            "id": s.id,
            "ptyId": s.pty_id,
            "cwd": s.cwd,
            "model": s.model,
            "status": s.status,
            "createdAt": s.created_at,
        }

    # --- lifecycle --------------------------------------------------------

    async def create_session(
        self,
        *,
        cwd: str,
        command: str = "claude",
        model: Optional[str] = None,
        permission_mode: str = "bypassPermissions",
        extra_args: Optional[List[str]] = None,
        cols: int = 120,
        rows: int = 40,
    ) -> SessionSummary:
        cwd = self._check_cwd(cwd)
        session_id = str(uuid.uuid4())
        args: List[str] = ["--session-id", session_id]
        if permission_mode:
            args += ["--permission-mode", permission_mode]
        if model:
            args += ["--model", model]
        if extra_args:
            args += list(extra_args)

        pty_id = await asyncio.to_thread(self._client.new_session, command, args, cwd, None, cols, rows)

        s = _Session(
            id=session_id,
            pty_id=pty_id,
            cwd=cwd,
            model=model,
            status="starting",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        self._sessions[session_id] = s

        tailer = JsonlTailer(session_id, on_event=lambda ev: self._on_chat(session_id, ev))
        s.tasks.append(asyncio.create_task(tailer.run()))
        s.tasks.append(asyncio.create_task(self._drive_startup(s)))
        return self._summary(s)

    def _on_chat(self, session_id: str, ev: ChatEvent) -> None:
        s = self._sessions.get(session_id)
        if not s:
            return
        s.events.append(ev)
        self._emit("chat", session_id, ev)

    # --- startup / readiness ---------------------------------------------

    async def _capture_screen(self, pty_id: str, settle_ms: int, timeout_ms: int) -> Optional[Screen]:
        """captureScreen with a hard timeout; returns the rendered screen (grid
        lines + cursor) or None so a misbehaving daemon can't wedge the startup
        driver."""
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(self._client.capture_screen, pty_id, settle_ms, timeout_ms),
                timeout=timeout_ms / 1000 + 2,
            )
        except Exception:
            return None

    async def _drive_startup(self, s: _Session) -> None:
        # "delay": don't capture (a fallback for daemons without working
        # capture). Give claude a moment to boot past its remembered modals.
        if self._readiness == "delay":
            await asyncio.sleep(3)
            if s.id in self._sessions:
                self._mark_ready(s)
            return

        loop = asyncio.get_event_loop()
        deadline = loop.time() + 30
        style_handled = False
        bypass_accepted = False
        trust_handled = False

        while loop.time() < deadline:
            if s.id not in self._sessions or s.ready:
                return
            screen = await self._capture_screen(s.pty_id, 300, 1500)
            if not screen or not screen.lines:
                await asyncio.sleep(0.2)
                continue
            lines = screen.lines
            text = "\n".join(lines).lower()

            # 0. First-run text-style picker. The highlighted theme row is a
            #    "<prompt>" selection (not the input prompt) that ready_for_input
            #    can't distinguish from real input, so accept the auto-detected
            #    default with Enter.
            if not style_handled and detect.has_style_picker(text):
                style_handled = True
                self._client.write_pane(s.pty_id, "\r")
                await asyncio.sleep(0.4)
                continue

            # 1. Bypass-permissions warning. Cursor defaults to "1. No, exit"; a
            #    bare Enter would quit claude. Move to "2. Yes, I accept" (Down)
            #    then confirm.
            if not bypass_accepted and detect.has_bypass_warning(text):
                bypass_accepted = True
                self._client.write_pane(s.pty_id, b"\x1b[B")  # Down
                await asyncio.sleep(0.25)
                self._client.write_pane(s.pty_id, "\r")
                await asyncio.sleep(0.4)
                continue

            # 2. "Do you trust the files in this folder?" modal (default = yes).
            if not trust_handled and detect.has_trust_modal(text):
                trust_handled = True
                self._client.write_pane(s.pty_id, "\r")
                await asyncio.sleep(0.4)
                continue

            # 3. Ready once claude parks its cursor on the "<prompt>" input row
            #    (primary signal), or the prompt/idle footer is on screen
            #    (text fallbacks).
            if detect.ready_for_input(screen) or detect.has_input_prompt(lines) or detect.is_ready_footer(text):
                self._mark_ready(s)
                return

            await asyncio.sleep(0.2)

    def _mark_ready(self, s: _Session) -> None:
        if s.ready:
            return
        s.ready = True
        s.status = "ready"
        self._emit("status", s.id, "ready")

    # --- input ------------------------------------------------------------

    async def send_prompt(self, session_id: str, text: str, submit: bool = True) -> None:
        """Deliver a prompt as a bracketed paste so multi-line text lands in the
        TUI input intact, then (by default) submit it with a single Enter. Pass
        submit=False to stage the text without sending."""
        s = self._sessions.get(session_id)
        if not s:
            raise KeyError(session_id)
        normalized = text.replace("\r\n", "\n").replace("\r", "\n")
        # Inside a paste the TUI treats CR as a literal newline, not a submit.
        paste = _PASTE_START + normalized.replace("\n", "\r").encode() + _PASTE_END
        self._client.write_pane(s.pty_id, paste)
        if submit:
            await asyncio.sleep(0.12)
            self._client.write_pane(s.pty_id, "\r")

    def interrupt(self, session_id: str) -> None:
        s = self._sessions.get(session_id)
        if not s:
            return
        self._client.write_pane(s.pty_id, b"\x03")  # Ctrl-C

    async def kill(self, session_id: str) -> None:
        s = self._sessions.pop(session_id, None)
        if not s:
            return
        for t in s.tasks:
            t.cancel()
        try:
            await asyncio.to_thread(self._client.kill, s.pty_id)
        except Exception:
            pass
        s.status = "exited"
        self._emit("status", session_id, "exited")
