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
from typing import Any, Callable, Dict, List, Optional, Tuple

# Bracketed-paste markers. Wrapping prompt text in these makes the TUI insert it
# literally (newlines and all) instead of submitting at the first newline, the
# same way a real terminal delivers a paste. A separate Enter then submits.
_PASTE_START = b"\x1b[200~"
_PASTE_END = b"\x1b[201~"

# send_prompt's picker-guard capture: a short settle/timeout, not
# _drive_startup's (300/1500), since this only ever needs to catch a picker
# that is already sitting still on screen - see send_prompt's docstring for
# the argument.
_PICKER_CHECK_SETTLE_MS = 150
_PICKER_CHECK_TIMEOUT_MS = 1000

# How often the exit watcher polls list_sessions() to catch a tracked session
# whose pty died on its own (a crash, an /exit, an OOM, a daemon restart)
# without ever passing through kill(). A few hundred ms of latency to notice
# a death doesn't matter for a status a UI renders, and this call covers
# every tracked session at once, not one call per session. Mirrors
# EXIT_WATCH_INTERVAL_MS in harness.ts (same name, same value in
# milliseconds - divided by 1000 at the asyncio.sleep call site below).
EXIT_WATCH_INTERVAL_MS = 2000

# Graceful-shutdown grace windows. shutdown() sends two Ctrl-C's (the TUI's
# quit gesture); _SHUTDOWN_CLEAN_EXIT_MS is how long to wait for claude to exit
# on its own when it has no background work to tear down, and
# _SHUTDOWN_CONFIRM_EXIT_MS is how long to wait after confirming the "Exit
# anyway" modal when it does. If either elapses, shutdown() falls back to the
# hard kill(). Mirrors SHUTDOWN_CLEAN_EXIT_MS/SHUTDOWN_CONFIRM_EXIT_MS in
# harness.ts (same values in milliseconds).
_SHUTDOWN_CLEAN_EXIT_MS = 1000
_SHUTDOWN_CONFIRM_EXIT_MS = 3000

# How often _wait_exit() re-checks list_sessions() while waiting out a graceful
# quit. Clamped to the remaining budget at each step so a wait never overshoots
# it. Mirrors WAIT_EXIT_POLL_MS in harness.ts (same value in milliseconds).
_WAIT_EXIT_POLL_MS = 100


def _normalize_root(path: str) -> str:
    return os.path.abspath(os.path.expanduser(path))

from . import detect
from ._pupptyeer import PupptyeerClient, Screen
from .blob import decode_image
from .jsonl import JsonlTailer
from .protocol import ChatEvent, SessionStatus, SessionSummary

# The pupptyeer namespace all harness sessions live in. Isolates them from
# other apps sharing the global daemon (TS and Python share this app, so they
# share the namespace). See .agent-workspace/pupptyeer-namespaces-plan.md.
HARNESS_NAMESPACE = "claude-pty-web-harness"


class PickerOpenError(Exception):
    """Raised by send_prompt when a picker owns the input
    (detect.picker_owns_input) and force was not set: writing the trailing
    Enter would confirm whichever option is highlighted instead of submitting
    the prompt. Carries a stable `code` class attribute so a transport can map
    it to a 409 without depending on the message or an isinstance check across
    module bounds. _check_cwd raises the builtin PermissionError instead of a
    custom class because a fitting builtin existed there; no builtin fits
    here, so a dedicated class is used."""

    code = "picker_open"

# Listener(kind, session_id, payload): kind is "chat" (payload=ChatEvent) or
# "status" (payload=SessionStatus).
Listener = Callable[[str, str, Any], None]


@dataclass
class _Blob:
    """One stored image blob: decoded bytes (never base64) plus its media
    type."""
    data: bytes
    media_type: str


