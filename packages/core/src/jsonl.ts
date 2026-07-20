// Locate, tail, and parse the JSONL transcript Claude Code persists at
// ~/.claude/projects/**/<session-id>.jsonl, turning each line into ChatEvents.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChatEvent, ContentPart } from "@petersr/claude-pty-web-harness-protocol";

/**
 * Find the JSONL file Claude writes for a given session id. Claude encodes the
 * cwd into a directory name under ~/.claude/projects, so rather than reproduce
 * that encoding we walk the tree for `<sessionId>.jsonl` (matching claude-p).
 */
export async function findJsonlPath(sessionId: string): Promise<string | null> {
  const root = path.join(os.homedir(), ".claude", "projects");
  const target = `${sessionId}.jsonl`;
  let best: string | null = null;
  let bestMtime = 0;

  let dirs: string[];
  try {
    dirs = await fsp.readdir(root);
  } catch {
    return null;
  }

  for (const dir of dirs) {
    const full = path.join(root, dir, target);
    try {
      const st = await fsp.stat(full);
      if (st.mtimeMs > bestMtime) {
        best = full;
        bestMtime = st.mtimeMs;
      }
    } catch {
      // not in this project dir
    }
  }
  return best;
}

interface RawEntry {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  // result-line fields
  duration_ms?: number;
  total_cost_usd?: number;
  result?: string;
}

/**
 * Called once per image content block encountered while parsing, so the
 * caller (the harness's per-session blob store) can decode the base64,
 * compute its content hash, and hand back both the blobId and the decoded
 * byte count to embed in the resulting ContentPart. The byte count comes from
 * the sink - the one place that actually decodes, for storage - rather than
 * from a second, independent decode here: an earlier version of this file
 * computed `bytes` itself via `Buffer.byteLength(base64, "base64")`, which
 * disagreed with Python's decode for improperly padded base64 ("abc" -> 2
 * bytes in Node, but an error in Python's stricter `base64.b64decode`). One
 * decode, one length, one place per language; see PARITY.md.
 *
 * This keeps parseEntry itself pure: it never decodes, hashes, or stores
 * anything, and it never puts raw base64 into a ChatEvent. Without a sink
 * there is nowhere for the bytes to go, so an image block degrades to an
 * "unknown" part instead of inventing a placeholder id or leaking the
 * payload. A sink that throws (e.g. because its decode rejected the payload)
 * is treated the same way - see blockToPart below.
 */
export type ImageSink = (payload: { base64: string; mediaType: string }) => { blobId: string; bytes: number };

/**
 * One non-text content block -> a ContentPart. `blockType` for an "unknown"
 * part is the block's own `type` string (or "unknown" if it didn't have one).
 * `salvageText`, when the block carried a string `text` field despite not
 * being a recognized type, rides along on the "unknown" part too - a
 * parts-reading renderer and a text-only reader must never disagree about
 * whether this block said anything.
 */
function blockToPart(block: Record<string, unknown>, onImage: ImageSink | undefined, salvageText?: string): ContentPart {
  const blockType = typeof block.type === "string" ? block.type : "unknown";
  if (blockType === "image" && onImage) {
    // Claude Code image blocks look like
    // {"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}.
    // Anything short of that (missing source/data/media_type) falls through
    // to the "unknown" return below rather than throwing.
    const source = block.source as Record<string, unknown> | undefined;
    const base64 = source && typeof source === "object" && typeof source.data === "string" ? source.data : undefined;
    const mediaType =
      source && typeof source === "object" && typeof source.media_type === "string" ? source.media_type : undefined;
    if (base64 !== undefined && mediaType !== undefined) {
      try {
        const { blobId, bytes } = onImage({ base64, mediaType });
        return { type: "image", blobId, mediaType, bytes };
      } catch {
        // The sink's decode rejected this payload - most commonly malformed
        // or unconventionally-padded base64 that one language's decoder
        // accepts leniently and the other's rejects (see PARITY.md). Fall
        // through to the unknown fallback below instead of letting this
        // throw out of parseEntry: the content came from an MCP tool and is
        // not trusted to be well-formed.
      }
    }
  }
  return salvageText !== undefined ? { type: "unknown", blockType, text: salvageText } : { type: "unknown", blockType };
}

