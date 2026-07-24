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
        # Counts kill() so the shutdown tests can observe the hard-kill fallback.
        self.kill_calls = 0
        # Every positional call new_session() received, recorded verbatim.
        self.new_session_calls = []

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

    def new_session(self, command, args, cwd, env, cols, rows):
        self.new_session_calls.append(
            {"command": command, "args": args, "cwd": cwd, "env": env, "cols": cols, "rows": rows}
        )
        return f"pty-{len(self.new_session_calls)}"

    def kill(self, pty_id) -> None:
        # Counted so the shutdown tests can observe the hard-kill fallback; also
        # where create_session's cleanup kill() (used to stop the
        # tailer/exit-watch tasks those tests started for real) lands.
        self.kill_calls += 1


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


# --- create_session: env ------------------------------------------------------
#
# create_session builds a fresh session for real (id, tailer task, drive-startup
# task), unlike _harness_with_session above, so each test here uses a
# FakeClient whose capture_screen resolves _ready_screen() - _drive_startup
# then reaches readiness on its first capture instead of polling - and calls
# kill() once it's done asserting, so the tailer's and exit watcher's real
# asyncio tasks are cancelled before the test ends rather than left running.
#
# base_opts is shared across both tests below with every optional argument
# given an explicit, non-default value so the two calls are identical apart
# from env: that's what lets asserting the same command/args/cwd/cols/rows in
# both stand in for "the other session-creation arguments are unaffected by
# supplying env," rather than that being a claim taken on faith.
_base_opts = dict(
    cwd="/tmp",
    command="claude",
    model="opus",
    permission_mode="acceptEdits",
    extra_args=["--foo"],
    cols=100,
    rows=30,
)


class TestCreateSessionEnv(unittest.IsolatedAsyncioTestCase):
    async def test_env_passed_through_verbatim(self):
        fake = FakeClient(screen=_ready_screen())
        h = ClaudeHarness(fake)

        summary = await h.create_session(**_base_opts, env={"FOO": "bar"})
        self.assertEqual(len(fake.new_session_calls), 1)
        call = fake.new_session_calls[0]
        self.assertEqual(call["env"], {"FOO": "bar"})
        self.assertEqual(call["command"], "claude")
        self.assertEqual(
            call["args"],
            ["--session-id", summary["id"], "--permission-mode", "acceptEdits", "--model", "opus", "--foo"],
        )
        self.assertEqual(call["cwd"], "/tmp")
        self.assertEqual(call["cols"], 100)
        self.assertEqual(call["rows"], 30)

        await h.kill(summary["id"])

    async def test_env_omitted_sends_none_not_empty_dict(self):
        fake = FakeClient(screen=_ready_screen())
        h = ClaudeHarness(fake)

        summary = await h.create_session(**_base_opts)
        self.assertEqual(len(fake.new_session_calls), 1)
        call = fake.new_session_calls[0]
        self.assertIsNone(call["env"], "env must reach new_session as None, not {} or a missing argument")
        self.assertEqual(call["command"], "claude")
        self.assertEqual(
            call["args"],
            ["--session-id", summary["id"], "--permission-mode", "acceptEdits", "--model", "opus", "--foo"],
        )
        self.assertEqual(call["cwd"], "/tmp")
        self.assertEqual(call["cols"], 100)
        self.assertEqual(call["rows"], 30)

        await h.kill(summary["id"])


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


# --- graceful shutdown --------------------------------------------------------
#
# shutdown() is driven directly against the same injected-fake seam. The fake's
# write_pane records both Ctrl-C bytes and the Enter string into `writes` in
# order, counts kill() so the fallback is observable, and scripts list_sessions
# so _wait_exit sees the pty stay or go on cue. Both grace budgets are shrunk
# to 0ms on the harness so a wait that must time out returns after a single
# poll instead of burning the real 1s/3s (a 0ms budget = "check once, don't
# wait", since _wait_exit polls before it checks the deadline). Mirrors the
# "graceful shutdown" tests in harness.test.ts.

def _exit_confirm_screen() -> Screen:
    """A settled "Background work is running / Exit anyway" modal frame."""
    return Screen(
        cols=40, rows=3,
        lines=["Background work is running", "❯ 1. Exit anyway", "  2. Stay"],
        cursor=Cursor(0, 0, False), alt_screen=False,
    )


def _shutdown_harness(fake: FakeClient, readiness: str = "screen") -> ClaudeHarness:
    """_harness_with_sessions + a pty ("s1" -> "pty-1"), grace budgets 0."""
    h = _harness_with_sessions(fake, {"s1": {"pty_id": "pty-1"}})
    h._readiness = readiness
    h._shutdown_clean_exit_ms = 0
    h._shutdown_confirm_exit_ms = 0
    return h


class TestShutdown(unittest.IsolatedAsyncioTestCase):
    async def test_exits_on_two_ctrl_c_no_screen_read_no_kill(self):
        fake = FakeClient(screen=_exit_confirm_screen())
        fake.list_sessions_results = [[]]  # pty already gone on the first poll
        h = _shutdown_harness(fake)
        events = _collect_status_events(h)

        await h.shutdown("s1")

        self.assertEqual(fake.writes, [b"\x03", b"\x03"], "two Ctrl-C's, nothing else")
        self.assertEqual(fake.capture_calls, 0, "a clean exit never reads the screen")
        self.assertEqual(fake.kill_calls, 0, "no hard-kill fallback")
        self.assertEqual(events, [("s1", "exited")])
        self.assertIsNone(h.get("s1"))

    async def test_confirms_modal_with_enter_then_exits(self):
        fake = FakeClient(screen=_exit_confirm_screen())
        # Alive on the post-Ctrl-C poll, gone on the post-Enter poll.
        fake.list_sessions_results = [[_session_info("pty-1", True)], []]
        h = _shutdown_harness(fake)
        events = _collect_status_events(h)

        await h.shutdown("s1")

        self.assertEqual(fake.writes, [b"\x03", b"\x03", "\r"], "two Ctrl-C's then Enter")
        self.assertEqual(fake.capture_calls, 1, "read the screen once to see the modal")
        self.assertEqual(fake.kill_calls, 0, "graceful exit, no hard kill")
        self.assertEqual(events, [("s1", "exited")])

    async def test_falls_back_to_kill_when_never_exits(self):
        fake = FakeClient(screen=_exit_confirm_screen())
        fake.list_sessions_results = [[_session_info("pty-1", True)]]  # never exits
        h = _shutdown_harness(fake)
        events = _collect_status_events(h)

        await h.shutdown("s1")

        self.assertEqual(fake.writes, [b"\x03", b"\x03", "\r"], "Enter was tried against the modal")
        self.assertEqual(fake.kill_calls, 1, "hard-kill fallback ran")
        self.assertEqual(events, [("s1", "exited")], "kill still transitions to exited")

    async def test_delay_mode_never_captures_falls_to_kill(self):
        fake = FakeClient(screen=_exit_confirm_screen())
        fake.list_sessions_results = [[_session_info("pty-1", True)]]
        h = _shutdown_harness(fake, readiness="delay")
        events = _collect_status_events(h)

        await h.shutdown("s1")

        self.assertEqual(fake.writes, [b"\x03", b"\x03"], "two Ctrl-C's, no modal confirm")
        self.assertEqual(fake.capture_calls, 0, "delay mode must never capture the screen")
        self.assertEqual(fake.kill_calls, 1, "falls straight through to hard kill")
        self.assertEqual(events, [("s1", "exited")])


if __name__ == "__main__":
    unittest.main()
