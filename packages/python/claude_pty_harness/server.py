"""Reference FastAPI + WebSocket adapter exposing a ClaudeHarness over the same
HTTP/WS protocol as the TS server, so the React frontend works unchanged.

Two ways to use it:

  * Standalone, for local dev:
      PORT=4318 uvicorn claude_pty_harness.server:app
      python -m claude_pty_harness.server

  * Mounted into an existing FastAPI app (e.g. behind your own OIDC auth):
      from claude_pty_harness.server import include_harness_routes
      include_harness_routes(
          app,
          harness,
          dependencies=[Depends(validate_token)],   # guards the REST routes
          authenticate_ws=my_ws_ticket_check,        # guards the WS upgrade
      )

REST routes accept FastAPI `dependencies` so your auth runs on every call.
Browsers can't set an Authorization header on a WebSocket, so the WS route is
guarded separately by `authenticate_ws` (validate a short-lived ticket / query
token there). The harness itself stays transport-agnostic and unauthenticated;
auth lives here, at the edge.
"""
from __future__ import annotations

import asyncio
import inspect
import os
from contextlib import asynccontextmanager
from typing import Awaitable, Callable, Optional, Sequence, Union

from fastapi import APIRouter, Depends, FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from .harness import ClaudeHarness

# Either a live harness or a zero-arg callable that returns one (lets the
# standalone app defer creation to startup while still using create_router).
HarnessSource = Union[ClaudeHarness, Callable[[], ClaudeHarness]]
# Return falsy / raise to reject the WebSocket before it is accepted.
WsAuthenticator = Callable[[WebSocket], Union[bool, Awaitable[bool]]]


def _default_bin() -> str:
    # pupptyeer isn't on PATH in this monorepo; default to the sibling build.
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "..", "..", "..", "pupptyeer", "bin", "pupptyeer"))


def _resolver(source: HarnessSource) -> Callable[[], ClaudeHarness]:
    if isinstance(source, ClaudeHarness):
        return lambda: source
    return source  # already a callable


def create_router(
    harness: HarnessSource,
    *,
    prefix: str = "/api",
    dependencies: Optional[Sequence[Depends]] = None,
    authenticate_ws: Optional[WsAuthenticator] = None,
) -> APIRouter:
    """Build an APIRouter with the harness REST + WebSocket endpoints.

    `harness` may be a ClaudeHarness or a zero-arg callable returning one.
    `dependencies` are applied to every REST route (not the WebSocket).
    `authenticate_ws` guards the WebSocket upgrade.
    """
    get_harness = _resolver(harness)
    dep = list(dependencies or [])
    router = APIRouter()

    @router.get(f"{prefix}/health")
    async def health():
        # Unauthenticated on purpose: liveness probe.
        return {"ok": True}

    @router.get(f"{prefix}/sessions", dependencies=dep)
    async def list_sessions():
        return get_harness().list()

    @router.post(f"{prefix}/sessions", dependencies=dep)
    async def create_session(request: Request):
        body = await request.json()
        cwd = (body.get("cwd") or "").strip()
        if not cwd:
            return JSONResponse({"error": "cwd is required"}, status_code=400)
        try:
            return await get_harness().create_session(cwd=cwd, model=body.get("model") or None)
        except PermissionError as e:
            return JSONResponse({"error": str(e)}, status_code=403)
        except Exception as e:  # noqa: BLE001
            return JSONResponse({"error": str(e)}, status_code=500)

    @router.get(f"{prefix}/sessions/{{session_id}}", dependencies=dep)
    async def get_session(session_id: str):
        s = get_harness().get(session_id)
        if not s:
            return JSONResponse({"error": "not found"}, status_code=404)
        return s

    @router.delete(f"{prefix}/sessions/{{session_id}}", dependencies=dep)
    async def delete_session(session_id: str):
        await get_harness().kill(session_id)
        return {"ok": True}

    @router.post(f"{prefix}/sessions/{{session_id}}/prompt", dependencies=dep)
    async def prompt(session_id: str, request: Request):
        body = await request.json()
        if not body.get("text"):
            return JSONResponse({"error": "text is required"}, status_code=400)
        try:
            await get_harness().send_prompt(session_id, body["text"])
            return {"ok": True}
        except KeyError:
            return JSONResponse({"error": "unknown session"}, status_code=404)

    @router.websocket(f"{prefix}/sessions/{{session_id}}/stream")
    async def stream(ws: WebSocket, session_id: str):
        if authenticate_ws is not None:
            try:
                result = authenticate_ws(ws)
                ok = await result if inspect.isawaitable(result) else result
            except Exception:
                ok = False
            if not ok:
                await ws.close(code=1008)  # policy violation
                return

        harness = get_harness()
        summary = harness.get(session_id)
        if not summary:
            await ws.accept()
            await ws.send_json({"type": "error", "message": "unknown session"})
            await ws.close()
            return

        await ws.accept()
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

    return router


def include_harness_routes(
    app: FastAPI,
    harness: HarnessSource,
    *,
    prefix: str = "/api",
    dependencies: Optional[Sequence[Depends]] = None,
    authenticate_ws: Optional[WsAuthenticator] = None,
) -> None:
    """Mount the harness routes onto an existing FastAPI app (or any router-host).

    Mirrors the TS `registerHarnessRoutes`. Pass `dependencies` to guard the
    REST routes with your own auth (e.g. `[Depends(validate_token)]`) and
    `authenticate_ws` to guard the WebSocket upgrade.
    """
    app.include_router(
        create_router(harness, prefix=prefix, dependencies=dependencies, authenticate_ws=authenticate_ws)
    )


# --- standalone reference app ------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    readiness = "delay" if os.environ.get("READINESS") == "delay" else "screen"
    pupptyeer_bin = os.environ.get("PUPPTYEER_BIN") or _default_bin()
    app.state.harness = await ClaudeHarness.create(pupptyeer_bin=pupptyeer_bin, readiness=readiness)
    yield


app = FastAPI(lifespan=lifespan)
# Routes are registered at import time; the harness is created on startup, so
# resolve it lazily from app.state per request.
include_harness_routes(app, lambda: app.state.harness)


def main():
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "4318")),
    )


if __name__ == "__main__":
    main()
