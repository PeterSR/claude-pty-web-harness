// Locate, tail, and parse the JSONL transcript Claude Code persists at
// ~/.claude/projects/**/<session-id>.jsonl, turning each line into ChatEvents.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChatEvent } from "@petersr/claude-pty-web-harness-protocol";

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

function asText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as any).text ?? "") : ""))
      .join("");
  }
  return "";
}

/** Convert one parsed JSONL entry into zero or more ChatEvents. */
export function parseEntry(entry: RawEntry, lineNo: number): ChatEvent[] {
  const baseId = entry.uuid || `line-${lineNo}`;
  const ts = entry.timestamp;
  const out: ChatEvent[] = [];

  switch (entry.type) {
    case "user": {
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        let blockNo = 0;
        for (const block of content as any[]) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "tool_result") {
            out.push({
              id: `${baseId}:tr:${blockNo++}`,
              ts,
              kind: "tool_result",
              toolUseId: block.tool_use_id ?? "",
              text: asText(block.content),
              isError: Boolean(block.is_error),
            });
          } else if (block.type === "text" || typeof block.text === "string") {
            out.push({ id: `${baseId}:u:${blockNo++}`, ts, kind: "user", text: String(block.text ?? "") });
          }
        }
      } else {
        const text = asText(content);
        if (text.trim()) out.push({ id: baseId, ts, kind: "user", text });
      }
      break;
    }

    case "assistant": {
      const content = entry.message?.content;
      const blocks = Array.isArray(content) ? (content as any[]) : [];
      let blockNo = 0;
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
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
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly sessionId: string, private readonly intervalMs = 200) {
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
    if (this.stopped) return;
    try {
      if (!this.filePath) {
        this.filePath = await findJsonlPath(this.sessionId);
        if (!this.filePath) return;
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
        for (const ev of parseEntry(entry, this.lineNo)) {
          this.emit("event", ev);
        }
      }
    } catch (err) {
      // file vanished or transient error; reset discovery
      this.filePath = null;
    }
  }
}
