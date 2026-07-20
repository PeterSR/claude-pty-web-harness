"""Pure hashing helper backing the per-session image blob store (see
harness.py). Split out of harness.py and kept free of any I/O beyond hashing
bytes so the blobId derivation - the one piece of logic this port and the TS
one must agree on byte-for-byte - is directly unit- and conformance-testable
without spinning up a harness or a pupptyeer daemon. Mirrors blob.ts."""
from __future__ import annotations

import base64 as _base64
import hashlib
from typing import Tuple


def hash_image_bytes(data: bytes) -> str:
    """Content-addressed id for an image blob: the lowercase hex SHA-256 of the
    decoded bytes. Deterministic and collision-free enough that identical
    images (even from different tool calls) dedupe to the same store entry."""
    return hashlib.sha256(data).hexdigest()


def decode_image(base64_data: str) -> Tuple[str, bytes]:
    """Decode a base64 image payload once and derive everything from that
    single decode: the blob_id and the decoded bytes (harness.py's ImageSink
    stores them and reports len(bytes) as the ContentPart's byte count).
    Exposed as its own function, rather than inlined in harness.py's
    ImageSink, so this exact decode+hash pairing is directly
    conformance-testable without a live harness.

    `base64.b64decode(data, validate=False)` raises on improperly padded
    input (e.g. "abc" raises here, where Node's `Buffer.from(str, "base64")`
    leniently decodes it to 2 bytes). This function does not try to reconcile
    that: it either produces the same answer Node's decoder would for
    well-formed base64, or raises. A caller across the language boundary
    (jsonl.py's _block_to_part) is the one that treats a raising sink as
    "unknown" rather than trying to make the two decoders agree on padding
    rules."""
    raw = _base64.b64decode(base64_data, validate=False)
    return hash_image_bytes(raw), raw
