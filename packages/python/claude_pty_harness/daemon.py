"""Resolve the pupptyeer daemon socket and ensure a daemon is running.
Mirrors daemon.ts."""
from __future__ import annotations

import asyncio
import os
import socket
import subprocess
from dataclasses import dataclass
from typing import Optional

from ._pupptyeer import PupptyeerClient


@dataclass
class DaemonOptions:
    socket_path: Optional[str] = None
    pupptyeer_bin: Optional[str] = None


def resolve_socket_path(opts: DaemonOptions = DaemonOptions()) -> str:
    if opts.socket_path:
        return opts.socket_path
    if os.environ.get("PUPPTYEER_SOCK"):
        return os.environ["PUPPTYEER_SOCK"]
    xdg = os.environ.get("XDG_RUNTIME_DIR")
    if xdg:
        return os.path.join(xdg, "pupptyeer", "daemon.sock")
    tmp = os.environ.get("TMPDIR", "/tmp")
    return os.path.join(tmp, f"pupptyeer-{os.getuid()}", "daemon.sock")


def _resolve_binary(opts: DaemonOptions) -> str:
    return opts.pupptyeer_bin or os.environ.get("PUPPTYEER_BIN") or "pupptyeer"


def _can_connect(path: str) -> bool:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(1.0)
        s.connect(path)
        return True
    except OSError:
        return False
    finally:
        s.close()


async def connect_daemon(opts: DaemonOptions = DaemonOptions()) -> PupptyeerClient:
    sock = resolve_socket_path(opts)
    if not _can_connect(sock):
        binp = _resolve_binary(opts)
        print(f"[daemon] no live socket at {sock}; spawning {binp} daemon")
        subprocess.Popen(
            [binp, "daemon"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        up = False
        for _ in range(50):
            if _can_connect(sock):
                up = True
                break
            await asyncio.sleep(0.1)
        if not up:
            raise RuntimeError(
                f"pupptyeer daemon did not come up at {sock}. "
                "Set pupptyeer_bin/PUPPTYEER_BIN or start it manually."
            )
    print(f"[daemon] connected at {sock}")
    return await asyncio.to_thread(PupptyeerClient.connect, sock)
