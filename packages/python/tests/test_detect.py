"""Run with: uv run python -m unittest discover -s tests (stdlib only)."""
import unittest

from claude_pty_web_harness import detect
from claude_pty_web_harness._pupptyeer import Screen, Cursor


def screen(cursor: Cursor, *lines: str) -> Screen:
    return Screen(cols=40, rows=len(lines), lines=list(lines), cursor=cursor,
                  alt_screen=False)


class TestReadyForInput(unittest.TestCase):
    def test_visible_cursor_on_prompt_row_is_ready(self):
        self.assertTrue(detect.ready_for_input(
            screen(Cursor(1, 2, True), "header", '❯ Try "fix the bug"')))
        self.assertTrue(detect.ready_for_input(screen(Cursor(0, 2, True), "❯ ")))

    def test_not_visible_cursor_abstains_falls_back_to_text(self):
        # pupptyeer 0.8.0 defaults an absent cursor to visible=False, so the
        # cursor signal must abstain and readiness falls back to the text match.
        s = screen(Cursor(0, 2, False), '❯ Try "x"')
        self.assertFalse(detect.ready_for_input(s),
                         "cursor signal should abstain when not visible")
        self.assertTrue(detect.has_input_prompt(s.lines),
                        "text fallback should still see the prompt")

    def test_cursor_on_numbered_menu_option_is_not_ready(self):
        self.assertFalse(detect.ready_for_input(
            screen(Cursor(0, 2, True), "❯ 1. Yes, I trust this folder", "  2. No")))

    def test_cursor_row_out_of_range_is_not_ready(self):
        self.assertFalse(detect.ready_for_input(screen(Cursor(9, 0, True), "❯ ")))


class TestHasInputPrompt(unittest.TestCase):
    def test_matches(self):
        self.assertTrue(detect.has_input_prompt(["welcome", "❯ "]))
        self.assertTrue(detect.has_input_prompt(['❯ Try "build a CLI"']))

    def test_non_matches(self):
        self.assertFalse(detect.has_input_prompt(["❯ 1. Yes, I trust this folder"]))
        self.assertFalse(detect.has_input_prompt(["❯ Dark mode"]),
                         "unnumbered selection option is not the input prompt")
        self.assertFalse(detect.has_input_prompt(["no prompt here"]))


