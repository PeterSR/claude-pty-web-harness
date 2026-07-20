"""Run with: uv run python -m unittest discover -s tests (stdlib only).
Mirrors harness.test.ts.

ClaudeHarness's constructor takes `client` directly (unlike the TS port,
where ClaudeHarness.create() is the only public constructor), so these tests
just construct it with a fake client and poke a minimal _Session in. send_prompt
only ever reads s.pty_id, so the fake session doesn't need a real tailer or
any other _Session field beyond what the dataclass requires."""
import unittest

from claude_pty_web_harness._pupptyeer import Cursor, Screen
from claude_pty_web_harness.harness import ClaudeHarness, PickerOpenError, _Session


class FakeClient:
    def __init__(self, screen: Screen = None, reject_capture: bool = False):
        self.writes = []
        self.capture_calls = 0
        self._screen = screen
        self._reject_capture = reject_capture
        self.list_sessions_calls = 0
        # Scripts what list_sessions() returns (or raises) across successive
        # calls. While more than one entry remains, each call pops one off
        # the front; once exactly one is left, it is returned/raised on every
        # further call without being consumed - so a test can script an exact
        # per-poll sequence (e.g. [[info], []] - present, then gone) or set a
        # single steady-state value/error that holds across as many polls as
        # it drives. Mirrors FakeClient.listSessionsResults in harness.test.ts.
        self.list_sessions_results = [[]]

    def write_pane(self, session, data) -> None:
        self.writes.append(data)

    def capture_screen(self, session, settle_ms, timeout_ms) -> Screen:
        self.capture_calls += 1
        if self._reject_capture:
            raise RuntimeError("simulated capture failure")
        return self._screen if self._screen is not None else _empty_screen()

    def list_sessions(self):
        self.list_sessions_calls += 1
        if len(self.list_sessions_results) > 1:
            result = self.list_sessions_results.pop(0)
        else:
            result = self.list_sessions_results[0]
        if isinstance(result, Exception):
            raise result
        return result


def _empty_screen() -> Screen:
    return Screen(cols=40, rows=0, lines=[], cursor=Cursor(0, 0, False), alt_screen=False)


def _picker_screen() -> Screen:
    # A real picker hides the cursor entirely (see the captured
    # AskUserQuestion state in test_detect.py); a visible cursor sitting on
    # this same row would instead be the caller's own staged, not-yet-
    # submitted numbered text, which picker_owns_input must NOT treat as a
    # picker.
    return Screen(
        cols=40, rows=2,
        lines=["❯ 1. Yes, I trust this folder", "  2. No"],
        cursor=Cursor(0, 0, False), alt_screen=False,
    )


def _ready_screen() -> Screen:
    return Screen(cols=40, rows=1, lines=["❯ "], cursor=Cursor(0, 2, True), alt_screen=False)


def _harness_with_session(fake: FakeClient, readiness: str = "screen") -> ClaudeHarness:
    h = ClaudeHarness(fake, readiness=readiness)
    h._sessions["s1"] = _Session(
        id="s1", pty_id="pty-1", cwd="/tmp", model=None, status="ready",
        created_at="2026-01-01T00:00:00.000Z",
    )
    return h


class TestSendPrompt(unittest.IsolatedAsyncioTestCase):
    async def test_picker_on_screen_raises_and_writes_nothing(self):
        fake = FakeClient(screen=_picker_screen())
        h = _harness_with_session(fake)
        with self.assertRaises(PickerOpenError) as ctx:
            await h.send_prompt("s1", "hello")
        self.assertEqual(ctx.exception.code, "picker_open")
        self.assertEqual(fake.writes, [], "no bytes should have been written")

    async def test_no_picker_writes_paste_and_enter(self):
        fake = FakeClient(screen=_ready_screen())
        h = _harness_with_session(fake)
        await h.send_prompt("s1", "hello")
        self.assertEqual(len(fake.writes), 2)
        self.assertEqual(fake.writes[1], "\r")

    async def test_force_bypasses_check_even_with_picker(self):
        fake = FakeClient(screen=_picker_screen())
        h = _harness_with_session(fake)
        await h.send_prompt("s1", "hello", force=True)
        self.assertEqual(fake.capture_calls, 0, "capture_screen should never be called under force")
        self.assertEqual(len(fake.writes), 2)

    async def test_capture_failure_fails_open(self):
        fake = FakeClient(reject_capture=True)
        h = _harness_with_session(fake)
        await h.send_prompt("s1", "hello")
        self.assertEqual(len(fake.writes), 2)

    async def test_readiness_delay_never_captures(self):
        fake = FakeClient(screen=_picker_screen())
        h = _harness_with_session(fake, readiness="delay")
        await h.send_prompt("s1", "hello")
        self.assertEqual(fake.capture_calls, 0, "capture_screen should never be called in delay mode")
        self.assertEqual(len(fake.writes), 2)

    async def test_submit_false_with_picker_still_raises(self):
        fake = FakeClient(screen=_picker_screen())
        h = _harness_with_session(fake)
        with self.assertRaises(PickerOpenError):
            await h.send_prompt("s1", "hello", submit=False)
        self.assertEqual(fake.writes, [])

    async def test_unknown_session_raises_before_capture(self):
        fake = FakeClient(screen=_picker_screen())
        h = ClaudeHarness(fake)
        with self.assertRaises(KeyError):
            await h.send_prompt("nope", "hello")
        self.assertEqual(fake.capture_calls, 0)


