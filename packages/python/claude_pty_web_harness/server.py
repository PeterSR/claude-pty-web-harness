"""Reference FastAPI + WebSocket adapter exposing a ClaudeHarness over the same
HTTP/WS protocol as the TS server, so the React frontend works unchanged.

Two ways to use it:

  * Standalone, for local dev:
      PORT=4318 uvicorn claude_pty_web_harness.server:app
      python -m claude_pty_web_harness.server

  * Mounted into an existing FastAPI app (e.g. behind your own OIDC auth):
      from claude_pty_web_harness.server import include_harness_routes
      include_harness_routes(
          app,
          harness,
          dependencies=[Depends(validate_token)],   # guards the REST routes
          authenticate_ws=my_ws_ticket_check,        # guards the WS upgrade
          authenticate_blob=my_blob_cookie_check,    # guards the blob route
      )

REST routes accept FastAPI `dependencies` so your auth runs on every call.
Browsers can't set an Authorization header on a WebSocket, so the WS route is
guarded separately by `authenticate_ws` (validate a short-lived ticket / query
token there).

The same problem applies to the blob route (`GET
{prefix}/sessions/:id/blobs/:blob_id`): a browser `<img src>` cannot send
an Authorization header either, so under header-based `dependencies` every
image renders broken. `authenticate_blob`, when set, guards that one route
*instead of* `dependencies` (not in addition to it) - same relationship
`authenticate_ws` has to `dependencies` for the WebSocket. If you set
`dependencies` to anything header-based, you MUST also set
`authenticate_blob` or images will 401.

Recommended: a path-scoped `HttpOnly`, `SameSite=Strict` cookie minted at
session start and scoped to the blob route, so the browser attaches it to
`<img src>` automatically and nothing sensitive ever enters a URL. A
query-string ticket token is the other common option, but it leaks through
access logs, browser history, and the `Referer` header on outbound links; a
short expiry narrows that window without closing those channels, and if you
go this route the ticket should be scoped to a single blob_id rather than
being a general pass to the whole blob route. This library does not pick the
mechanism for you - auth lives here, at the edge, and the harness stays
transport-agnostic - so there is no bundled ticket or cookie helper;
implement whichever fits your deployment. Omit `authenticate_blob` to keep
the current REST guarding (`dependencies`, or none) on this route, which is
correct for the no-auth default and for cookie-based auth that FastAPI's
normal request handling already sees.
"""
from __future__ import annotations

import asyncio
import inspect
import os
import re
from contextlib import asynccontextmanager
from typing import Awaitable, Callable, Optional, Sequence, Union

from fastapi import APIRouter, Depends, FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse, Response

from .harness import ClaudeHarness, PickerOpenError

# Only a lowercase hex SHA-256 digest is ever a real blob_id (see
# ClaudeHarness's blob store); reject anything else before it ever reaches
# harness.blob(), since this content comes from MCP tool output and is not
# fully trusted.
_BLOB_ID_RE = re.compile(r"^[a-f0-9]{64}$")
# Anything outside this allowlist is served as application/octet-stream rather
# than trusting the media_type a tool reported, so a browser is never handed a
# Content-Type it might sniff into executing.
_BLOB_CONTENT_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}

# Either a live harness or a zero-arg callable that returns one (lets the
# standalone app defer creation to startup while still using create_router).
HarnessSource = Union[ClaudeHarness, Callable[[], ClaudeHarness]]
# Return falsy / raise to reject the WebSocket before it is accepted.
WsAuthenticator = Callable[[WebSocket], Union[bool, Awaitable[bool]]]
# Return falsy / raise to reject the blob route request with a 401. Same
# shape as WsAuthenticator but keyed on a Request, since (like the WebSocket
# upgrade) a browser <img src> can't carry the header-based `dependencies`
# guard - see the module docstring.
BlobAuthenticator = Callable[[Request], Union[bool, Awaitable[bool]]]


