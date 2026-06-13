# claude-pty-harness (Python backend)

A Python parity of the backend: drive Claude Code in a pupptyeer pty and stream
its JSONL transcript over the **same HTTP/WS protocol** as the TS server, so the
existing React frontend (`packages/app`) works against it unchanged.

Mirrors the TS packages:

| Python module | TS equivalent | Role |
|---|---|---|
| `claude_pty_harness.protocol` | `@…/protocol` | wire types (ChatEvent, summaries, messages) |
| `claude_pty_harness.harness` (`ClaudeHarness`) | `@…/core` | transport-agnostic logic (pupptyeer + JSONL + daemon-rendered modal/readiness detection) |
| `claude_pty_harness.{detect,jsonl,daemon}` | `core/src/*` | supporting modules |
| `claude_pty_harness.server` | `@…/server` | reference FastAPI + WebSocket adapter |

It wraps the stdlib-only pupptyeer Python client
(`pupptyeer/clients/python/pupptyeer_client.py`). That file isn't on PyPI,
so it's imported by path; override the location with `PUPPTYEER_PY_CLIENT`.

The pupptyeer client is synchronous (background reader thread); the harness is
asyncio and runs its request/reply calls in a thread executor so the FastAPI
event loop never blocks.

## Run

```bash
cd packages/python
uv venv && uv pip install -e .
PORT=4318 uv run uvicorn claude_pty_harness.server:app
# or: PORT=4318 uv run python -m claude_pty_harness.server
```

It serves the identical API on `:4318`, so `npm run dev:app` (the React app,
Vite proxy to `:4318`) talks to it with no changes. Run **either** the TS server
or this one, not both (same port).

Env: `PORT`, `HOST`, `PUPPTYEER_BIN` (defaults to the sibling
`../pupptyeer/bin/pupptyeer`), `PUPPTYEER_SOCK`, `READINESS=delay`
(fallback for daemons without working capture), `PUPPTYEER_PY_CLIENT`.

## Reusing the core (any transport)

```python
from claude_pty_harness import ClaudeHarness

harness = await ClaudeHarness.create(pupptyeer_bin="/path/to/pupptyeer")
remove = harness.add_listener(lambda kind, sid, payload: ...)  # "chat" | "status"
summary = await harness.create_session(cwd="/repo", model="sonnet")
await harness.send_prompt(summary["id"], "hello")
# also: harness.list(), harness.get(id), harness.transcript(id),
#       harness.interrupt(id), await harness.kill(id)
```

`create_session` also takes `command`, `permission_mode`, and `extra_args`.

## Requires

A pupptyeer daemon built at commit `e667d9b` or later (the fix where capturing a
live claude session no longer wedges it). Restart a long-running daemon so it
loads the new binary, else `captureScreen` returns an empty grid and readiness
never fires (chat still works via JSONL); or run with `READINESS=delay`.
