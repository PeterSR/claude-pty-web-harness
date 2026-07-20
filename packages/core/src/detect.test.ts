// Run with: npx tsx --test src/detect.test.ts  (no extra test deps; uses node:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Screen } from "pupptyeer-client";
import {
  readyForInput,
  hasInputPrompt,
  pickerOwnsInput,
  hasStylePicker,
  classifyStartupFailure,
  isHardStartupFailure,
} from "./detect.js";

function screen(cursor: Screen["cursor"], ...lines: string[]): Screen {
  return { cols: 40, rows: lines.length, lines, cursor, altScreen: false };
}

test("readyForInput: visible cursor on the prompt row is ready", () => {
  assert.equal(readyForInput(screen({ row: 1, col: 2, visible: true }, "header", "❯ Try \"fix the bug\"")), true);
  assert.equal(readyForInput(screen({ row: 0, col: 2, visible: true }, "❯ ")), true);
});

// The backstop: pupptyeer 0.8.0 defaults an absent cursor to visible:false, so
// the cursor signal must abstain and readiness falls back to hasInputPrompt.
test("readyForInput: a not-visible cursor abstains (falls back to text)", () => {
  const s = screen({ row: 0, col: 2, visible: false }, "❯ Try \"x\"");
  assert.equal(readyForInput(s), false, "cursor signal should abstain when not visible");
  assert.equal(hasInputPrompt(s.lines), true, "text fallback should still see the prompt");
});

test("readyForInput: cursor on a numbered menu option is not ready", () => {
  assert.equal(readyForInput(screen({ row: 0, col: 2, visible: true }, "❯ 1. Yes, I trust this folder", "  2. No")), false);
});

test("readyForInput: cursor row out of range is not ready", () => {
  assert.equal(readyForInput(screen({ row: 9, col: 0, visible: true }, "❯ ")), false);
});

test("hasInputPrompt: bare glyph and Try placeholder match; menu rows do not", () => {
  assert.equal(hasInputPrompt(["welcome", "❯ "]), true);
  assert.equal(hasInputPrompt(["❯ Try \"build a CLI\""]), true);
  assert.equal(hasInputPrompt(["❯ 1. Yes, I trust this folder"]), false);
  assert.equal(hasInputPrompt(["❯ Dark mode"]), false, "unnumbered selection option is not the input prompt");
  assert.equal(hasInputPrompt(["no prompt here"]), false);
});

// pickerOwnsInput is pinned against real screen captures driven against a
// live session on 2026-07-20 (see conformance/picker-screens/, copied
// from screens.json/screens2.json). Each fixture below reconstructs just
// enough of the captured grid to be faithful on what the predicate actually
// inspects: the exact text of every "❯"-prefixed row, and the cursor sitting
// at the exact row the capture recorded. Everything else on the real screen
// (the welcome box, separators, footer) is blank filler here, since none of
// it starts with "❯" and so never affects the result either way.
//
// screens.json's own `lines` arrays were filtered of blank lines before being
// saved, so a capture's cursor.row does not index into them directly;
// screens2.json (states 6 and 7) kept the raw, unfiltered grid, where it
// does. Each test below asserts `lines[cursor.row]` equals the row the
// capture says the cursor sat on, so a misaligned fixture fails loudly here
// instead of silently asserting the wrong thing.

test("pickerOwnsInput: state 1 (idle input box) is not a picker", () => {
  // Live, empty input box; cursor visible right on the bare "❯" row.
  const cursor = { row: 15, col: 2, visible: true };
  const lines = new Array(16).fill("");
  lines[15] = "❯ ";
  assert.equal(lines[cursor.row], "❯ ", "cursor should sit on the live input row");
  assert.equal(pickerOwnsInput(screen(cursor, ...lines)), false);
});

test("pickerOwnsInput: state 2 (staged numbered text) is not a picker", () => {
  // Typed but not submitted: "1. Fix the login bug" sits on the live input
  // row, cursor parked right on it. This is exactly the false positive the
  // lines-only predicate produced - the row is excluded here because it is
  // the cursor's own row, not because of anything about its text.
  const cursor = { row: 15, col: 22, visible: true };
  const lines = new Array(16).fill("");
  lines[15] = "❯ 1. Fix the login bug";
  assert.equal(lines[cursor.row], "❯ 1. Fix the login bug", "cursor should sit on the staged text row");
  assert.equal(pickerOwnsInput(screen(cursor, ...lines)), false);
});

test("pickerOwnsInput: state 3 (after clear) is not a picker", () => {
  // Back to an empty live input row after Ctrl+U/clear - same shape as state 1.
  const cursor = { row: 15, col: 2, visible: true };
  const lines = new Array(16).fill("");
  lines[15] = "❯ ";
  assert.equal(lines[cursor.row], "❯ ", "cursor should sit on the live input row");
  assert.equal(pickerOwnsInput(screen(cursor, ...lines)), false);
});

