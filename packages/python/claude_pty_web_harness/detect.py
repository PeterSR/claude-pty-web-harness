"""Detection predicates over a rendered screen (the daemon's captureScreen
grid, lines with real spacing). Mirrors detect.ts."""
from __future__ import annotations

from typing import List, Optional

from ._pupptyeer import Screen

PROMPT = "❯"  # the input prompt char


def ready_for_input(screen: Screen) -> bool:
    """Primary readiness signal, grounded in claude's own cursor placement
    rather than the variable placeholder text: when the input box is live and
    focused, claude parks the visible editing cursor on the row that starts
    with the "<prompt>" glyph (on top of the dimmed "Try ..." placeholder, if
    any). Menu rows like "<prompt> 1. Yes, I trust this folder" are excluded so
    the trust modal's preselected option never reads as ready.

    This ignores what the placeholder says or whether it lingers (it fades
    after ~1s on some setups but persists on others). Ported from claude-p's
    ReadyForInput; has_input_prompt is the text-only fallback for frames that
    don't report a trustworthy cursor."""
    cur = screen.cursor
    if cur is None or not cur.visible:
        return False
    if cur.row < 0 or cur.row >= len(screen.lines):
        return False
    rem = _prompt_row_remainder(screen.lines[cur.row])
    return rem is not None and not _looks_like_menu_option(rem)


def has_input_prompt(lines: List[str]) -> bool:
    """Text-only fallback for ready_for_input, used when the captured cursor
    can't be trusted. True when any row looks like the main input prompt: a
    lone prompt char, or a "<prompt> Try ..." placeholder. Menu rows like
    "<prompt> 1. No" don't match (they have option text after the char)."""
    for line in lines:
        rem = _prompt_row_remainder(line)
        if rem is None or _looks_like_menu_option(rem):
            continue
        if rem == "" or rem.startswith("Try "):
            return True
    return False


def _prompt_row_remainder(line: str) -> Optional[str]:
    """If `line` begins with the "<prompt>" glyph, return what follows it
    (stripped); otherwise None for a non-prompt row."""
    t = line.strip()
    if not t.startswith(PROMPT):
        return None
    return t[len(PROMPT):].strip()


def _looks_like_menu_option(s: str) -> bool:
    """True for a numbered menu choice ("1. Yes", "2. No, exit"): digits, dot."""
    i = 0
    while i < len(s) and "0" <= s[i] <= "9":
        i += 1
    return i > 0 and i < len(s) and s[i] == "."


def has_bypass_warning(text: str) -> bool:
    """The "Bypass Permissions mode" warning modal (must pick "Yes, I accept")."""
    return "bypass permissions mode" in text and "yes, i accept" in text


def has_trust_modal(text: str) -> bool:
    """The "Do you trust the files in this folder?" modal (default option = yes)."""
    return "trust the files" in text or "do you trust" in text or "trust this folder" in text


def has_style_picker(text: str) -> bool:
    """Claude's first-run text-style picker lists theme options whose
    highlighted row is pointed at by "<prompt>". That row is a menu selection,
    not the input prompt, but ready_for_input can't tell an unnumbered option
    apart from real input, so it must be dismissed explicitly. Detected by the
    dark/light mode option pair (they only co-occur here); Enter accepts the
    auto-detected default."""
    return "dark mode" in text and "light mode" in text


def is_ready_footer(text: str) -> bool:
    """Idle footer marker once claude is past startup and ready for input."""
    return "bypass permissions on" in text or "? for shortcuts" in text


# Terminal surfaces the harness can never drive past (unlike the trust /
# tool-approval modals it handles), so seeing one means fail fast.
_HARD_STARTUP_FAILURES = frozenset(
    {"auth_blocked", "rate_limit", "custom_api_key_detected"}
)


def classify_startup_failure(text: str) -> Optional[str]:
    """A recognizable interactive failure surface, or None. Ported from
    claude-p's ClassifyInteractiveFailure: when the input prompt never appears,
    report *why* (an auth wall, a usage limit, an unaccepted trust/permission
    modal, or a custom-API-key prompt) instead of a blind timeout. Cheap
    substring checks; the input is lower-cased internally so callers can pass a
    raw grid join. Returns a StartupFailure value."""
    low = text.lower()
    if (
        "failed to authenticate" in low
        or "api error: 403" in low
        or "please run /login" in low
    ):
        return "auth_blocked"
    if (
        "hit your limit" in low
        or "approaching usage limit" in low
        or "5-hour limit" in low
    ):
        return "rate_limit"
    # Claude pauses on a "Detected a custom API key ... use this API key?" modal
    # when it sees ANTHROPIC_API_KEY/AUTH_TOKEN in the env and the user chose to
    # be asked. Surface it so the caller can strip the env or accept the modal.
    if "detected a custom api key" in low:
        return "custom_api_key_detected"
    if "do you trust" in low and "folder" in low:
        return "workspace_trust_blocked"
    if "permission" in low and ("allow" in low or "deny" in low):
        return "tool_approval_blocked"
    return None


def is_hard_startup_failure(failure: str) -> bool:
    """True for a failure that is terminal the moment it shows during startup."""
    return failure in _HARD_STARTUP_FAILURES