def _resolver(source: HarnessSource) -> Callable[[], ClaudeHarness]:
    if isinstance(source, ClaudeHarness):
        return lambda: source
    return source  # already a callable


async def _read_json_object(request: Request) -> Optional[dict]:
    """Parse a JSON request body, returning the dict or None for malformed JSON
    or a non-object body. Callers turn None into a clean 400."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return None
    return body if isinstance(body, dict) else None


def create_router(
    harness: HarnessSource,
    *,
    prefix: str = "/api",
    dependencies: Optional[Sequence[Depends]] = None,
    authenticate_ws: Optional[WsAuthenticator] = None,
    authenticate_blob: Optional[BlobAuthenticator] = None,
) -> APIRouter:
    """Build an APIRouter with the harness REST + WebSocket endpoints.

    `harness` may be a ClaudeHarness or a zero-arg callable returning one.
    `dependencies` are applied to every REST route (not the WebSocket, and not
    the blob route when `authenticate_blob` is given - see below).
    `authenticate_ws` guards the WebSocket upgrade.
    `authenticate_blob` guards the blob route *instead of* `dependencies` for
    that one route (a browser <img src> can't carry a header-based
    dependency either); omit it to leave the blob route under the normal
    `dependencies` guarding. See the module docstring for the full rationale
    and the recommended cookie-based approach.
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
        body = await _read_json_object(request)
        if body is None:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
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
        body = await _read_json_object(request)
        if body is None:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        if not body.get("text"):
            return JSONResponse({"error": "text is required"}, status_code=400)
        try:
            await get_harness().send_prompt(session_id, body["text"])
            return {"ok": True}
        except PickerOpenError as e:
            # A picker on screen is a client-observable conflict (409);
            # mirrors the TS route's picker_open -> 409 mapping.
            return JSONResponse({"error": str(e)}, status_code=409)
        except KeyError:
            return JSONResponse({"error": "unknown session"}, status_code=404)

    # authenticate_blob replaces `dependencies` for this one route rather than
    # layering on top of it (same relationship authenticate_ws has to
    # `dependencies` for the WebSocket) - see the module docstring.
    blob_dependencies = [] if authenticate_blob is not None else dep

    @router.get(f"{prefix}/sessions/{{session_id}}/blobs/{{blob_id}}", dependencies=blob_dependencies)
    async def get_blob(request: Request, session_id: str, blob_id: str):
        if authenticate_blob is not None:
            try:
                result = authenticate_blob(request)
                ok = await result if inspect.isawaitable(result) else result
            except Exception:
                ok = False
            if not ok:
                return JSONResponse({"error": "unauthorized"}, status_code=401)
        # Unknown session and unknown blob (and a malformed blob_id) all 404
        # with the same body, so a caller can't use the response to probe
        # which of the two didn't exist.
        if not _BLOB_ID_RE.match(blob_id):
            return JSONResponse({"error": "not found"}, status_code=404)
        found = get_harness().blob(session_id, blob_id)
        if not found:
            return JSONResponse({"error": "not found"}, status_code=404)
        data, media_type = found
        content_type = media_type if media_type in _BLOB_CONTENT_TYPES else "application/octet-stream"
        return Response(
            content=data,
            media_type=content_type,
            headers={
                "X-Content-Type-Options": "nosniff",
                "Content-Disposition": "inline",
                # Content-addressed and immutable: blob_id is a hash of the
                # bytes, so this response can never go stale.
                "Cache-Control": "public, max-age=31536000, immutable",
            },
        )

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
                # The listener payload is the status string; the failure reason
                # lives on the summary, so read it back for a "failed" status.
                msg = {"type": "status", "status": payload}
                if payload == "failed":
                    cur = harness.get(sid)
                    if cur and cur.get("error"):
                        msg["error"] = cur["error"]
                queue.put_nowait(msg)

        # Snapshot the transcript and register the listener as adjacent
        # synchronous statements (no await between them): everything up to the
        # snapshot is replayed below, everything after goes to the queue, and
        # with no suspension point in between nothing is lost or duplicated.
        # Re-read the summary here too so the replayed status matches this point.
        snapshot = list(harness.transcript(session_id))
        remove = harness.add_listener(on_event)
        current = harness.get(session_id) or summary
        status_msg = {"type": "status", "status": current["status"]}
        if current.get("error"):
            status_msg["error"] = current["error"]

        async def outbound():
            while True:
                await ws.send_json(await queue.get())

        async def inbound():
            while True:
                data = await ws.receive_json()
                if not isinstance(data, dict):
                    continue
                t = data.get("type")
                if t == "prompt":
                    # Fire-and-forget, but surface a failure to the socket
                    # instead of swallowing it: an open picker (PickerOpenError)
                    # is the case this guard exists for, but a session that
                    # vanished mid-flight deserves the same treatment rather
                    # than the caller believing its message was sent (mirrors
                    # the TS server's .catch that sends a wire "error").
                    task = asyncio.create_task(harness.send_prompt(session_id, data.get("text", "")))

                    def _on_prompt_done(done: "asyncio.Task") -> None:
                        if done.cancelled():
                            return
                        err = done.exception()
                        if err is not None:
                            # Route through the queue rather than sending here
                            # directly: outbound() is the single writer on this
                            # socket, and ws.send_json is not safe to call from
                            # two places concurrently.
                            queue.put_nowait({"type": "error", "message": str(err)})

                    task.add_done_callback(_on_prompt_done)
                elif t == "interrupt":
                    await harness.interrupt(session_id)

        # Everything from here awaits, so it lives under try/finally: a client
        # dropping mid-replay must still remove the listener (else it and its
        # queue leak forever). The pump tasks start only after the replay so
        # queued live events can't overtake the replayed transcript.
        out_task = in_task = None
        try:
            await ws.send_json(status_msg)
            for ev in snapshot:
                await ws.send_json({"type": "chat", "event": ev})

            out_task = asyncio.create_task(outbound())
            in_task = asyncio.create_task(inbound())
            await asyncio.wait({out_task, in_task}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            remove()
            # asyncio.wait never re-raises task exceptions, so gather the
            # cancelled tasks with return_exceptions to consume any (e.g. a
            # WebSocketDisconnect) instead of letting them log as unretrieved.
            tasks = [t for t in (out_task, in_task) if t is not None]
            for t in tasks:
                t.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

    return router


def include_harness_routes(
    app: FastAPI,
    harness: HarnessSource,
    *,
    prefix: str = "/api",
    dependencies: Optional[Sequence[Depends]] = None,
    authenticate_ws: Optional[WsAuthenticator] = None,
    authenticate_blob: Optional[BlobAuthenticator] = None,
) -> None:
    """Mount the harness routes onto an existing FastAPI app (or any router-host).

    Mirrors the TS `registerHarnessRoutes`. Pass `dependencies` to guard the
    REST routes with your own auth (e.g. `[Depends(validate_token)]`),
    `authenticate_ws` to guard the WebSocket upgrade, and `authenticate_blob`
    to guard the blob route (replacing `dependencies` for that one route -
    see the module docstring for why and the recommended cookie approach).
    """
    app.include_router(
        create_router(
            harness,
            prefix=prefix,
            dependencies=dependencies,
            authenticate_ws=authenticate_ws,
            authenticate_blob=authenticate_blob,
        )
    )


# --- standalone reference app ------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    readiness = "delay" if os.environ.get("READINESS") == "delay" else "screen"
    # Connects to the global pupptyeer daemon (camp A): the client resolves the
    # default socket and fails loud if it is unreachable. Set PUPPTYEER_SOCK to
    # point at a non-default socket.
    app.state.harness = await ClaudeHarness.create(readiness=readiness)
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