test("pickerOwnsInput: state 4 (after submitting a numbered list) is not a picker", () => {
  // The submitted "❯ 1. Reply with only the word alpha" stays in scrollback
  // forever; the live input row below it (where the cursor now sits) is
  // back to bare. Getting this wrong is the catastrophic case the lines-only
  // predicate produced: every later sendPrompt from a user who ever sent a
  // numbered list would be refused, permanently.
  const cursor = { row: 20, col: 2, visible: true };
  const lines = new Array(21).fill("");
  lines[12] = "❯ 1. Reply with only the word alpha"; // scrollback echo, not under the cursor
  lines[20] = "❯ "; // live, empty input row
  assert.equal(lines[cursor.row], "❯ ", "cursor should sit on the live input row, not the scrollback echo");
  assert.equal(pickerOwnsInput(screen(cursor, ...lines)), false);
});

test("pickerOwnsInput: state 5 (AskUserQuestion picker open) is a picker", () => {
  // A real picker: cursor.visible is false (no live input row to sit on at
  // all), and the highlighted option renders as "❯ 1. Red" - a numbered "❯"
  // row that (trivially, since there is no visible cursor) is not the
  // cursor's row. The still-present scrollback echo from the earlier
  // numbered send doesn't change the answer either way.
  // cursor.row is irrelevant here: readyForInput/pickerOwnsInput never read
  // it once cursor.visible is false, so the real capture's row (25) isn't
  // reproduced against this trimmed fixture.
  const cursor = { row: 0, col: 0, visible: false };
  const lines = [
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
  ];
  assert.equal(pickerOwnsInput(screen(cursor, ...lines)), true);
});

test("pickerOwnsInput: state 6 (mid-turn, busy) is not a picker", () => {
  // The live empty input row is present (and the cursor visible on it) while
  // claude works; queuing a follow-up mid-turn is legitimate and must not be
  // refused.
  const cursor = { row: 33, col: 2, visible: true };
  const lines = new Array(34).fill("");
  lines[33] = "❯ ";
  assert.equal(lines[cursor.row], "❯ ", "cursor should sit on the live input row");
  assert.equal(pickerOwnsInput(screen(cursor, ...lines)), false);
});

test("pickerOwnsInput: state 7 (tool-permission prompt) is not a picker - already resolved by the time it was captured", () => {
  // This capture contradicts the plan's expectation that a tool-permission
  // capture would classify as a picker. What it actually shows: auto mode had
  // already approved "echo hello" (footer reads "auto mode on") and the
  // command had already run and printed its result before the screen
  // settled enough to capture, so there is no numbered accept/deny row left
  // on screen at all - only the resolved command's own header line and a
  // second, unrelated prompt ("Count numbers one to forty") staged but not
  // yet submitted, cursor parked right on it. That staged row is not a
  // numbered menu option, so it does not even need the cursor-exclusion rule
  // to be cleared: readyForInput alone is already true here. This is the
  // capture-races-the-modal case the design doc calls out (a picker with no
  // output settles instantly; here the auto-approval plus its own output was
  // the thing that settled first).
  const cursor = { row: 35, col: 2, visible: true };
  const lines = new Array(36).fill("");
  lines[27] = "❯ Run the shell command: echo hello"; // resolved tool call's own header, not numbered
  lines[35] = "❯  Count numbers one to forty"; // staged, not-yet-submitted next prompt
  assert.equal(lines[cursor.row], "❯  Count numbers one to forty", "cursor should sit on the staged prompt row");
  assert.equal(pickerOwnsInput(screen(cursor, ...lines)), false);
});

test("hasStylePicker: dark+light option pair only", () => {
  assert.equal(hasStylePicker("choose the text style\n❯ dark mode\n  light mode"), true);
  assert.equal(hasStylePicker("switched to dark mode"), false);
  assert.equal(hasStylePicker("❯ try something"), false);
});

test("classifyStartupFailure: recognizes the interactive block surfaces", () => {
  assert.equal(classifyStartupFailure("Welcome back\n❯ "), null, "a benign prompt is not a failure");
  assert.equal(classifyStartupFailure("❯ \nfailed to authenticate"), "auth_blocked");
  assert.equal(classifyStartupFailure("API Error: 403 Forbidden"), "auth_blocked");
  assert.equal(classifyStartupFailure("Please run /login to continue"), "auth_blocked");
  assert.equal(classifyStartupFailure("You've hit your limit"), "rate_limit");
  assert.equal(classifyStartupFailure("You are approaching usage limit"), "rate_limit");
  assert.equal(classifyStartupFailure("Detected a custom API key in your environment"), "custom_api_key_detected");
  assert.equal(classifyStartupFailure("Do you trust the files in this folder?"), "workspace_trust_blocked");
  assert.equal(classifyStartupFailure("Permission required: allow or deny this action?"), "tool_approval_blocked");
});

test("classifyStartupFailure: is case-insensitive over a raw grid join", () => {
  assert.equal(classifyStartupFailure("FAILED TO AUTHENTICATE"), "auth_blocked");
});

test("isHardStartupFailure: only the surfaces the harness can't drive past", () => {
  assert.equal(isHardStartupFailure("auth_blocked"), true);
  assert.equal(isHardStartupFailure("rate_limit"), true);
  assert.equal(isHardStartupFailure("custom_api_key_detected"), true);
  assert.equal(isHardStartupFailure("workspace_trust_blocked"), false);
  assert.equal(isHardStartupFailure("tool_approval_blocked"), false);
  assert.equal(isHardStartupFailure("startup_timeout"), false);
});
