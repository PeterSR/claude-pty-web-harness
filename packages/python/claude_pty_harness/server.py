"""Reference FastAPI + WebSocket adapter exposing a ClaudeHarness over the same
HTTP/WS protocol as the TS server, so the React frontend works unchanged.

Run:  PORT=4318 uvicorn claude_pty_harness.server:app
  or:  python -m claude_pty_harness.server
"""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from .harness import ClaudeHarness


def _default_bin() -> str:
    # pupptyeer isn't on PATH in this monorepo; default to the sibling build.
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "..", "..", "..", "pty-supervisor", "bin", "pupptyeer"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    readiness = "delay" if os.environ.get("READINESS") == "delay" else "screen"
    pupptyeer_bin = os.environ.get("PUPPTYEER_BIN") or _default_bin()
    app.state.harness = await ClaudeHarness.create(pupptyeer_bin=pupptyeer_bin, readiness=readiness)
    yield


app = FastAPI(lifespan=lifespan)


def _h(request: Request) -> ClaudeHarness:
    return request.app.state.harness


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/sessions")
async def list_sessions(request: Request):
    return _h(request).list()


@app.post("/api/sessions")
async def create_session(request: Request):
    body = await request.json()
    cwd = (body.get("cwd") or "").strip()
    if not cwd:
        return JSONResponse({"error": "cwd is required"}, status_code=400)
    try:
        return await _h(request).create_session(cwd=cwd, model=body.get("model") or None)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str, request: Request):
    s = _h(request).get(session_id)
    if not s:
        return JSONResponse({"error": "not found"}, status_code=404)
    return s


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str, request: Request):
    await _h(request).kill(session_id)
    return {"ok": True}


@app.post("/api/sessions/{session_id}/prompt")
async def prompt(session_id: str, request: Request):
    body = await request.json()
    if not body.get("text"):
        return JSONResponse({"error": "text is required"}, status_code=400)
    try:
        await _h(request).send_prompt(session_id, body["text"])
        return {"ok": True}
    except KeyError:
        return JSONResponse({"error": "unknown session"}, status_code=404)


@app.websocket("/api/sessions/{session_id}/stream")
async def stream(ws: WebSocket, session_id: str):
    await ws.accept()
    harness: ClaudeHarness = ws.app.state.harness
    summary = harness.get(session_id)
    if not summary:
        await ws.send_json({"type": "error", "message": "unknown session"})
        await ws.close()
        return

    queue: asyncio.Queue = asyncio.Queue()

    def on_event(kind: str, sid: str, payload):
        if sid != session_id:
            return
        if kind == "chat":
            queue.put_nowait({"type": "chat", "event": payload})
        elif kind == "status":
            queue.put_nowait({"type": "status", "status": payload})

    remove = harness.add_listener(on_event)

    # Replay status + transcript so a fresh/reconnecting client catches up.
    await ws.send_json({"type": "status", "status": summary["status"]})
    for ev in harness.transcript(session_id):
        await ws.send_json({"type": "chat", "event": ev})

    async def outbound():
        while True:
            await ws.send_json(await queue.get())

    async def inbound():
        while True:
            data = await ws.receive_json()
            t = data.get("type")
            if t == "prompt":
                asyncio.create_task(harness.send_prompt(session_id, data.get("text", "")))
            elif t == "interrupt":
                harness.interrupt(session_id)

    out_task = asyncio.create_task(outbound())
    in_task = asyncio.create_task(inbound())
    try:
        await asyncio.wait({out_task, in_task}, return_when=asyncio.FIRST_COMPLETED)
    except WebSocketDisconnect:
        pass
    finally:
        remove()
        out_task.cancel()
        in_task.cancel()


def main():
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "4318")),
    )


if __name__ == "__main__":
    main()