/**
 * Parse an Anthropic `content` field (a plain string, or an array of content
 * blocks) into the flattened legacy text plus, only when a block beyond plain
 * text is present, the full ordered part list. `parts` is omitted rather than
 * set to an all-text array so pure-text output stays identical to before this
 * fix (no new key appears). Any block carrying a string `text` field
 * contributes it to the legacy `text` join regardless of its `type` - the
 * pre-fix asText() kept text from any block with a "text" key, not just
 * `type: "text"` blocks, so `text` must stay byte-for-byte what it always was
 * even for a block that also gets flagged as an unrecognized type.
 */
function parseContent(content: unknown, onImage?: ImageSink): { text: string; parts?: ContentPart[] } {
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: "" };

  const textChunks: string[] = [];
  const parts: ContentPart[] = [];
  let hasNonText = false;

  for (const raw of content) {
    // A bare array is typeof "object" in JS but is never a content block;
    // excluding it here matches Python's isinstance(block, dict) guard.
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const block = raw as Record<string, unknown>;
    const blockText = typeof block.text === "string" ? block.text : undefined;
    if (block.type === "text") {
      const t = blockText ?? "";
      textChunks.push(t);
      parts.push({ type: "text", text: t });
    } else {
      hasNonText = true;
      if (blockText !== undefined) textChunks.push(blockText);
      parts.push(blockToPart(block, onImage, blockText));
    }
  }

  const text = textChunks.join("");
  return hasNonText ? { text, parts } : { text };
}

/**
 * Convert one parsed JSONL entry into zero or more ChatEvents. `onImage`, if
 * given, is forwarded to parseContent for every image block encountered (see
 * ImageSink); parseEntry does no I/O of its own either way.
 */
export function parseEntry(entry: RawEntry, lineNo: number, onImage?: ImageSink): ChatEvent[] {
  const baseId = entry.uuid || `line-${lineNo}`;
  const ts = entry.timestamp;
  const out: ChatEvent[] = [];

  switch (entry.type) {
    case "user": {
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        let blockNo = 0;
        for (const block of content as any[]) {
          if (!block || typeof block !== "object" || Array.isArray(block)) continue;
          if (block.type === "tool_result") {
            const { text, parts } = parseContent(block.content, onImage);
            out.push({
              id: `${baseId}:tr:${blockNo++}`,
              ts,
              kind: "tool_result",
              toolUseId: block.tool_use_id ?? "",
              text,
              isError: Boolean(block.is_error),
              ...(parts ? { parts } : {}),
            });
          } else if (block.type === "text" || typeof block.text === "string") {
            out.push({ id: `${baseId}:u:${blockNo++}`, ts, kind: "user", text: String(block.text ?? "") });
          } else {
            // A non-text, non-tool_result block (e.g. a user-pasted image)
            // used to match neither branch above and vanish with no trace.
            out.push({ id: `${baseId}:x:${blockNo++}`, ts, kind: "user", text: "", parts: [blockToPart(block, onImage)] });
          }
        }
      } else {
        const { text } = parseContent(content, onImage);
        if (text.trim()) out.push({ id: baseId, ts, kind: "user", text });
      }
      break;
    }

    case "assistant": {
      const content = entry.message?.content;
      const blocks = Array.isArray(content) ? (content as any[]) : [];
      let blockNo = 0;
      for (const block of blocks) {
        if (!block || typeof block !== "object" || Array.isArray(block)) continue;
        if (block.type === "text") {
          if (String(block.text ?? "").trim()) {
            out.push({ id: `${baseId}:a:${blockNo++}`, ts, kind: "assistant_text", text: String(block.text) });
          }
        } else if (block.type === "thinking") {
          out.push({ id: `${baseId}:t:${blockNo++}`, ts, kind: "thinking", text: String(block.thinking ?? block.text ?? "") });
        } else if (block.type === "tool_use") {
          out.push({
            id: `${baseId}:tu:${blockNo++}`,
            ts,
            kind: "tool_use",
            name: String(block.name ?? "tool"),
            toolUseId: String(block.id ?? ""),
            input: block.input,
          });
        } else {
          // Unrecognized block type (e.g. redacted_thinking) used to fall off
          // the end with no branch and vanish; surface it instead. If it
          // carried a string `text` field, salvage it into both the event's
          // `text` and the part (see parseContent's doc comment above).
          const blockText = typeof block.text === "string" ? block.text : undefined;
          out.push({
            id: `${baseId}:x:${blockNo++}`,
            ts,
            kind: "assistant_text",
            text: blockText ?? "",
            parts: [blockToPart(block, onImage, blockText)],
          });
        }
      }
      break;
    }

    case "system": {
      // turn_duration is claude's reliable end-of-turn marker; surface it as a
      // "turn complete" chip. Other system lines (hooks, mode, etc.) are noise.
      if (entry.subtype === "turn_duration") {
        out.push({ id: baseId, ts, kind: "result", subtype: "turn_duration", durationMs: entry.duration_ms });
      }
      break;
    }

    case "result": {
      out.push({
        id: baseId,
        ts,
        kind: "result",
        subtype: entry.subtype,
        durationMs: entry.duration_ms,
        costUsd: entry.total_cost_usd,
        text: entry.result,
      });
      break;
    }

    default:
      // summary and other line types are ignored for the chat view.
      break;
  }

  return out;
}

