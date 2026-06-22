"""Re-export the pupptyeer Python client. It's installed from PyPI as
`pupptyeer-client` (imported as `pupptyeer_client`). For local development
against a pupptyeer checkout, set PUPPTYEER_PY_CLIENT to its clients/python
directory and that copy is imported instead."""
from __future__ import annotations

import os
import sys

_override = os.environ.get("PUPPTYEER_PY_CLIENT")
if _override and _override not in sys.path:
    sys.path.insert(0, _override)

from pupptyeer_client import PupptyeerClient, Screen, Cursor  # noqa: E402,F401
