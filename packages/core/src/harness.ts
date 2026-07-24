// ClaudeHarness: the extractable core. Drives Claude Code inside a pupptyeer
// pty and turns its JSONL transcript into a stream of ChatEvents.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { resolve as resolvePath, sep } from "node:path";
import { PupptyeerClient } from "pupptyeer-client";
import type { Screen, SessionInfo } from "pupptyeer-client";
import { JsonlTailer } from "./jsonl.js";
import type { ImageSink } from "./jsonl.js";
import { decodeImage } from "./blob.js";
import {
  readyForInput,
  hasInputPrompt,
  pickerOwnsInput,
  hasBypassWarning,
  hasTrustModal,
  hasStylePicker,
  isReadyFooter,
  hasExitConfirm,
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

// sendPrompt's picker-guard capture: a short settle/timeout, not startup's
// (300/1500), since this only ever needs to catch a picker that is already
// sitting still on screen - see sendPrompt's doc comment for the argument.
const PICKER_CHECK_SETTLE_MS = 150;
const PICKER_CHECK_TIMEOUT_MS = 1000;

/**
 * How often the exit watcher polls listSessions() to catch a tracked session
 * whose pty died on its own (a crash, an /exit, an OOM, a daemon restart)
 * without ever passing through kill(). A few hundred ms of latency to notice
 * a death doesn't matter for a status a UI renders, and this call covers
 * every tracked session at once, not one call per session. Mirrored in the
 * Python port as EXIT_WATCH_INTERVAL_MS (same name, same value in
 * milliseconds - asyncio.sleep there just divides by 1000 at the call site).
 */
const EXIT_WATCH_INTERVAL_MS = 2000;

/**
 * Graceful-shutdown grace windows. shutdown() sends two Ctrl-C's (the TUI's
 * quit gesture); SHUTDOWN_CLEAN_EXIT_MS is how long to wait for claude to exit
 * on its own when it has no background work to tear down, and
 * SHUTDOWN_CONFIRM_EXIT_MS is how long to wait after confirming the "Exit
 * anyway" modal when it does. If either elapses, shutdown() falls back to the
 * hard kill(). Mirrored in the Python port (same names lower-cased, same ms).
 */
const SHUTDOWN_CLEAN_EXIT_MS = 1000;
const SHUTDOWN_CONFIRM_EXIT_MS = 3000;

/**
 * How often waitExit() re-checks listSessions() while waiting out a graceful
 * quit. Clamped to the remaining budget at each step so a wait never overshoots
 * it. Mirrored in the Python port as WAIT_EXIT_POLL_MS (same value in ms).
 */
const WAIT_EXIT_POLL_MS = 100;

/**
 * Thrown by createSession when the requested cwd resolves outside the configured
 * allowedRoots. Carries a stable `code` so a transport can map it to a 403
 * without depending on the message or an instanceof check across module bounds.
 */
export class CwdNotAllowedError extends Error {
  readonly code = "cwd_not_allowed";
  constructor(message: string) {
    super(message);
    this.name = "CwdNotAllowedError";
  }
}

/**
 * Thrown by sendPrompt when a picker owns the input (pickerOwnsInput) and
 * `force` was not set: writing the trailing Enter would confirm whichever
 * option is highlighted instead of submitting the prompt. Carries a stable
 * `code` so a transport can map it to a 409 without depending on the message
 * or an instanceof check across module bounds, the same pattern as
 * CwdNotAllowedError above.
 */
export class PickerOpenError extends Error {
  readonly code = "picker_open";
  constructor(message: string) {
    super(message);
    this.name = "PickerOpenError";
  }
}

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
  /**
   * Environment for the spawned process, merged by the daemon over its own.
   * Exposed because some behaviour of the launched CLI is only configurable
   * through the environment, and the alternative is setting it on the daemon
   * itself, which would leak into every other app's sessions in the shared
   * namespace rather than just this one.
   */
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

/** One stored image blob: decoded bytes (never base64) plus its media type. */
export interface ImageBlob {
  bytes: Buffer;
  mediaType: string;
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
  // Per-session image store, keyed by the content-hash blobId embedded in
  // ChatEvent image parts. Populated by the ImageSink handed to the tailer as
  // JSONL is parsed, so a ChatEvent never carries raw bytes; freed with the
  // rest of the session on kill() since it's just a field on this object.
  blobs: Map<string, ImageBlob>;
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
  private exitWatchTimer: NodeJS.Timeout | undefined;
  // Guards against an overlapping poll if a listSessions() round-trip ever
  // outlasts the interval, the same reentrancy guard JsonlTailer's tick()
  // uses for the same reason.
  private exitWatchInFlight = false;
  // Graceful-shutdown grace windows, defaulted from the module consts and kept
  // as fields only so a test can shrink them (via the same cast-based seam the
  // suite already uses for `client`/`readiness`) instead of waiting out real
  // seconds; nothing in the public API sets them.
  private shutdownCleanExitMs = SHUTDOWN_CLEAN_EXIT_MS;
  private shutdownConfirmExitMs = SHUTDOWN_CONFIRM_EXIT_MS;

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
    throw new CwdNotAllowedError(`cwd ${resolved} is outside the allowed roots`);
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

  /**
   * Bytes + mediaType for a stored image blob, or undefined if the session or
   * the blobId is unknown. The caller (the server's blob route) is
   * responsible for validating blobId's shape before ever reaching here.
   */
  blob(sessionId: string, blobId: string): ImageBlob | undefined {
    return this.sessions.get(sessionId)?.blobs.get(blobId);
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
      ...(opts.env ? { env: opts.env } : {}),
    });

    const blobs = new Map<string, ImageBlob>();
    // Decode, hash, and stash each image block's bytes as the JSONL is
    // parsed, so a ChatEvent handed to a subscriber (or replayed on
    // reconnect) never carries raw base64 - only the {blobId, mediaType,
    // bytes} the protocol allows. Same hash in -> same blobId out, so
    // identical images (even across tool calls) dedupe to one store entry.
    // decodeImage does the one decode this needs; bytes.length (not a second,
    // independent decode) is what's reported back as the ContentPart's size.
    const onImage: ImageSink = ({ base64, mediaType }) => {
      const { blobId, bytes } = decodeImage(base64);
      if (!blobs.has(blobId)) blobs.set(blobId, { bytes, mediaType });
      return { blobId, bytes: bytes.length };
    };

    const tailer = new JsonlTailer(id, undefined, onImage);
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
      blobs,
    };
    this.sessions.set(id, session);
    this.ensureExitWatch();

    // Stream structured chat events from the persisted JSONL.
    tailer.on("event", (ev: ChatEvent) => {
      session.events.push(ev);
      this.emit("chat", id, ev);
    });
    tailer.start();

    // Drive past the startup modals to readiness, reading the daemon's rendered
    // screen (no local terminal emulation needed). Launched fire-and-forget, so
    // a throwing writePane/writeBytes must be caught here or it becomes an
    // unhandled rejection that can kill the process; fail the session instead
    // (markFailed no-ops if it already resolved).
    void this.driveStartup(session).catch(() => this.markFailed(session, "startup_timeout"));

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
    // Same guard as markFailed: a kill during the captureScreen await can remove
    // the session or flip its status, and we must not emit a bogus "ready" after.
    if (!this.sessions.has(session.id) || session.status !== "starting") return;
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
    // Stop tailing so a failed session doesn't keep its 200ms poll timer alive
    // forever. The pty is left running (documented) so the caller can inspect it.
    session.tailer.stop();
    this.emit("status", session.id, "failed", reason);
  }

  /**
   * Deliver a prompt as a bracketed paste so multi-line text lands in the TUI
   * input intact, then (by default) submit it with a single Enter. Pass
   * `{ submit: false }` to stage the text without sending.
   *
   * Before writing anything - the check runs before the paste, not just
   * before the Enter, and applies even when `submit: false` - this checks
   * whether a picker owns the input (pickerOwnsInput). If it does, the
   * trailing Enter would confirm whichever option is highlighted rather than
   * submit the prompt, so both the paste and the Enter are withheld and
   * PickerOpenError is thrown instead. Pass `{ force: true }` to skip the
   * check and restore the unconditional old behaviour.
   *
   * The check itself is one captureScreen call, and failing open when it
   * returns null (a timeout or error) is deliberate, not a cop-out: a picker
   * sitting open produces no output, so the screen settles - and is observed
   * - almost immediately, while a screen that will not settle means claude is
   * busy streaming, which means no picker is open. The only state this check
   * cannot observe is the state that is already known to be safe.
   *
   * `readiness: "delay"` never captures a screen at all (capture wedges some
   * setups), so this check is skipped entirely in that mode and today's
   * unconditional-send behaviour is unchanged there.
   */
  async sendPrompt(id: string, text: string, opts: { submit?: boolean; force?: boolean } = {}): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`unknown session ${id}`);

    if (!opts.force && this.readiness === "screen") {
      const screen = await this.captureScreen(session.ptyId, PICKER_CHECK_SETTLE_MS, PICKER_CHECK_TIMEOUT_MS);
      if (screen && screen.lines.length && pickerOwnsInput(screen)) {
        throw new PickerOpenError(
          `session ${id} is showing an interactive picker; sending a prompt now would confirm the ` +
            `highlighted option instead. Answer or dismiss it first, or pass force to override.`,
        );
      }
    }

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

  /**
   * Graceful shutdown: quit claude the way a person does, so it tears down its
   * own background work instead of being SIGKILL'd out from under it. A
   * SessionStart plugin can arm a background task, and claude runs those in
   * their own process session (setsid, detached stdin), so neither kill()'s
   * pty Close (SIGHUP to the pty's foreground group) nor its SIGKILL to claude
   * ever reaches them - a monitor that doesn't voluntarily exit when claude
   * goes away would linger. Driving the TUI's own quit path is what makes
   * claude stop that work cleanly.
   *
   * Sends Ctrl-C twice (the TUI's quit gesture). If claude has nothing to tear
   * down it exits on the two Ctrl-C's alone; if it does, it shows the
   * "Background work is running / Exit anyway" modal with "Exit anyway"
   * preselected, which this confirms with a single Enter. Either way it waits a
   * bounded time for the pty to actually go, and falls back to the hard kill()
   * if it never does - so a wedged or unrecognized state can't hang teardown.
   *
   * In readiness: "delay" mode the daemon's screen capture is avoided entirely
   * (it can wedge claude there, the same reason sendPrompt skips its picker
   * check), so the modal can't be read: that mode still gets the two-Ctrl-C
   * clean-exit path but skips the confirm and falls straight through to kill()
   * when background work holds claude open.
   *
   * Always ends with the session transitioned to "exited": the graceful paths
   * call transitionExited directly, the fallback goes through kill(), and every
   * one of those no-ops safely if the exit watcher already transitioned the
   * session across one of the awaits below.
   */
  async shutdown(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;

    // Two Ctrl-C's, 150ms apart: the same 0x03 interrupt() writes, delivered
    // twice, is what the TUI reads as "quit".
    this.client.writeBytes(session.ptyId, Buffer.from([0x03]));
    await sleep(150);
    this.client.writeBytes(session.ptyId, Buffer.from([0x03]));

    // No background work -> claude exits on the two Ctrl-C's alone.
    if (await this.waitExit(session.ptyId, this.shutdownCleanExitMs)) {
      this.transitionExited(id, session);
      return;
    }

    // Still alive: it may be holding the "Exit anyway" modal. Read the screen
    // (screen mode only - capture is skipped in delay mode) and, if the modal
    // is up, confirm it with Enter and wait again for the clean exit.
    if (this.readiness === "screen") {
      const screen = await this.captureScreen(session.ptyId, 200, 1000);
      if (screen && hasExitConfirm(screen.lines.join("\n"))) {
        this.client.writePane(session.ptyId, "\r");
        if (await this.waitExit(session.ptyId, this.shutdownConfirmExitMs)) {
          this.transitionExited(id, session);
          return;
        }
      }
    }

    // Wedged, unrecognized, or delay mode with background work still holding
    // claude open: hard kill. kill() also transitions the session to "exited".
    await this.kill(id);
  }

  /**
   * Poll listSessions() until `ptyId` is gone (absent from the list, or listed
   * with alive === false) or `budgetMs` elapses; return whether it exited
   * within the budget. Used only by shutdown() to wait out a graceful quit -
   * the periodic exit watcher (watchExits) is what ultimately reports the exit
   * for status purposes, so this is a deliberately bounded local poll, not a
   * subscription.
   *
   * A failing listSessions() is treated as "not exited yet", never as an exit:
   * the same not-evidence-of-death stance watchExits takes, so a transient
   * daemon-connection error just burns a poll and the graceful wait keeps going
   * (worst case the budget elapses and shutdown falls back to kill()). The poll
   * interval is clamped to the remaining budget so a wait can't overshoot it,
   * and the first check runs before any sleep so an already-dead pty returns at
   * once.
   */
  private async waitExit(ptyId: string, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      try {
        const infos = await this.client.listSessions();
        const info = infos.find((i) => i.id === ptyId);
        if (!info || info.alive === false) return true;
      } catch {
        // Absence of information, not evidence of exit; keep waiting.
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await sleep(Math.min(WAIT_EXIT_POLL_MS, remaining));
    }
  }

  async kill(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      await this.client.kill(session.ptyId);
    } catch {
      // already gone
    }
    this.transitionExited(id, session);
  }

  /**
   * The one place a session becomes "exited": stop its JSONL tailer, flip
   * status, emit the "status" event, and drop it from the tracked map. Both
   * kill() (an explicit request) and the exit watcher (the pty died on its
   * own) funnel through this, so the two can never drift into producing
   * different end states for what a listener sees as the same transition.
   *
   * No-ops if `session` is no longer the tracked entry for `id` - it was
   * already transitioned by the other path (e.g. kill() and the watcher
   * racing on the same session across kill()'s own await). Cheap, and it
   * makes a double "exited" emission structurally impossible rather than
   * merely unlikely.
   */
  private transitionExited(id: string, session: Session): void {
    if (this.sessions.get(id) !== session) return;
    session.tailer.stop();
    session.status = "exited";
    this.emit("status", id, "exited");
    // No separate blob cleanup needed: session.blobs is just a field on the
    // Session object this drops, so it's freed with the rest of the session.
    this.sessions.delete(id);
    // Nothing left to poll for; don't keep the timer (and the process) alive
    // for sessions that no longer exist. See ensureExitWatch's doc comment
    // for why teardown lives here rather than on some harness-level close().
    if (this.sessions.size === 0) this.stopExitWatch();
  }

  /**
   * Start the exit watcher if it isn't already running. Called whenever a
   * session starts being tracked (createSession); a no-op once the timer
   * exists. ClaudeHarness has no close()/dispose() in this port (nor in the
   * Python port - checked both), so there is no harness-level lifecycle to
   * hook a teardown into. Tying the timer's lifetime to the tracked-session
   * count instead - started here, stopped in transitionExited once the last
   * one is gone - is "whatever lifecycle exists": it can't outlive the
   * harness's actual work, and a harness that is simply dropped without ever
   * killing its sessions is no worse off than it already was (its sessions,
   * and now its watcher, live as long as something still references them).
   */
  private ensureExitWatch(): void {
    if (this.exitWatchTimer) return;
    this.exitWatchTimer = setInterval(() => {
      void this.watchExits();
    }, EXIT_WATCH_INTERVAL_MS);
  }

  private stopExitWatch(): void {
    if (!this.exitWatchTimer) return;
    clearInterval(this.exitWatchTimer);
    this.exitWatchTimer = undefined;
  }

  /**
   * One poll of the exit watcher: ask the daemon which pty sessions are
   * still around and reconcile every session THIS harness tracks against it.
   *
   * A failed listSessions() is an absence of information, not evidence of
   * death - a dropped daemon connection must not read as every tracked
   * session dying at once - so any error here aborts the round before a
   * single session is touched; there is no code path from "the call threw"
   * to transitionExited. This is the load-bearing behavior of this method;
   * it is enforced by the early `return` inside the catch below, not by a
   * comment elsewhere hoping every future edit remembers it.
   *
   * listSessions() also returns the other port's sessions, since TS and
   * Python share HARNESS_NAMESPACE. Reconciling by looking up each TRACKED
   * ptyId in the result - rather than iterating the result and matching
   * outward - means a foreign ptyId is never even considered, let alone
   * acted on: this loop only ever visits `this.sessions`.
   */
  private async watchExits(): Promise<void> {
    if (this.exitWatchInFlight) return;
    this.exitWatchInFlight = true;
    try {
      let infos: SessionInfo[];
      try {
        infos = await this.client.listSessions();
      } catch {
        return;
      }
      const byPtyId = new Map(infos.map((info) => [info.id, info]));
      for (const session of [...this.sessions.values()]) {
        const info = byPtyId.get(session.ptyId);
        // Absent from the list, or present and explicitly not alive, both
        // mean the pty is gone. There is deliberately no grace period for a
        // session that has never yet been seen alive: newSession() only
        // resolves after the daemon has registered the session, so a tracked
        // ptyId is listed from the moment we know it exists (verified
        // against the real daemon over repeated create-then-list-immediately
        // rounds, with no sleep, and it was never once missing). An earlier
        // version required one prior alive sighting before trusting an
        // absence, guarding a race that does not exist, and it silently cost
        // the case that matters most: a session dying within the first poll
        // interval was then never reported dead at all.
        if (info && info.alive !== false) continue;
        this.transitionExited(session.id, session);
      }
    } finally {
      this.exitWatchInFlight = false;
    }
  }
}
