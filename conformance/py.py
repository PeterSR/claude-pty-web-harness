#!/usr/bin/env python3
"""Conformance runner (Python) - implements conformance/scenario.md: load
every case in conformance/cases/, run it through this language's actual
implementation, and byte-compare the result against the shared `expect`.
Imports claude_pty_web_harness directly (the editable install in
packages/python/.venv), so this always exercises the real, current
implementation."""
import base64
import json
import os
import sys

from claude_pty_web_harness.blob import hash_image_bytes
from claude_pty_web_harness.detect import (
    classify_startup_failure,
    has_input_prompt,
    has_style_picker,
    is_hard_startup_failure,
    ready_for_input,
)
from claude_pty_web_harness.jsonl import parse_entry
from claude_pty_web_harness._pupptyeer import Cursor, Screen

HERE = os.path.dirname(os.path.abspath(__file__))
CASES_DIR = os.path.join(HERE, "cases")

# Every jsonl case is run with the same stub image sink: it never touches the
# real hash (that's what the "blob" module cases pin), it just proves the
# wiring - an image block gets *some* blob_id embedded rather than vanishing
# or leaking raw base64.
STUB_BLOB_ID = "stub-blob-id"


def canon(value):
    """Canonical JSON: object keys sorted recursively, so the comparison below
    is a genuine byte-level string compare rather than a shape-approximate
    deep equal that might tolerate a missing/extra/reordered key."""
    if isinstance(value, list):
        return "[" + ",".join(canon(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        return "{" + ",".join(json.dumps(k) + ":" + canon(value[k]) for k in keys) + "}"
    return json.dumps(value)


def screen_from_input(inp):
    cursor = None
    if inp.get("cursor") is not None:
        c = inp["cursor"]
        cursor = Cursor(c["row"], c["col"], c["visible"])
    lines = inp["lines"]
    return Screen(cols=80, rows=len(lines), lines=list(lines), cursor=cursor, alt_screen=False)


def run(kase):
    mod = kase["module"]
    fn = kase["fn"]
    inp = kase["input"]

    if mod == "jsonl":
        if fn == "parseEntry":
            return parse_entry(inp["entry"], inp["lineNo"], lambda data, media_type: STUB_BLOB_ID)
        raise ValueError(f"unknown jsonl fn: {fn}")

    if mod == "detect":
        if fn == "readyForInput":
            return ready_for_input(screen_from_input(inp))
        if fn == "hasInputPrompt":
            return has_input_prompt(inp["lines"])
        if fn == "classifyStartupFailure":
            return classify_startup_failure(inp["text"])
        if fn == "isHardStartupFailure":
            return is_hard_startup_failure(inp["failure"])
        if fn == "hasStylePicker":
            return has_style_picker(inp["text"])
        raise ValueError(f"unknown detect fn: {fn}")

    if mod == "blob":
        if fn == "hashImageBytes":
            return hash_image_bytes(base64.b64decode(inp["base64"]))
        raise ValueError(f"unknown blob fn: {fn}")

    raise ValueError(f"unknown module: {mod}")


def main():
    files = sorted(f for f in os.listdir(CASES_DIR) if f.endswith(".json"))
    failed = False

    for file in files:
        with open(os.path.join(CASES_DIR, file), "r", encoding="utf-8") as fh:
            kase = json.load(fh)
        try:
            got = run(kase)
        except Exception as err:  # noqa: BLE001
            print(f"FAIL[python] {kase['name']}: threw {err}", file=sys.stderr)
            failed = True
            continue
        got_canon = canon(got)
        want_canon = canon(kase["expect"])
        if got_canon != want_canon:
            print(f"FAIL[python] {kase['name']}: expected {want_canon}, got {got_canon}", file=sys.stderr)
            failed = True

    if failed:
        sys.exit(1)
    print(f"OK python ({len(files)} cases)")


if __name__ == "__main__":
    main()
