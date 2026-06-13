"""Path shim for the pupptyeer Python client, which ships as a single
stdlib-only file (pty-supervisor/clients/python/pupptyeer_client.py) and is not
published to PyPI. Point PUPPTYEER_PY_CLIENT at its directory to override the
default sibling-repo location."""
from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_DEFAULT = os.path.abspath(
    os.path.join(_HERE, "..", "..", "..", "..", "pty-supervisor", "clients", "python")
)
_DIR = os.environ.get("PUPPTYEER_PY_CLIENT", _DEFAULT)
if _DIR not in sys.path:
    sys.path.insert(0, _DIR)

from pupptyeer_client import PupptyeerClient, Screen, Cursor  # noqa: E402,F401
