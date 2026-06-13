"""Detection predicates over a rendered screen (the daemon's captureScreen
grid, lines with real spacing). Mirrors detect.ts."""
from __future__ import annotations

from typing import List

PROMPT = "❯"  # the input prompt char


def has_input_prompt(lines: List[str]) -> bool:
    """True when claude's main input prompt is on screen: a lone prompt char,
    or a "<prompt> Try ..." placeholder. Menu rows like "<prompt> 1. No" don't
    match (they have text other than 'Try ' after the char)."""
    for line in lines:
        t = line.strip()
        if t == PROMPT:
            return True
        if t.startswith(f"{PROMPT} Try "):
            return True
    return False


def has_bypass_warning(text: str) -> bool:
    """The "Bypass Permissions mode" warning modal (must pick "Yes, I accept")."""
    return "bypass permissions mode" in text and "yes, i accept" in text


def has_trust_modal(text: str) -> bool:
    """The "Do you trust the files in this folder?" modal (default option = yes)."""
    return "trust the files" in text or "do you trust" in text or "trust this folder" in text


def is_ready_footer(text: str) -> bool:
    """Idle footer marker once claude is past startup and ready for input."""
    return "bypass permissions on" in text or "? for shortcuts" in text
