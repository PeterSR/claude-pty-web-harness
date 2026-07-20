"""Pure hashing helper backing the per-session image blob store (see
harness.py). Split out of harness.py and kept free of any I/O beyond hashing
bytes so the blobId derivation - the one piece of logic this port and the TS
one must agree on byte-for-byte - is directly unit- and conformance-testable
without spinning up a harness or a pupptyeer daemon. Mirrors blob.ts."""
from __future__ import annotations

import hashlib


def hash_image_bytes(data: bytes) -> str:
    """Content-addressed id for an image blob: the lowercase hex SHA-256 of the
    decoded bytes. Deterministic and collision-free enough that identical
    images (even from different tool calls) dedupe to the same store entry."""
    return hashlib.sha256(data).hexdigest()
