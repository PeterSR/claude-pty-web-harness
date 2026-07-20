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

    def write_pane(self, session, data) -> None:
        self.writes.append(data)

    def capture_screen(self, session, settle_ms, timeout_ms) -> Screen:
        self.capture_calls += 1
        if self._reject_capture:
            raise RuntimeError("simulated capture failure")
        return self._screen if self._screen is not None else _empty_screen()


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


if __name__ == "__main__":
    unittest.main()
