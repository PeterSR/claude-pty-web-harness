// Detection predicates over a rendered screen. The grid (lines with real
// spacing) comes from the pupptyeer daemon's captureScreen, so there is no
// terminal emulation to do here, just substring/line checks.

const PROMPT = "❯"; // ❯

/**
 * True when the screen shows claude's main input prompt: a "❯" alone on a line,
 * or "❯ Try ..." placeholder. Menu rows like "❯ 1. No, exit" are excluded.
 */
export function hasInputPrompt(lines: string[]): boolean {
  for (const line of lines) {
    const t = line.trim();
    if (t === PROMPT) return true;
    if (t.startsWith(`${PROMPT} Try `)) return true;
  }
  return false;
}

/** The "Bypass Permissions mode" warning modal (must select "Yes, I accept"). */
export function hasBypassWarning(text: string): boolean {
  return text.includes("bypass permissions mode") && text.includes("yes, i accept");
}

/** The "Do you trust the files in this folder?" modal (default option = yes). */
export function hasTrustModal(text: string): boolean {
  return text.includes("trust the files") || text.includes("do you trust") || text.includes("trust this folder");
}

/** Idle footer marker once claude is past startup and ready for input. */
export function isReadyFooter(text: string): boolean {
  return text.includes("bypass permissions on") || text.includes("? for shortcuts");
}
