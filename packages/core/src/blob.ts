// Pure hashing helper backing the per-session image blob store (see
// harness.ts). Split out of harness.ts and kept free of any I/O beyond
// decoding a string so the blobId derivation - the one piece of logic the TS
// and Python ports must agree on byte-for-byte - is directly unit- and
// conformance-testable without spinning up a harness or a pupptyeer daemon.
import { createHash } from "node:crypto";

/**
 * Content-addressed id for an image blob: the lowercase hex SHA-256 of the
 * decoded bytes. Deterministic and collision-free enough that identical
 * images (even from different tool calls) dedupe to the same store entry.
 */
export function hashImageBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ASCII whitespace only, spelled out rather than using \s: JS's \s matches a
// wider set (U+FEFF and friends) than Python's, so a shared \s would strip
// different characters in each port and hand the two decoders different
// input. Mirrors _WHITESPACE_RE in blob.py.
const WHITESPACE_RE = /[ \t\n\r\f\v]/g;
// Base64 alphabet with trailing padding. Deliberately permissive about how
// many "=" trail (both decoders agree on "====" -> zero bytes); the length
// check below is what actually rejects the malformed cases.
const BASE64_RE = /^[A-Za-z0-9+/]*=*$/;

/**
 * Decode a base64 image payload once and derive everything from that single
 * decode: the blobId and the decoded bytes (harness.ts's ImageSink stores
 * `bytes` and reports `bytes.length` as the ContentPart's byte count).
 * Exposed as its own function, rather than inlined in harness.ts's ImageSink,
 * so this exact decode+hash pairing is directly conformance-testable without
 * a live harness.
 *
 * Validates before decoding, and throws on anything that fails, so that this
 * port and blob.py accept and reject exactly the same strings. Without the
 * check the two disagree on improperly-padded input: `Buffer.from(str,
 * "base64")` never throws and leniently decodes "abc" to 2 bytes, while
 * Python's `base64.b64decode` raises on it - which surfaced as the same
 * image block becoming an "image" ContentPart in TS and an "unknown" one in
 * Python. Rejecting in both is the reconciliation: a payload that isn't
 * well-formed base64 decodes to garbage bytes that would never render as an
 * image anyway, so an honest "unknown" part beats a blobId pointing at junk.
 * Whitespace is stripped first (both decoders tolerate it), and the length
 * check is what rejects the genuinely malformed input.
 */
export function decodeImage(base64: string): { blobId: string; bytes: Buffer } {
  const compact = base64.replace(WHITESPACE_RE, "");
  if (!BASE64_RE.test(compact) || compact.length % 4 !== 0) {
    throw new Error("invalid base64 image payload");
  }
  const bytes = Buffer.from(compact, "base64");
  return { blobId: hashImageBytes(bytes), bytes };
}
