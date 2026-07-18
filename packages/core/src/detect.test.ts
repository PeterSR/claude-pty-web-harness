// Run with: npx tsx --test src/detect.test.ts  (no extra test deps; uses node:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Screen } from "pupptyeer-client";
import { readyForInput, hasInputPrompt, hasStylePicker, classifyStartupFailure, isHardStartupFailure } from "./detect.js";

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
