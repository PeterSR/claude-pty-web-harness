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

/**
 * Decode a base64 image payload once and derive everything from that single
 * decode: the blobId and the decoded bytes (harness.ts's ImageSink stores
 * `bytes` and reports `bytes.length` as the ContentPart's byte count).
 * Exposed as its own function, rather than inlined in harness.ts's ImageSink,
 * so this exact decode+hash pairing is directly conformance-testable without
 * a live harness.
 *
 * `Buffer.from(str, "base64")` never throws - it decodes what it can and is
 * lenient about padding (e.g. "abc" decodes to 2 bytes here, where Python's
 * `base64.b64decode(..., validate=False)` raises on the same input). This
 * function does not try to reconcile that: it reports whatever this decode
 * actually produced. A caller across the language boundary (jsonl.ts's
 * blockToPart) is the one that treats a throwing sink as "unknown" rather
 * than trying to make the two decoders agree on padding rules.
 */
export function decodeImage(base64: string): { blobId: string; bytes: Buffer } {
  const bytes = Buffer.from(base64, "base64");
  return { blobId: hashImageBytes(bytes), bytes };
}