class TestPickerOwnsInput(unittest.TestCase):
    """Pinned against real screen captures driven against a live session on
    2026-07-20 (see conformance/picker-screens/, copied from
    screens.json/screens2.json). Each fixture reconstructs just enough of the
    captured grid to be faithful on what the predicate actually inspects: the
    exact text of every "<prompt>"-prefixed row, and the cursor sitting at the
    exact row the capture recorded. Everything else on the real screen (the
    welcome box, separators, footer) is blank filler here, since none of it
    starts with the prompt glyph and so never affects the result either way.

    screens.json's own `lines` arrays were filtered of blank lines before
    being saved, so a capture's cursor.row does not index into them directly;
    screens2.json (states 6 and 7) kept the raw, unfiltered grid, where it
    does. Each test asserts `lines[cursor.row]` equals the row the capture
    says the cursor sat on, so a misaligned fixture fails loudly here instead
    of silently asserting the wrong thing."""

    def test_state1_idle_input_box_is_not_a_picker(self):
        # Live, empty input box; cursor visible right on the bare prompt row.
        cur = Cursor(15, 2, True)
        lines = [""] * 16
        lines[15] = "❯ "
        self.assertEqual(lines[cur.row], "❯ ", "cursor should sit on the live input row")
        self.assertFalse(detect.picker_owns_input(screen(cur, *lines)))

    def test_state2_staged_numbered_text_is_not_a_picker(self):
        # Typed but not submitted: "1. Fix the login bug" sits on the live
        # input row, cursor parked right on it. This is exactly the false
        # positive the lines-only predicate produced - the row is excluded
        # here because it is the cursor's own row, not because of anything
        # about its text.
        cur = Cursor(15, 22, True)
        lines = [""] * 16
        lines[15] = "❯ 1. Fix the login bug"
        self.assertEqual(lines[cur.row], "❯ 1. Fix the login bug",
                          "cursor should sit on the staged text row")
        self.assertFalse(detect.picker_owns_input(screen(cur, *lines)))

    def test_state3_after_clear_is_not_a_picker(self):
        # Back to an empty live input row after Ctrl+U/clear - same shape as state 1.
        cur = Cursor(15, 2, True)
        lines = [""] * 16
        lines[15] = "❯ "
        self.assertEqual(lines[cur.row], "❯ ", "cursor should sit on the live input row")
        self.assertFalse(detect.picker_owns_input(screen(cur, *lines)))

    def test_state4_after_submitting_numbered_list_is_not_a_picker(self):
        # The submitted "❯ 1. Reply with only the word alpha" stays in
        # scrollback forever; the live input row below it (where the cursor
        # now sits) is back to bare. Getting this wrong is the catastrophic
        # case the lines-only predicate produced: every later send_prompt
        # from a user who ever sent a numbered list would be refused,
        # permanently.
        cur = Cursor(20, 2, True)
        lines = [""] * 21
        lines[12] = "❯ 1. Reply with only the word alpha"  # scrollback echo, not under the cursor
        lines[20] = "❯ "  # live, empty input row
        self.assertEqual(lines[cur.row], "❯ ",
                          "cursor should sit on the live input row, not the scrollback echo")
        self.assertFalse(detect.picker_owns_input(screen(cur, *lines)))

    def test_state5_askuserquestion_picker_open_is_a_picker(self):
        # A real picker: cursor.visible is False (no live input row to sit on
        # at all), and the highlighted option renders as "❯ 1. Red" - a
        # numbered prompt row that (trivially, since there is no visible
        # cursor) is not the cursor's row. The still-present scrollback echo
        # from the earlier numbered send doesn't change the answer either way.
        # cursor.row is irrelevant here: ready_for_input/picker_owns_input
        # never read it once cursor.visible is False, so the real capture's
        # row (25) isn't reproduced against this trimmed fixture.
        cur = Cursor(0, 0, False)
        lines = [
            "❯ 1. Reply with only the word alpha",
            "  2. Do nothing else",
            "● alpha",
            "❯ Use the AskUserQuestion tool right now to ask me whether I prefer red or blue. Ask only, do nothing else.",
            " ☐ Color pref",
            "Which color do you prefer?",
            "❯ 1. Red",
            "     You prefer red",
            "  2. Blue",
            "     You prefer blue",
            "  3. Type something.",
            "  4. Chat about this",
            "Enter to select · ↑/↓ to navigate · Esc to cancel",
        ]
        self.assertTrue(detect.picker_owns_input(screen(cur, *lines)))

    def test_state6_mid_turn_busy_is_not_a_picker(self):
        # The live empty input row is present (and the cursor visible on it)
        # while claude works; queuing a follow-up mid-turn is legitimate and
        # must not be refused.
        cur = Cursor(33, 2, True)
        lines = [""] * 34
        lines[33] = "❯ "
        self.assertEqual(lines[cur.row], "❯ ", "cursor should sit on the live input row")
        self.assertFalse(detect.picker_owns_input(screen(cur, *lines)))

    def test_state7_tool_permission_prompt_is_not_a_picker_already_resolved(self):
        # This capture contradicts the plan's expectation that a
        # tool-permission capture would classify as a picker. What it
        # actually shows: auto mode had already approved "echo hello" (footer
        # reads "auto mode on") and the command had already run and printed
        # its result before the screen settled enough to capture, so there is
        # no numbered accept/deny row left on screen at all - only the
        # resolved command's own header line and a second, unrelated prompt
        # ("Count numbers one to forty") staged but not yet submitted, cursor
        # parked right on it. That staged row is not a numbered menu option,
        # so it does not even need the cursor-exclusion rule to be cleared:
        # ready_for_input alone is already true here. This is the
        # capture-races-the-modal case the design doc calls out (a picker
        # with no output settles instantly; here the auto-approval plus its
        # own output was the thing that settled first).
        cur = Cursor(35, 2, True)
        lines = [""] * 36
        lines[27] = "❯ Run the shell command: echo hello"  # resolved tool call's own header, not numbered
        lines[35] = "❯  Count numbers one to forty"  # staged, not-yet-submitted next prompt
        self.assertEqual(lines[cur.row], "❯  Count numbers one to forty",
                          "cursor should sit on the staged prompt row")
        self.assertFalse(detect.picker_owns_input(screen(cur, *lines)))


class TestHasStylePicker(unittest.TestCase):
    def test_dark_light_pair_only(self):
        self.assertTrue(detect.has_style_picker(
            "choose the text style\n❯ dark mode\n  light mode"))
        self.assertFalse(detect.has_style_picker("switched to dark mode"))
        self.assertFalse(detect.has_style_picker("❯ try something"))


class TestClassifyStartupFailure(unittest.TestCase):
    def test_recognizes_interactive_block_surfaces(self):
        self.assertIsNone(detect.classify_startup_failure("Welcome back\n❯ "))
        self.assertEqual(detect.classify_startup_failure("❯ \nfailed to authenticate"), "auth_blocked")
        self.assertEqual(detect.classify_startup_failure("API Error: 403 Forbidden"), "auth_blocked")
        self.assertEqual(detect.classify_startup_failure("Please run /login to continue"), "auth_blocked")
        self.assertEqual(detect.classify_startup_failure("You've hit your limit"), "rate_limit")
        self.assertEqual(detect.classify_startup_failure("You are approaching usage limit"), "rate_limit")
        self.assertEqual(
            detect.classify_startup_failure("Detected a custom API key in your environment"),
            "custom_api_key_detected",
        )
        self.assertEqual(
            detect.classify_startup_failure("Do you trust the files in this folder?"),
            "workspace_trust_blocked",
        )
        self.assertEqual(
            detect.classify_startup_failure("Permission required: allow or deny this action?"),
            "tool_approval_blocked",
        )

    def test_case_insensitive_over_raw_grid_join(self):
        self.assertEqual(detect.classify_startup_failure("FAILED TO AUTHENTICATE"), "auth_blocked")


class TestIsHardStartupFailure(unittest.TestCase):
    def test_only_surfaces_the_harness_cannot_drive_past(self):
        for hard in ("auth_blocked", "rate_limit", "custom_api_key_detected"):
            self.assertTrue(detect.is_hard_startup_failure(hard))
        for soft in ("workspace_trust_blocked", "tool_approval_blocked", "startup_timeout"):
            self.assertFalse(detect.is_hard_startup_failure(soft))


if __name__ == "__main__":
    unittest.main()
