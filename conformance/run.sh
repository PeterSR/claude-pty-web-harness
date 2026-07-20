#!/usr/bin/env bash
# Cross-language conformance: run the same golden corpus (conformance/cases/)
# through both the TS and Python implementations of parseEntry/detect/the
# image-blob hash. Modeled on pupptyeer's conformance/run.sh, but simpler:
# the modules under test here (jsonl, detect, blob) are pure functions with no
# daemon or process to drive, so this just runs both languages against the
# same JSON fixtures and byte-compares the results. A failure in either
# language is a parity break. Exit non-zero if either fails.
set -u
cd "$(dirname "$0")/.."

fail=0

echo "running conformance against conformance/cases/"

run() {
  local name="$1"; shift
  if "$@"; then echo "  PASS $name"; else echo "  FAIL $name"; fail=1; fi
}

# Local dev manages the Python env with uv (see Makefile); CI installs
# claude_pty_web_harness with plain pip into the runner's own Python (see
# .github/workflows/ci.yml), with no uv involved. Prefer uv when present,
# otherwise fall back to whatever `python3` already has the package installed.
PYTHON_RUNNER="python3 ../../conformance/py.py"
if command -v uv >/dev/null 2>&1; then
  PYTHON_RUNNER="uv run python ../../conformance/py.py"
fi

run ts     npx tsx conformance/ts.mjs
run python bash -c "cd packages/python && $PYTHON_RUNNER"

if [ "$fail" -eq 0 ]; then
  echo "conformance: ALL LANGUAGES PASS"
else
  echo "conformance: PARITY BREAK - see failures above"
fi
exit $fail
