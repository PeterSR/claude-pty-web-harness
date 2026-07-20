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

from claude_pty_web_harness.blob import decode_image, hash_image_bytes
from claude_pty_web_harness.detect import (
    classify_startup_failure,
    has_input_prompt,
    has_style_picker,
    is_hard_startup_failure,
    picker_owns_input,
    ready_for_input,
)
from claude_pty_web_harness.jsonl import parse_entry
from claude_pty_web_harness._pupptyeer import Cursor, Screen

HERE = os.path.dirname(os.path.abspath(__file__))
CASES_DIR = os.path.join(HERE, "cases")

# Every jsonl case is run with the same stub image sink: a fixed
# (blob_id, bytes) regardless of input, never attempting to decode the given
# base64 at all. Both hash correctness (the "blob" module's job, pinned by
# its own golden-vector cases) and decode-byte-count correctness are
# deliberately out of scope here - this stub exists only to prove parse_entry
# wires the sink correctly and reports back exactly what it returns, nothing
# recomputed independently. Cases that need the real decode opt in with
# "sink": "real" (see _real_image_sink); those are what prove both ports
# accept and reject the same payloads.
STUB_BLOB_ID = "stub-blob-id"
STUB_BYTES = 999999


def _stub_image_sink(data, media_type):
    return STUB_BLOB_ID, STUB_BYTES


def _real_image_sink(data, media_type):
    """The stub above is right for proving wiring, but a corpus built only on
    it is blind to the one thing that actually crosses the language boundary
    here: whether both ports' decoders accept and reject the same payloads. A
    case with "sink": "real" runs parse_entry against the production decode
    instead, so a divergence shows up as a different ContentPart type rather
    than hiding behind a fixed stub value."""
    blob_id, raw = decode_image(data)
    return blob_id, len(raw)


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
            sink = _real_image_sink if kase.get("sink") == "real" else _stub_image_sink
            return parse_entry(inp["entry"], inp["lineNo"], sink)
        raise ValueError(f"unknown jsonl fn: {fn}")

    if mod == "detect":
        if fn == "readyForInput":
            return ready_for_input(screen_from_input(inp))
        if fn == "hasInputPrompt":
            return has_input_prompt(inp["lines"])
        if fn == "pickerOwnsInput":
            return picker_owns_input(screen_from_input(inp))
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
        if fn == "decodeImage":
            blob_id, raw = decode_image(inp["base64"])
            return {"blobId": blob_id, "bytes": len(raw)}
        raise ValueError(f"unknown blob fn: {fn}")

    raise ValueError(f"unknown module: {mod}")


def _list_case_files(directory):
    """Recurse into subdirectories (cases/generated/ holds the fuzz corpus -
    see generate.mjs) so both hand-written and generated cases run the same
    way."""
    out = []
    for entry in sorted(os.listdir(directory)):
        full = os.path.join(directory, entry)
        if os.path.isdir(full):
            out.extend(_list_case_files(full))
        elif entry.endswith(".json"):
            out.append(full)
    return out


def main():
    files = _list_case_files(CASES_DIR)
    failed = False

    for file in files:
        with open(file, "r", encoding="utf-8") as fh:
            kase = json.load(fh)
        # `"expect": {"throws": true}` pins rejection itself as the contract,
        # so both ports must refuse the same inputs rather than one raising
        # and the other quietly returning something.
        wants_throw = isinstance(kase.get("expect"), dict) and kase["expect"].get("throws") is True
        try:
            got = run(kase)
        except Exception as err:  # noqa: BLE001
            if wants_throw:
                continue
            print(f"FAIL[python] {kase['name']}: threw {err}", file=sys.stderr)
            failed = True
            continue
        if wants_throw:
            print(f"FAIL[python] {kase['name']}: expected a throw, got {canon(got)}", file=sys.stderr)
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