/**
 * Tails a session's JSONL file, emitting "event" for each ChatEvent.
 * Waits for the file to appear (Claude creates it after the first turn).
 * Polling-based for robustness against editors/fs.watch quirks.
 */
export class JsonlTailer extends EventEmitter {
  private offset = 0;
  private partial = "";
  private lineNo = 0;
  private filePath: string | null = null;
  private prevPath: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlight = false;

  constructor(
    private readonly sessionId: string,
    private readonly intervalMs = 200,
    private readonly onImage?: ImageSink,
  ) {
    super();
  }

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    // Ticks are async and fire on a fixed interval; without this guard a slow
    // read would overlap the next tick, re-reading the same byte range and
    // corrupting this.partial. Skip if a tick is already running.
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    try {
      if (!this.filePath) {
        const found = await findJsonlPath(this.sessionId);
        if (!found) return;
        // A re-discovered path that differs from the last one (a rotated or
        // relocated file) must not inherit the previous file's read position,
        // or offset/partial/lineNo would corrupt parsing of the new file.
        if (this.prevPath && found !== this.prevPath) {
          this.offset = 0;
          this.partial = "";
          this.lineNo = 0;
        }
        this.filePath = found;
        this.prevPath = found;
        this.emit("file", this.filePath);
      }
      const st = await fsp.stat(this.filePath);
      if (st.size <= this.offset) return;

      const stream = fs.createReadStream(this.filePath, { start: this.offset, end: st.size - 1, encoding: "utf8" });
      let chunk = "";
      for await (const part of stream) chunk += part;
      this.offset = st.size;

      this.partial += chunk;
      let nl: number;
      while ((nl = this.partial.indexOf("\n")) >= 0) {
        const line = this.partial.slice(0, nl);
        this.partial = this.partial.slice(nl + 1);
        if (!line.trim()) continue;
        this.lineNo++;
        let entry: RawEntry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        for (const ev of parseEntry(entry, this.lineNo, this.onImage)) {
          this.emit("event", ev);
        }
      }
    } catch (err) {
      // file vanished or transient error; reset discovery
      this.filePath = null;
    } finally {
      this.inFlight = false;
    }
  }
}
