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