# --- exit watcher ------------------------------------------------------------
#
# These tests never call create_session(), so the real _watch_exits_loop task
# (started by _ensure_exit_watch) never runs. Instead each test calls the
# private _watch_exits_once() coroutine directly to drive exactly one poll on
# demand - no real timers, no fake clock, and the suite stays fast. Mirrors
# the "watchExits:" tests in harness.test.ts.

def _session_info(pty_id: str, alive: bool = True) -> dict:
    """A SessionInfo dict as list_sessions() would return it, keyed by pty_id
    (its "id")."""
    return {
        "id": pty_id,
        "namespace": "claude-pty-web-harness",
        "command": "claude",
        "cols": 120,
        "rows": 40,
        "created": "2026-01-01T00:00:00.000Z",
        "last_activity": "2026-01-01T00:00:00.000Z",
        "attached": 0,
        "alive": alive,
    }


def _harness_with_sessions(fake: FakeClient, sessions: dict) -> ClaudeHarness:
    """A harness wired to `fake`, with one _Session per entry of `sessions`
    ({id: {"pty_id": ...}}) inserted directly into h._sessions.
    _watch_exits_once/_transition_exited only ever touch pty_id, status and
    tasks (empty here, the dataclass default), so nothing else needs
    populating."""
    h = ClaudeHarness(fake)
    for session_id, opts in sessions.items():
        h._sessions[session_id] = _Session(
            id=session_id,
            pty_id=opts["pty_id"],
            cwd="/tmp",
            model=None,
            status="ready",
            created_at="2026-01-01T00:00:00.000Z",
        )
    return h


def _collect_status_events(h: ClaudeHarness) -> list:
    """Collects (session_id, status) for every "status" event, in order."""
    events: list = []

    def on_event(kind, session_id, payload):
        if kind == "status":
            events.append((session_id, payload))

    h.add_listener(on_event)
    return events


class TestWatchExits(unittest.IsolatedAsyncioTestCase):
    async def test_missing_from_list_transitions_to_exited(self):
        fake = FakeClient()
        fake.list_sessions_results = [[]]  # steady-state: pty-1 never appears again
        h = _harness_with_sessions(fake, {"s1": {"pty_id": "pty-1"}})
        events = _collect_status_events(h)

        await h._watch_exits_once()

        self.assertEqual(events, [("s1", "exited")])
        self.assertIsNone(h.get("s1"), "gone from get()")
        self.assertEqual(h.list(), [], "gone from list()")

    async def test_present_and_alive_left_alone_across_several_polls(self):
        fake = FakeClient()
        fake.list_sessions_results = [[_session_info("pty-1", True)]]  # steady-state
        h = _harness_with_sessions(fake, {"s1": {"pty_id": "pty-1"}})
        events = _collect_status_events(h)

        await h._watch_exits_once()
        await h._watch_exits_once()
        await h._watch_exits_once()

        self.assertEqual(events, [], "no status event for a live session")
        self.assertEqual(h.get("s1")["status"], "ready")

    async def test_alive_false_transitions_to_exited(self):
        fake = FakeClient()
        fake.list_sessions_results = [[_session_info("pty-1", False)]]
        h = _harness_with_sessions(fake, {"s1": {"pty_id": "pty-1"}})
        events = _collect_status_events(h)

        await h._watch_exits_once()

        self.assertEqual(events, [("s1", "exited")])
        self.assertIsNone(h.get("s1"))

    async def test_failing_list_sessions_marks_nothing_across_repeated_failures(self):
        fake = FakeClient()
        fake.list_sessions_results = [RuntimeError("simulated dropped daemon connection")]
        h = _harness_with_sessions(fake, {"s1": {"pty_id": "pty-1"}})
        events = _collect_status_events(h)

        await h._watch_exits_once()
        await h._watch_exits_once()
        await h._watch_exits_once()

        self.assertEqual(events, [], "an error must never be read as evidence of death")
        self.assertEqual(h.get("s1")["status"], "ready")
        self.assertEqual(fake.list_sessions_calls, 3)

    async def test_foreign_pty_id_ignored_entirely(self):
        fake = FakeClient()
        # s1's own pty_id is present and alive (so this isn't also exercising
        # a death), plus one extra entry - another port's session in the
        # shared namespace - that this harness never tracked.
        fake.list_sessions_results = [[_session_info("pty-1", True), _session_info("someone-elses-pty", False)]]
        h = _harness_with_sessions(fake, {"s1": {"pty_id": "pty-1"}})
        events = _collect_status_events(h)

        await h._watch_exits_once()

        self.assertEqual(events, [], "a foreign pty_id must produce no event and not crash")
        self.assertEqual(h.get("s1")["status"], "ready")

    async def test_death_before_any_alive_sighting_is_still_detected(self):
        fake = FakeClient()
        fake.list_sessions_results = [[]]  # died within the first poll interval
        h = _harness_with_sessions(fake, {"s1": {"pty_id": "pty-1"}})
        events = _collect_status_events(h)

        await h._watch_exits_once()

        # An earlier version required one prior alive sighting before trusting
        # an absence, to guard a create-then-list race. Probing the real daemon
        # showed that race does not exist (new_session only returns once the
        # session is registered, and a create-then-list-immediately loop never
        # once missed it), while the guard silently lost exactly this case: a
        # session dying inside the first interval was never reported dead at
        # all. Caught by an end to end test against a real daemon that the
        # fakes here had passed.
        self.assertEqual(events, [("s1", "exited")])
        self.assertIsNone(h.get("s1"))


if __name__ == "__main__":
    unittest.main()
