// Detection predicates over a rendered screen. The grid (lines with real
// spacing) comes from the pupptyeer daemon's captureScreen, so there is no
// terminal emulation to do here, just substring/line checks.

import type { Screen } from "pupptyeer-client";
import type { StartupFailure } from "@petersr/claude-pty-web-harness-protocol";

const PROMPT = "❯"; // ❯

/**
 * Primary readiness signal, grounded in claude's own cursor placement rather
 * than the variable placeholder text: when the input box is live and focused,
 * claude parks the visible editing cursor on the row that starts with the "❯"
 * prompt glyph (sitting on top of the dimmed "Try …" placeholder, if any).
 * Menu rows like "❯ 1. Yes, I trust this folder" are excluded so the trust
 * modal's preselected option never reads as ready.
 *
 * This deliberately ignores what the placeholder says or whether it lingers
 * (it fades after ~1s on some setups but persists on others), so detection no
 * longer depends on claude's example-prompt wording. Ported from claude-p's
 * ReadyForInput; hasInputPrompt is the text-only fallback for backends/frames
 * that don't report a trustworthy cursor.
 */
export function readyForInput(screen: Screen): boolean {
  const { cursor, lines } = screen;
  if (!cursor || !cursor.visible) return false;
  if (cursor.row < 0 || cursor.row >= lines.length) return false;
  const rem = promptRowRemainder(lines[cursor.row]);
  return rem !== null && !looksLikeMenuOption(rem);
}

/**
 * Text-only fallback for readyForInput, used when the captured cursor can't be
 * trusted. True when any row looks like claude's main input prompt: a "❯"
 * followed by nothing or just a placeholder suggestion ("Try ..."). Menu rows
 * like "❯ 1. No, exit" are excluded; they have option text after the glyph.
 */
export function hasInputPrompt(lines: string[]): boolean {
  for (const line of lines) {
    const rem = promptRowRemainder(line);
    if (rem === null || looksLikeMenuOption(rem)) continue;
    if (rem === "" || rem.startsWith("Try ")) return true;
  }
  return false;
}

/**
 * If `line` begins with the "❯" prompt glyph, return whatever follows it
 * (trimmed); otherwise null for a non-prompt row.
 */
function promptRowRemainder(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(PROMPT)) return null;
  return trimmed.slice(PROMPT.length).trim();
}

/** True for a numbered menu choice ("1. Yes", "2. No, exit"): digits then a dot. */
function looksLikeMenuOption(s: string): boolean {
  let i = 0;
  while (i < s.length && s[i] >= "0" && s[i] <= "9") i++;
  return i > 0 && i < s.length && s[i] === ".";
}

/** The "Bypass Permissions mode" warning modal (must select "Yes, I accept"). */
export function hasBypassWarning(text: string): boolean {
  return text.includes("bypass permissions mode") && text.includes("yes, i accept");
}

/** The "Do you trust the files in this folder?" modal (default option = yes). */
export function hasTrustModal(text: string): boolean {
  return text.includes("trust the files") || text.includes("do you trust") || text.includes("trust this folder");
}

/**
 * Claude's first-run text-style picker ("Choose the text style ...") lists theme
 * options whose highlighted row is pointed at by "❯". That row is a menu
 * selection, not the input prompt, but readyForInput can't tell an unnumbered
 * option apart from real input, so it must be dismissed explicitly. Detected by
 * the dark/light mode option pair, which only co-occur on this screen; Enter
 * accepts the auto-detected default.
 */
export function hasStylePicker(text: string): boolean {
  return text.includes("dark mode") && text.includes("light mode");
}

/** Idle footer marker once claude is past startup and ready for input. */
export function isReadyFooter(text: string): boolean {
  return text.includes("bypass permissions on") || text.includes("? for shortcuts");
}

/**
 * A recognizable interactive failure surface, or null. Ported from claude-p's
 * ClassifyInteractiveFailure: when the input prompt never appears, this reports
 * *why* (an auth wall, a usage limit, an unaccepted trust/permission modal, or
 * a custom-API-key prompt) instead of leaving the caller with a blind timeout.
 * Cheap substring checks over the rendered screen; the input is lower-cased
 * internally so callers can pass a raw grid join.
 */
export function classifyStartupFailure(text: string): StartupFailure | null {
  const low = text.toLowerCase();
  if (low.includes("failed to authenticate") || low.includes("api error: 403") || low.includes("please run /login")) {
    return "auth_blocked";
  }
  if (low.includes("hit your limit") || low.includes("approaching usage limit") || low.includes("5-hour limit")) {
    return "rate_limit";
  }
  // Claude pauses on a "Detected a custom API key ... use this API key?" modal
  // when it sees ANTHROPIC_API_KEY/AUTH_TOKEN in the env and the user chose to
  // be asked. Surface it so the caller can strip the env or accept the modal.
  if (low.includes("detected a custom api key")) return "custom_api_key_detected";
  if (low.includes("do you trust") && low.includes("folder")) return "workspace_trust_blocked";
  if (low.includes("permission") && (low.includes("allow") || low.includes("deny"))) {
    return "tool_approval_blocked";
  }
  return null;
}

/**
 * The subset of failure surfaces that are terminal the moment they appear
 * during startup: the harness never produces them itself (unlike the trust /
 * tool-approval modals it drives), so seeing one means fail fast rather than
 * waiting out the readiness deadline.
 */
export function isHardStartupFailure(failure: StartupFailure): boolean {
  return failure === "auth_blocked" || failure === "rate_limit" || failure === "custom_api_key_detected";
}
