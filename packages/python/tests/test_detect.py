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
