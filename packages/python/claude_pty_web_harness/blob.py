"""Pure hashing helper backing the per-session image blob store (see
harness.py). Split out of harness.py and kept free of any I/O beyond hashing
bytes so the blobId derivation - the one piece of logic this port and the TS
one must agree on byte-for-byte - is directly unit- and conformance-testable
without spinning up a harness or a pupptyeer daemon. Mirrors blob.ts."""
from __future__ import annotations

import base64 as _base64
import hashlib
import re
from typing import Tuple

# ASCII whitespace only, spelled out rather than using \s: Python's \s and
# JS's \s match different sets (JS also matches U+FEFF and friends), so a
# shared \s would strip different characters in each port and hand the two
# decoders different input. Mirrors WHITESPACE_RE in blob.ts.
_WHITESPACE_RE = re.compile(r"[ \t\n\r\f\v]")
# Base64 alphabet with trailing padding. Deliberately permissive about how
# many "=" trail (both decoders agree on "====" -> zero bytes); the length
# check in decode_image is what actually rejects the malformed cases.
_BASE64_RE = re.compile(r"[A-Za-z0-9+/]*=*")


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

    Validates before decoding, and raises on anything that fails, so that this
    port and blob.ts accept and reject exactly the same strings. Without the
    check the two disagree on improperly-padded input: `base64.b64decode`
    raises on "abc", while Node's `Buffer.from(str, "base64")` never throws
    and leniently decodes it to 2 bytes - which surfaced as the same image
    block becoming an "unknown" ContentPart here and an "image" one in TS.
    Rejecting in both is the reconciliation: a payload that isn't well-formed
    base64 decodes to garbage bytes that would never render as an image
    anyway, so an honest "unknown" part beats a blob_id pointing at junk.
    Whitespace is stripped first (both decoders tolerate it), and the length
    check is what rejects the genuinely malformed input. Mirrors decodeImage
    in blob.ts."""
    compact = _WHITESPACE_RE.sub("", base64_data)
    if _BASE64_RE.fullmatch(compact) is None or len(compact) % 4 != 0:
        raise ValueError("invalid base64 image payload")
    raw = _base64.b64decode(compact, validate=False)
    return hash_image_bytes(raw), raw
