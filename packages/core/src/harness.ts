// ClaudeHarness: the extractable core. Drives Claude Code inside a pupptyeer
// pty and turns its JSONL transcript into a stream of ChatEvents.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { resolve as resolvePath, sep } from "node:path";
import { PupptyeerClient } from "pupptyeer-client";
import type { Screen } from "pupptyeer-client";
import { JsonlTailer } from "./jsonl.js";
import {
  readyForInput,
  hasInputPrompt,
  hasBypassWarning,
  hasTrustModal,
  hasStylePicker,
  isReadyFooter,
  classifyStartupFailure,
  isHardStartupFailure,
} from "./detect.js";
import type { ChatEvent, SessionStatus, SessionSummary } from "@petersr/claude-pty-web-harness-protocol";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The pupptyeer namespace all harness sessions live in. Isolates them from
 * other apps sharing the global daemon (TS and Python share this app, so they
 * share the namespace). See .agent-workspace/pupptyeer-namespaces-plan.md.
 */
export const HARNESS_NAMESPACE = "claude-pty-web-harness";

// Bracketed-paste markers. Wrapping prompt text in these makes the TUI insert it
// literally (newlines and all) instead of submitting at the first newline, the
// same way a real terminal delivers a paste. A separate Enter then submits.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export interface HarnessOptions {
  /**
   * Override the daemon socket path. Omitted resolves the default location
   * ($PUPPTYEER_SOCK, else XDG/tmp) via the pupptyeer client.
   */
  socketPath?: string;
  /**
   * How to detect a session is ready for input.
   *  - "screen" (default): read the daemon's rendered grid (captureScreen) and
   *    drive past the startup modals.
   *  - "delay": never capture; mark ready after a short delay and rely on
   *    claude's remembered trust/permission config. Use this if the daemon's
   *    capture wedges claude sessions.
   */
  readiness?: "screen" | "delay";
  /**
   * If set and non-empty, sessions may only be spawned inside one of these
   * roots; a cwd that resolves outside them is rejected. Leave unset for the
   * default (unrestricted) behaviour. Useful when the harness sits behind an
   * authenticated app and you don't want a caller spawning claude at "/".
   */
  allowedRoots?: string[];
}

export interface CreateSessionOptions {
  cwd: string;
  /** Binary to launch. Default "claude". */
  command?: string;
  model?: string;
  /** --permission-mode value. Default "bypassPermissions". Pass "" to omit. */
  permissionMode?: string;
  /** Extra argv appended after the managed flags. */
  extraArgs?: string[];
  cols?: number;
  rows?: number;
}

interface Session {
  id: string; // claude session id (--session-id), names the JSONL file
  ptyId: string; // pupptyeer pty session id
  cwd: string;
  model?: string;
  status: SessionStatus;
  error?: string; // failure reason when status is "failed"
  createdAt: string;
  tailer: JsonlTailer;
  events: ChatEvent[]; // full transcript for replay
  ready: boolean;
}

/**
 * Emits, per session id:
 *   "chat"   (sessionId, ChatEvent)
 *   "status" (sessionId, SessionStatus, error?) - error is the failure reason
 *            when status is "failed", otherwise undefined.
 */
export class ClaudeHarness extends EventEmitter {
  private client!: PupptyeerClient;
  private readiness: "screen" | "delay" = "screen";
  private allowedRoots: string[] = [];
  private readonly sessions = new Map<string, Session>();

  static async create(opts: HarnessOptions = {}): Promise<ClaudeHarness> {
    const h = new ClaudeHarness();
    h.readiness = opts.readiness ?? "screen";
    h.allowedRoots = (opts.allowedRoots ?? []).map((r) => resolvePath(r));
    // Connect-or-scream is the client's job: it resolves the default socket,
    // never spawns, and throws one canonical error if the daemon is unreachable.
    h.client = await PupptyeerClient.connect({ socket: opts.socketPath, namespace: HARNESS_NAMESPACE });
    return h;
  }