@dataclass
class _Session:
    id: str
    pty_id: str
    cwd: str
    model: Optional[str]
    status: SessionStatus
    created_at: str
    error: Optional[str] = None  # failure reason when status is "failed"
    events: List[ChatEvent] = field(default_factory=list)
    ready: bool = False
    tasks: List[asyncio.Task] = field(default_factory=list)
    # Per-session image store, keyed by the content-hash blobId embedded in
    # ChatEvent image parts. Populated by the ImageSink handed to the tailer
    # as JSONL is parsed, so a ChatEvent never carries raw bytes; freed with
    # the rest of the session on kill() since it's just a field on this object.
    blobs: Dict[str, _Blob] = field(default_factory=dict)


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
        self._exit_watch_task: Optional[asyncio.Task] = None
        # Graceful-shutdown grace windows, defaulted from the module consts and
        # kept as attributes only so a test can shrink them instead of waiting
        # out real seconds; nothing in the public API sets them. Mirrors the
        # shutdownCleanExitMs/shutdownConfirmExitMs fields in harness.ts.
        self._shutdown_clean_exit_ms = _SHUTDOWN_CLEAN_EXIT_MS
        self._shutdown_confirm_exit_ms = _SHUTDOWN_CONFIRM_EXIT_MS

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

    def blob(self, session_id: str, blob_id: str) -> Optional[Tuple[bytes, str]]:
        """(data, media_type) for a stored image blob, or None if the session
        or the blob_id is unknown. The caller (the server's blob route) is
        responsible for validating blob_id's shape before ever reaching here."""
        s = self._sessions.get(session_id)
        if not s:
            return None
        b = s.blobs.get(blob_id)
        return (b.data, b.media_type) if b else None

    def _summary(self, s: _Session) -> SessionSummary:
        summary: SessionSummary = {
            "id": s.id,
            "ptyId": s.pty_id,
            "cwd": s.cwd,
            "model": s.model,
            "status": s.status,
            "createdAt": s.created_at,
        }
        if s.error:
            summary["error"] = s.error
        return summary

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
        env: Optional[Dict[str, str]] = None,
    ) -> SessionSummary:
        """`env` is merged by the daemon over its own environment for the
        spawned process. Exposed because some behaviour of the launched CLI is
        only configurable through the environment, and the alternative is
        setting it on the daemon itself, which would leak into every other
        app's sessions in the shared namespace rather than just this one.
        Mirrors CreateSessionOptions.env in harness.ts."""
        cwd = self._check_cwd(cwd)
        session_id = str(uuid.uuid4())
        args: List[str] = ["--session-id", session_id]
        if permission_mode:
            args += ["--permission-mode", permission_mode]
        if model:
            args += ["--model", model]
        if extra_args:
            args += list(extra_args)

        pty_id = await asyncio.to_thread(self._client.new_session, command, args, cwd, env, cols, rows)

        s = _Session(
            id=session_id,
            pty_id=pty_id,
            cwd=cwd,
            model=model,
            status="starting",
            # Match the TS core's Date.toISOString(): millisecond precision and
            # a trailing "Z" rather than Python's default "+00:00" offset.
            created_at=datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        )
        self._sessions[session_id] = s
        self._ensure_exit_watch()

        def on_image(data: str, media_type: str) -> Tuple[str, int]:
            # Decode, hash, and stash the bytes as the JSONL is parsed, so a
            # ChatEvent handed to a subscriber (or replayed on reconnect)
            # never carries raw base64 - only the {blobId, mediaType, bytes}
            # the protocol allows. Same hash in -> same blob_id out, so
            # identical images (even across tool calls) dedupe to one entry.
            # decode_image does the one decode this needs; len(raw) (not a
            # second, independent decode) is what's reported back as the
            # ContentPart's size.
            blob_id, raw = decode_image(data)
            if blob_id not in s.blobs:
                s.blobs[blob_id] = _Blob(raw, media_type)
            return blob_id, len(raw)

        tailer = JsonlTailer(session_id, on_event=lambda ev: self._on_chat(session_id, ev), on_image=on_image)
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
                await asyncio.to_thread(self._client.write_pane, s.pty_id, "\r")
                await asyncio.sleep(0.4)
                continue

            # 1. Bypass-permissions warning. Cursor defaults to "1. No, exit"; a
            #    bare Enter would quit claude. Move to "2. Yes, I accept" (Down)
            #    then confirm.
            if not bypass_accepted and detect.has_bypass_warning(text):
                bypass_accepted = True
                await asyncio.to_thread(self._client.write_pane, s.pty_id, b"\x1b[B")  # Down
                await asyncio.sleep(0.25)
                await asyncio.to_thread(self._client.write_pane, s.pty_id, "\r")
                await asyncio.sleep(0.4)
                continue

            # 2. "Do you trust the files in this folder?" modal (default = yes).
            if not trust_handled and detect.has_trust_modal(text):
                trust_handled = True
                await asyncio.to_thread(self._client.write_pane, s.pty_id, "\r")
                await asyncio.sleep(0.4)
                continue

            # 3. Ready once claude parks its cursor on the "<prompt>" input row
            #    (primary signal), or the prompt/idle footer is on screen
            #    (text fallbacks).
            if detect.ready_for_input(screen) or detect.has_input_prompt(lines) or detect.is_ready_footer(text):
                self._mark_ready(s)
                return

            # 4. Fail fast on a terminal surface the harness can't drive past (an
            #    auth wall, a usage limit, a custom-API-key prompt). Trust /
            #    tool-approval surfaces are left for the timeout classification
            #    below, since those can be transiently on screen while the modal
            #    handlers above act.
            failure = detect.classify_startup_failure(text)
            if failure and detect.is_hard_startup_failure(failure):
                self._mark_failed(s, failure)
                return

            await asyncio.sleep(0.2)

        # Deadline elapsed without readiness. Rather than leave the session
        # wedged in "starting" forever, capture one last frame and say why: a
        # recognized block (e.g. an unaccepted trust modal) or a generic timeout.
        if s.id not in self._sessions or s.ready:
            return
        last = await self._capture_screen(s.pty_id, 300, 1500)
        text = "\n".join(last.lines).lower() if last and last.lines else ""
        self._mark_failed(s, detect.classify_startup_failure(text) or "startup_timeout")

    def _mark_ready(self, s: _Session) -> None:
        if s.ready:
            return
        s.ready = True
        s.status = "ready"
        self._emit("status", s.id, "ready")

    def _mark_failed(self, s: _Session, reason: str) -> None:
        """Mark a session that never reached the input prompt as "failed",
        carrying a short machine reason (a StartupFailure). No-op once the
        session is ready, already failed, or gone. The pty is left alive so the
        caller can inspect or kill() it; a failed session is not usable."""
        if s.id not in self._sessions or s.status != "starting":
            return
        s.status = "failed"
        s.error = reason
        # A failed session never produces a transcript, so stop its JSONL tailer
        # from polling forever; the pty is left alive (see docstring). Don't
        # cancel the task we're running inside: _mark_failed is called from the
        # _drive_startup task, itself tracked in s.tasks.
        current = asyncio.current_task()
        for t in s.tasks:
            if t is not current:
                t.cancel()
        # Listener payload stays the status string (stable 3-arg contract); the
        # reason rides on the session summary (get()/list()) for the server and
        # any direct listener to read.
        self._emit("status", s.id, "failed")

    # --- input ------------------------------------------------------------

    async def send_prompt(
        self, session_id: str, text: str, submit: bool = True, force: bool = False
    ) -> None:
        """Deliver a prompt as a bracketed paste so multi-line text lands in the
        TUI input intact, then (by default) submit it with a single Enter. Pass
        submit=False to stage the text without sending.

        Before writing anything - the check runs before the paste, not just
        before the Enter, and applies even when submit=False - this checks
        whether a picker owns the input (detect.picker_owns_input). If it
        does, the trailing Enter would confirm whichever option is
        highlighted rather than submit the prompt, so both the paste and the
        Enter are withheld and PickerOpenError is raised instead. Pass
        force=True to skip the check and restore the unconditional old
        behaviour.

        The check itself is one _capture_screen call, and failing open when
        it returns None (a timeout or error) is deliberate, not a cop-out: a
        picker sitting open produces no output, so the screen settles - and
        is observed - almost immediately, while a screen that will not settle
        means claude is busy streaming, which means no picker is open. The
        only state this check cannot observe is the state that is already
        known to be safe.

        readiness == "delay" never captures a screen at all (capture wedges
        some setups), so this check is skipped entirely in that mode and
        today's unconditional-send behaviour is unchanged there."""
        s = self._sessions.get(session_id)
        if not s:
            raise KeyError(session_id)

        if not force and self._readiness == "screen":
            screen = await self._capture_screen(s.pty_id, _PICKER_CHECK_SETTLE_MS, _PICKER_CHECK_TIMEOUT_MS)
            if screen and screen.lines and detect.picker_owns_input(screen):
                raise PickerOpenError(
                    f"session {session_id} is showing an interactive picker; sending a prompt now would "
                    "confirm the highlighted option instead. Answer or dismiss it first, or pass force to "
                    "override."
                )

        normalized = text.replace("\r\n", "\n").replace("\r", "\n")
        # Inside a paste the TUI treats CR as a literal newline, not a submit.
        paste = _PASTE_START + normalized.replace("\n", "\r").encode() + _PASTE_END
        await asyncio.to_thread(self._client.write_pane, s.pty_id, paste)
        if submit:
            await asyncio.sleep(0.12)
            await asyncio.to_thread(self._client.write_pane, s.pty_id, "\r")

    async def interrupt(self, session_id: str) -> None:
        s = self._sessions.get(session_id)
        if not s:
            return
        await asyncio.to_thread(self._client.write_pane, s.pty_id, b"\x03")  # Ctrl-C

    async def shutdown(self, session_id: str) -> None:
        """Graceful shutdown: quit claude the way a person does, so it tears
        down its own background work instead of being SIGKILL'd out from under
        it. A SessionStart plugin can arm a background task, and claude runs
        those in their own process session (setsid, detached stdin), so neither
        kill()'s pty Close (SIGHUP to the pty's foreground group) nor its
        SIGKILL to claude ever reaches them - a monitor that doesn't
        voluntarily exit when claude goes away would linger. Driving the TUI's
        own quit path is what makes claude stop that work cleanly.

        Sends Ctrl-C twice (the TUI's quit gesture). If claude has nothing to
        tear down it exits on the two Ctrl-C's alone; if it does, it shows the
        "Background work is running / Exit anyway" modal with "Exit anyway"
        preselected, which this confirms with a single Enter. Either way it
        waits a bounded time for the pty to actually go, and falls back to the
        hard kill() if it never does - so a wedged or unrecognized state can't
        hang teardown.

        In readiness == "delay" mode the daemon's screen capture is avoided
        entirely (it can wedge claude there, the same reason send_prompt skips
        its picker check), so the modal can't be read: that mode still gets the
        two-Ctrl-C clean-exit path but skips the confirm and falls straight
        through to kill() when background work holds claude open.

        Always ends with the session transitioned to "exited": the graceful
        paths call _transition_exited directly, the fallback goes through
        kill(), and every one of those no-ops safely if the exit watcher
        already transitioned the session across one of the awaits below.
        Mirrors harness.ts shutdown()."""
        s = self._sessions.get(session_id)
        if not s:
            return

        # Two Ctrl-C's, 150ms apart: the same 0x03 interrupt() writes,
        # delivered twice, is what the TUI reads as "quit".
        await asyncio.to_thread(self._client.write_pane, s.pty_id, b"\x03")
        await asyncio.sleep(0.15)
        await asyncio.to_thread(self._client.write_pane, s.pty_id, b"\x03")

        # No background work -> claude exits on the two Ctrl-C's alone.
        if await self._wait_exit(s.pty_id, self._shutdown_clean_exit_ms):
            await self._transition_exited(s)
            return

        # Still alive: it may be holding the "Exit anyway" modal. Read the
        # screen (screen mode only - capture is skipped in delay mode) and, if
        # the modal is up, confirm it with Enter and wait again for the exit.
        if self._readiness == "screen":
            screen = await self._capture_screen(s.pty_id, 200, 1000)
            if screen and detect.has_exit_confirm("\n".join(screen.lines)):
                await asyncio.to_thread(self._client.write_pane, s.pty_id, "\r")
                if await self._wait_exit(s.pty_id, self._shutdown_confirm_exit_ms):
                    await self._transition_exited(s)
                    return

        # Wedged, unrecognized, or delay mode with background work still
        # holding claude open: hard kill. kill() also transitions to "exited".
        await self.kill(session_id)

    async def _wait_exit(self, pty_id: str, budget_ms: int) -> bool:
        """Poll list_sessions() until `pty_id` is gone (absent from the list,
        or listed with alive is False) or `budget_ms` elapses; return whether
        it exited within the budget. Used only by shutdown() to wait out a
        graceful quit - the periodic exit watcher (_watch_exits_loop) is what
        ultimately reports the exit for status purposes, so this is a
        deliberately bounded local poll, not a subscription.

        A failing list_sessions() is treated as "not exited yet", never as an
        exit: the same not-evidence-of-death stance _watch_exits_once takes, so
        a transient daemon-connection error just burns a poll and the graceful
        wait keeps going (worst case the budget elapses and shutdown falls back
        to kill()). The poll interval is clamped to the remaining budget so a
        wait can't overshoot it, and the first check runs before any sleep so
        an already-dead pty returns at once. Mirrors waitExit in harness.ts."""
        loop = asyncio.get_event_loop()
        deadline = loop.time() + budget_ms / 1000
        while True:
            try:
                infos = await asyncio.to_thread(self._client.list_sessions)
                info = next((i for i in infos if i.get("id") == pty_id), None)
                if info is None or info.get("alive") is False:
                    return True
            except Exception:
                # Absence of information, not evidence of exit; keep waiting.
                pass
            remaining = deadline - loop.time()
            if remaining <= 0:
                return False
            await asyncio.sleep(min(_WAIT_EXIT_POLL_MS / 1000, remaining))

    async def kill(self, session_id: str) -> None:
        s = self._sessions.get(session_id)
        if not s:
            return
        try:
            await asyncio.to_thread(self._client.kill, s.pty_id)
        except Exception:
            pass
        await self._transition_exited(s)

    # --- exit watcher -------------------------------------------------------
    # Nothing else in this class subscribes to the daemon's unsolicited
    # messages (no on_event, no attach), so a pty that dies on its own -
    # crash, /exit, OOM, a daemon restart - would otherwise leave its session
    # tracked forever with a stale status and every prompt to it silently
    # discarded (write_pane returns None with no way to report a failed
    # delivery). This polls list_sessions() instead of attaching, because
    # attach streams every byte of pty output with no way to opt out - see
    # .agent-workspace/session-exit-watcher.md for the probe that ruled it
    # out. Mirrors the TS core's watchExits/ensureExitWatch/transitionExited.

    async def _transition_exited(self, s: _Session) -> None:
        """The one place a session becomes "exited": cancel its tasks, await
        their cancellation, flip status, emit the status event, and drop it
        from the tracked map. Both kill() (an explicit request) and the exit
        watcher (the pty died on its own) funnel through this, so the two can
        never drift into producing different end states for what a listener
        sees as the same transition.

        No-ops if `s` is no longer the tracked entry for its id - it was
        already transitioned by the other path (e.g. kill() and the watcher
        racing on the same session across kill()'s own await). Cheap, and it
        makes a double "exited" emission structurally impossible rather than
        merely unlikely."""
        if self._sessions.get(s.id) is not s:
            return
        self._sessions.pop(s.id, None)
        for t in s.tasks:
            t.cancel()
        # Await the cancelled tasks so they finish unwinding instead of
        # surfacing "Task was destroyed but it is pending" warnings.
        await asyncio.gather(*s.tasks, return_exceptions=True)
        s.status = "exited"
        self._emit("status", s.id, "exited")
        # No separate blob cleanup needed: s.blobs is just a field on the
        # _Session object already popped above, so it's freed with it.
        # Nothing left to poll for; don't keep the watcher task alive for
        # sessions that no longer exist. See _ensure_exit_watch's docstring
        # for why teardown lives here rather than on some harness-level
        # close() - there is none in this port either (checked both).
        if not self._sessions and self._exit_watch_task is not None:
            task = self._exit_watch_task
            # Don't cancel (or clear the field for) the task we're running
            # inside - the same self-cancellation hazard _mark_failed avoids.
            # _transition_exited can be reached from _watch_exits_once,
            # itself running inside this very task, mid for-loop over
            # possibly several dying sessions; cancelling it here would throw
            # CancelledError into that loop at its next await and cut the
            # round short before every session in it was reconciled.
            # _watch_exits_loop's own post-poll check clears the field and
            # returns instead, once the round already in progress has
            # actually finished - leaving the field set (not None) until
            # then also stops _ensure_exit_watch from reading "still running
            # this last round" as "gone" and spinning up a redundant second
            # task for a session created in the same window.
            if task is not asyncio.current_task():
                self._exit_watch_task = None
                task.cancel()

    def _ensure_exit_watch(self) -> None:
        """Start the exit watcher task if it isn't already running. Called
        whenever a session starts being tracked (create_session); a no-op
        once the task exists. ClaudeHarness has no close()/dispose() in
        either port, so there is no harness-level lifecycle to hook a
        teardown into. Tying the task's lifetime to the tracked-session count
        instead - started here, stopped in _transition_exited once the last
        one is gone - is "whatever lifecycle exists": it can't outlive the
        harness's actual work, and a harness that is simply dropped without
        ever killing its sessions is no worse off than it already was (its
        sessions, and now its watcher, live as long as something still
        references them)."""
        if self._exit_watch_task is not None and not self._exit_watch_task.done():
            return
        self._exit_watch_task = asyncio.create_task(self._watch_exits_loop())

    async def _watch_exits_loop(self) -> None:
        while True:
            await asyncio.sleep(EXIT_WATCH_INTERVAL_MS / 1000)
            await self._watch_exits_once()
            if not self._sessions:
                # Last tracked session is already gone (this same poll may
                # have been what removed it); stop rather than keep polling
                # for nothing. Clearing the field here rather than in
                # _transition_exited is what lets _ensure_exit_watch tell
                # "this task is still finishing its last round" apart from
                # "this task is actually gone" - see _transition_exited's
                # comment. A new session later calls _ensure_exit_watch and
                # gets a fresh task.
                self._exit_watch_task = None
                return

    async def _watch_exits_once(self) -> None:
        """One poll of the exit watcher: ask the daemon which pty sessions
        are still around and reconcile every session THIS harness tracks
        against it.

        A failed list_sessions() is an absence of information, not evidence
        of death - a dropped daemon connection must not read as every
        tracked session dying at once - so any error here aborts the round
        before a single session is touched; there is no code path from "the
        call raised" to _transition_exited. This is the load-bearing
        behavior of this method; it is enforced by the early `return` inside
        the except below, not by a comment elsewhere hoping every future
        edit remembers it.

        list_sessions() also returns the other port's sessions, since TS and
        Python share HARNESS_NAMESPACE. Reconciling by looking up each
        TRACKED pty_id in the result - rather than iterating the result and
        matching outward - means a foreign pty_id is never even considered,
        let alone acted on: this loop only ever visits self._sessions."""
        try:
            infos = await asyncio.to_thread(self._client.list_sessions)
        except Exception:
            return
        by_pty_id = {info.get("id"): info for info in infos}
        for s in list(self._sessions.values()):
            info = by_pty_id.get(s.pty_id)
            # Absent from the list, or present and explicitly not alive, both
            # mean the pty is gone. There is deliberately no grace period for
            # a session that has never yet been seen alive: new_session()
            # only returns after the daemon has registered the session, so a
            # tracked pty_id is listed from the moment we know it exists
            # (verified against the real daemon over repeated
            # create-then-list-immediately rounds, with no sleep, and it was
            # never once missing). An earlier version required one prior
            # alive sighting before trusting an absence, guarding a race that
            # does not exist, and it silently cost the case that matters
            # most: a session dying within the first poll interval was then
            # never reported dead at all.
            if info is not None and info.get("alive") is not False:
                continue
            await self._transition_exited(s)