  /**
   * Resolve cwd and, if an allowlist is configured, reject anything that escapes
   * it. Returns the normalized path actually handed to claude.
   */
  private checkCwd(cwd: string): string {
    const resolved = resolvePath(cwd);
    if (this.allowedRoots.length === 0) return resolved;
    for (const root of this.allowedRoots) {
      if (resolved === root || resolved.startsWith(root + sep)) return resolved;
    }
    throw new Error(`cwd ${resolved} is outside the allowed roots`);
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => this.summary(s));
  }

  get(id: string): SessionSummary | undefined {
    const s = this.sessions.get(id);
    return s ? this.summary(s) : undefined;
  }

  /** Full transcript captured so far (for WS replay on connect). */
  transcript(id: string): ChatEvent[] {
    return this.sessions.get(id)?.events ?? [];
  }

  private summary(s: Session): SessionSummary {
    return {
      id: s.id,
      ptyId: s.ptyId,
      cwd: s.cwd,
      model: s.model,
      status: s.status,
      ...(s.error ? { error: s.error } : {}),
      createdAt: s.createdAt,
    };
  }

  async createSession(opts: CreateSessionOptions): Promise<SessionSummary> {
    const cwd = this.checkCwd(opts.cwd);
    const id = randomUUID();
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 40;

    const command = opts.command ?? "claude";
    const permissionMode = opts.permissionMode ?? "bypassPermissions";

    const args = ["--session-id", id];
    if (permissionMode) args.push("--permission-mode", permissionMode);
    if (opts.model) args.push("--model", opts.model);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);

    const ptyId = await this.client.newSession({
      command,
      args,
      cwd,
      cols,
      rows,
    });

    const tailer = new JsonlTailer(id);
    const session: Session = {
      id,
      ptyId,
      cwd,
      model: opts.model,
      status: "starting",
      createdAt: new Date().toISOString(),
      tailer,
      events: [],
      ready: false,
    };
    this.sessions.set(id, session);

    // Stream structured chat events from the persisted JSONL.
    tailer.on("event", (ev: ChatEvent) => {
      session.events.push(ev);
      this.emit("chat", id, ev);
    });
    tailer.start();

    // Drive past the startup modals to readiness, reading the daemon's rendered
    // screen (no local terminal emulation needed).
    void this.driveStartup(session);

    return this.summary(session);
  }

  /**
   * Poll the daemon's rendered screen, dismiss the startup modals, and mark the
   * session ready. captureScreen({ settleMs }) waits for the screen to go quiet
   * before returning the grid, so each read sees a stable frame.
   */
  private async driveStartup(session: Session): Promise<void> {
    // "delay": don't capture (the daemon's capture currently wedges claude).
    // Give claude a moment to boot past its remembered modals, then mark ready.
    if (this.readiness === "delay") {
      await sleep(3000);
      if (this.sessions.has(session.id)) this.markReady(session);
      return;
    }

    const deadline = Date.now() + 30_000;
    let styleHandled = false;
    let bypassAccepted = false;
    let trustHandled = false;

    while (Date.now() < deadline) {
      if (!this.sessions.has(session.id) || session.ready) return;

      const screen = await this.captureScreen(session.ptyId, 300, 1500);
      if (!screen || !screen.lines.length) {
        await sleep(200);
        continue;
      }
      const lines = screen.lines;
      const text = lines.join("\n").toLowerCase();

      // 0. First-run text-style picker. The highlighted theme row is a "❯"
      //    selection (not the input prompt) that readyForInput can't distinguish
      //    from real input, so accept the auto-detected default with Enter.
      if (!styleHandled && hasStylePicker(text)) {
        styleHandled = true;
        this.client.writePane(session.ptyId, "\r");
        await sleep(400);
        continue;
      }

      // 1. Bypass-permissions warning. Cursor defaults to "1. No, exit"; a bare
      //    Enter would quit claude. Move to "2. Yes, I accept" (Down) then Enter.
      if (!bypassAccepted && hasBypassWarning(text)) {
        bypassAccepted = true;
        this.client.writeBytes(session.ptyId, Buffer.from("\x1b[B")); // Down
        await sleep(250);
        this.client.writePane(session.ptyId, "\r");
        await sleep(400);
        continue;
      }

      // 2. "Do you trust the files in this folder?" modal (default option = yes).
      if (!trustHandled && hasTrustModal(text)) {
        trustHandled = true;
        this.client.writePane(session.ptyId, "\r");
        await sleep(400);
        continue;
      }

      // 3. Ready once claude parks its cursor on the "❯" input row (primary
      //    signal), or the prompt/idle footer is on screen (text fallbacks).
      if (readyForInput(screen) || hasInputPrompt(lines) || isReadyFooter(text)) {
        this.markReady(session);
        return;
      }

      // 4. Fail fast on a terminal surface the harness can't drive past (an auth
      //    wall, a usage limit, a custom-API-key prompt). Trust / tool-approval
      //    surfaces are left for the timeout classification below, since those
      //    can be transiently on screen while the modal handlers above act.
      const failure = classifyStartupFailure(text);
      if (failure && isHardStartupFailure(failure)) {
        this.markFailed(session, failure);
        return;
      }

      await sleep(200);
    }

    // Deadline elapsed without readiness. Rather than leave the session wedged
    // in "starting" forever, capture one last frame and say why: a recognized
    // block (e.g. an unaccepted trust modal) or the generic startup timeout.
    if (!this.sessions.has(session.id) || session.ready) return;
    const last = await this.captureScreen(session.ptyId, 300, 1500);
    const text = last?.lines.join("\n").toLowerCase() ?? "";
    this.markFailed(session, classifyStartupFailure(text) ?? "startup_timeout");
  }

  /**
   * captureScreen with a hard timeout, returning the rendered screen (grid
   * lines + cursor) or null. The timeout guards against a daemon whose render
   * call never returns (e.g. a VT emulator that blocks on undrained query
   * responses), so the startup driver keeps spinning and respects its own
   * deadline instead of hanging forever.
   */
  private async captureScreen(ptyId: string, settleMs: number, timeoutMs: number): Promise<Screen | null> {
    const real = this.client.captureScreen(ptyId, { settleMs, timeoutMs });
    // If the timeout wins the race, `real` is abandoned but may still reject
    // later (e.g. on disconnect); swallow that so it isn't an unhandled rejection.
    real.catch(() => {});
    try {
      return await Promise.race([real, sleep(timeoutMs + 1000).then(() => null)]);
    } catch {
      return null;
    }
  }

  private markReady(session: Session): void {
    if (session.ready) return;
    session.ready = true;
    session.status = "ready";
    this.emit("status", session.id, "ready");
  }

  /**
   * Mark a session that never reached the input prompt as "failed", carrying a
   * short machine reason (a StartupFailure). No-op once the session is ready,
   * already failed, or gone. The pty is left alive so the caller can inspect or
   * kill() it; a failed session is not usable for prompts.
   */
  private markFailed(session: Session, reason: string): void {
    if (!this.sessions.has(session.id) || session.status !== "starting") return;
    session.status = "failed";
    session.error = reason;
    this.emit("status", session.id, "failed", reason);
  }

  /**
   * Deliver a prompt as a bracketed paste so multi-line text lands in the TUI
   * input intact, then (by default) submit it with a single Enter. Pass
   * `{ submit: false }` to stage the text without sending.
   */
  async sendPrompt(id: string, text: string, opts: { submit?: boolean } = {}): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`unknown session ${id}`);
    // Inside a paste the TUI treats CR as a literal newline, not a submit.
    const body = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r");
    this.client.writePane(session.ptyId, `${PASTE_START}${body}${PASTE_END}`);
    if (opts.submit ?? true) {
      await sleep(120);
      this.client.writePane(session.ptyId, "\r");
    }
  }

  /** Send Ctrl-C (interrupt the current turn). */
  interrupt(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.client.writeBytes(session.ptyId, Buffer.from([0x03]));
  }

  async kill(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.tailer.stop();
    try {
      await this.client.kill(session.ptyId);
    } catch {
      // already gone
    }
    session.status = "exited";
    this.emit("status", id, "exited");
    this.sessions.delete(id);
  }
}
