// Run with: npx tsx --test src/harness.test.ts  (no extra test deps; uses node:test)
//
// ClaudeHarness.create() is the only public constructor, and it connects a
// real PupptyeerClient. To test sendPrompt's picker guard without a daemon,
// these tests build the instance directly (`new ClaudeHarness()`) and inject
// a fake client plus a minimal session record through casts, bypassing the
// private fields the same way a hand-rolled test double always has to when a
// class exposes no seam for it. sendPrompt only ever reads `session.ptyId`,
// so the fake session doesn't need a real tailer or any other Session field.
//
// The exit-watcher tests below (watchExits:) follow the same approach: the
// harness is built directly and never goes through createSession(), so the
// real setInterval-driven watcher never starts. Instead each test calls the
// private `watchExits()` method directly (also via a cast) to run exactly one
// poll on demand - no real or fake timers needed at all, so the suite stays
// fast and deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NewSessionOptions, Screen, SessionInfo } from "pupptyeer-client";
import { ClaudeHarness, PickerOpenError } from "./harness.js";

class FakeClient {
  writes: string[] = [];
  captureCalls = 0;
  listSessionsCalls = 0;
  /**
   * Scripts what listSessions() resolves (or rejects) to across successive
   * calls. While more than one entry remains, each call shifts one off; once
   * exactly one is left, it is returned (or thrown) on every further call
   * without being consumed. That lets a test script an exact per-poll
   * sequence (e.g. [[s1], []] - present, then gone) or set a single
   * steady-state value/error that holds across as many polls as it drives.
   */
  listSessionsResults: Array<SessionInfo[] | Error> = [[]];
  /** Every options object createSession's newSession call was given, recorded verbatim. */
  newSessionCalls: NewSessionOptions[] = [];

  constructor(
    private readonly screen: Screen | null = null,
    private readonly rejectCapture = false,
  ) {}

  writePane(_ptyId: string, data: string): void {
    this.writes.push(data);
  }

  writeBytes(_ptyId: string, _data: Uint8Array | Buffer): void {
    // Unused by sendPrompt; present only so a fake stands in for the client shape.
  }

  async captureScreen(_ptyId: string, _opts?: { settleMs?: number; timeoutMs?: number }): Promise<Screen> {
    this.captureCalls++;
    if (this.rejectCapture) throw new Error("simulated capture failure");
    return this.screen ?? emptyScreen();
  }

  async listSessions(): Promise<SessionInfo[]> {
    this.listSessionsCalls++;
    const next = this.listSessionsResults.length > 1 ? this.listSessionsResults.shift()! : this.listSessionsResults[0];
    if (next instanceof Error) throw next;
    return next;
  }

  async newSession(opts: NewSessionOptions): Promise<string> {
    this.newSessionCalls.push(opts);
    return `pty-${this.newSessionCalls.length}`;
  }

  async kill(_ptyId: string): Promise<void> {
    // Unused by the assertions below; present only so createSession's cleanup
    // kill() call (used to stop the tailer/exit-watch timers this test's
    // createSession() call started for real) has somewhere to land.
  }
}

function emptyScreen(): Screen {
  return { cols: 40, rows: 0, lines: [], cursor: { row: 0, col: 0, visible: false }, altScreen: false };
}

function pickerScreen(): Screen {
  return {
    cols: 40,
    rows: 2,
    lines: ["❯ 1. Yes, I trust this folder", "  2. No"],
    // A real picker hides the cursor entirely (see the captured
    // AskUserQuestion state in detect.test.ts); a visible cursor sitting on
    // this same row would instead be the caller's own staged, not-yet-
    // submitted numbered text, which pickerOwnsInput must NOT treat as a
    // picker.
    cursor: { row: 0, col: 0, visible: false },
    altScreen: false,
  };
}

function readyScreen(): Screen {
  return { cols: 40, rows: 1, lines: ["❯ "], cursor: { row: 0, col: 2, visible: true }, altScreen: false };
}

/** Build a harness wired to `fake`, with one session ("s1" -> "pty-1") pre-seeded. */
function harnessWithSession(fake: FakeClient, readiness: "screen" | "delay" = "screen"): ClaudeHarness {
  const h = new ClaudeHarness();
  (h as any).client = fake;
  (h as any).readiness = readiness;
  (h as any).sessions.set("s1", { ptyId: "pty-1" });
  return h;
}

test("sendPrompt: a picker on screen rejects with PickerOpenError and writes nothing", async () => {
  const fake = new FakeClient(pickerScreen());
  const h = harnessWithSession(fake);
  await assert.rejects(h.sendPrompt("s1", "hello"), (err: unknown) => {
    assert.ok(err instanceof PickerOpenError);
    assert.equal((err as PickerOpenError).code, "picker_open");
    return true;
  });
  assert.equal(fake.writes.length, 0, "no bytes should have been written");
});

test("sendPrompt: no picker writes the paste and the trailing Enter", async () => {
  const fake = new FakeClient(readyScreen());
  const h = harnessWithSession(fake);
  await h.sendPrompt("s1", "hello");
  assert.equal(fake.writes.length, 2);
  assert.ok(fake.writes[0].includes("hello"));
  assert.equal(fake.writes[1], "\r");
});

test("sendPrompt: force bypasses the check even with a picker on screen", async () => {
  const fake = new FakeClient(pickerScreen());
  const h = harnessWithSession(fake);
  await h.sendPrompt("s1", "hello", { force: true });
  assert.equal(fake.captureCalls, 0, "captureScreen should never be called under force");
  assert.equal(fake.writes.length, 2);
});

test("sendPrompt: a capture failure fails open and the send goes through", async () => {
  const fake = new FakeClient(null, /* rejectCapture */ true);
  const h = harnessWithSession(fake);
  await h.sendPrompt("s1", "hello");
  assert.equal(fake.writes.length, 2);
});

test('sendPrompt: readiness "delay" never captures, even with a picker on screen', async () => {
  const fake = new FakeClient(pickerScreen());
  const h = harnessWithSession(fake, "delay");
  await h.sendPrompt("s1", "hello");
  assert.equal(fake.captureCalls, 0, "captureScreen should never be called in delay mode");
  assert.equal(fake.writes.length, 2);
});

test("sendPrompt: submit: false with a picker on screen still throws and writes nothing", async () => {
  const fake = new FakeClient(pickerScreen());
  const h = harnessWithSession(fake);
  await assert.rejects(h.sendPrompt("s1", "hello", { submit: false }), PickerOpenError);
  assert.equal(fake.writes.length, 0);
});

test("sendPrompt: an unknown session id throws before ever capturing", async () => {
  const fake = new FakeClient(pickerScreen());
  const h = new ClaudeHarness();
  (h as any).client = fake;
  await assert.rejects(h.sendPrompt("nope", "hello"), /unknown session/);
  assert.equal(fake.captureCalls, 0);
});

// --- createSession: env -----------------------------------------------------
//
// createSession builds a fresh session for real (id, tailer, driveStartup),
// unlike the seam above, so each test here uses a FakeClient whose
// captureScreen resolves readyScreen() - driveStartup then reaches readiness
// on its first capture instead of polling on a real timer - and calls kill()
// once it's done asserting, so the tailer's poll interval and the exit
// watcher (both real setInterval timers by this point) are stopped before the
// test ends rather than left dangling for the rest of the suite.
//
// baseOpts is shared across both tests below with every optional field given
// an explicit, non-default value so the two calls are identical apart from
// env: that's what lets asserting the same command/args/cwd/cols/rows in
// both stand in for "the other session-creation arguments are unaffected by
// supplying env," rather than that being a claim taken on faith.
const baseOpts = {
  cwd: "/tmp",
  command: "claude",
  model: "opus",
  permissionMode: "acceptEdits",
  extraArgs: ["--foo"],
  cols: 100,
  rows: 30,
};

test("createSession: env is passed through verbatim to newSession", async () => {
  const fake = new FakeClient(readyScreen());
  const h = new ClaudeHarness();
  (h as any).client = fake;

  const summary = await h.createSession({ ...baseOpts, env: { FOO: "bar" } });
  assert.equal(fake.newSessionCalls.length, 1);
  const call = fake.newSessionCalls[0];
  assert.deepEqual(call.env, { FOO: "bar" });
  assert.equal(call.command, "claude");
  assert.deepEqual(call.args, ["--session-id", summary.id, "--permission-mode", "acceptEdits", "--model", "opus", "--foo"]);
  assert.equal(call.cwd, "/tmp");
  assert.equal(call.cols, 100);
  assert.equal(call.rows, 30);

  await h.kill(summary.id);
});

test("createSession: env is omitted entirely from newSession when not supplied", async () => {
  const fake = new FakeClient(readyScreen());
  const h = new ClaudeHarness();
  (h as any).client = fake;

  const summary = await h.createSession({ ...baseOpts });
  assert.equal(fake.newSessionCalls.length, 1);
  const call = fake.newSessionCalls[0];
  assert.equal("env" in call, false, "env must be absent from the options object, not sent as null or {}");
  assert.equal(call.command, "claude");
  assert.deepEqual(call.args, ["--session-id", summary.id, "--permission-mode", "acceptEdits", "--model", "opus", "--foo"]);
  assert.equal(call.cwd, "/tmp");
  assert.equal(call.cols, 100);
  assert.equal(call.rows, 30);

  await h.kill(summary.id);
});

// --- exit watcher -----------------------------------------------------------

/** A SessionInfo as listSessions() would return it, keyed by ptyId (its `id`). */
function sessionInfo(ptyId: string, alive = true): SessionInfo {
  return {
    id: ptyId,
    namespace: "claude-pty-web-harness",
    command: "claude",
    cols: 120,
    rows: 40,
    created: "2026-01-01T00:00:00.000Z",
    last_activity: "2026-01-01T00:00:00.000Z",
    attached: 0,
    alive,
  };
}

/**
 * A harness wired to `fake`, with the given sessions pre-seeded directly into
 * the private map (the same cast-based seam harnessWithSession above uses).
 * watchExits/transitionExited only ever touch ptyId, status, and
 * tailer.stop(), so that's all each fake session needs.
 */
function harnessWithSessions(fake: FakeClient, sessions: Record<string, { ptyId: string }>): ClaudeHarness {
  const h = new ClaudeHarness();
  (h as any).client = fake;
  for (const [id, opts] of Object.entries(sessions)) {
    (h as any).sessions.set(id, {
      id,
      ptyId: opts.ptyId,
      status: "ready",
      tailer: {
        stopped: false,
        stop(this: { stopped: boolean }) {
          this.stopped = true;
        },
      },
    });
  }
  return h;
}

/** Collects ("status" event) calls as they fire, in order. */
function collectStatusEvents(h: ClaudeHarness): Array<[string, string]> {
  const events: Array<[string, string]> = [];
  h.on("status", (id: string, status: string) => events.push([id, status]));
  return events;
}

test("watchExits: a tracked session missing from listSessions transitions to exited", async () => {
  const fake = new FakeClient();
  fake.listSessionsResults = [[]]; // steady-state: pty-1 never appears again
  const h = harnessWithSessions(fake, { s1: { ptyId: "pty-1" } });
  const events = collectStatusEvents(h);

  await (h as any).watchExits();

  assert.deepEqual(events, [["s1", "exited"]]);
  assert.equal(h.get("s1"), undefined, "gone from get()");
  assert.equal(h.list().length, 0, "gone from list()");
});

test("watchExits: a session present and alive is left alone across several polls", async () => {
  const fake = new FakeClient();
  fake.listSessionsResults = [[sessionInfo("pty-1", true)]]; // steady-state: always present and alive
  const h = harnessWithSessions(fake, { s1: { ptyId: "pty-1" } });
  const events = collectStatusEvents(h);

  await (h as any).watchExits();
  await (h as any).watchExits();
  await (h as any).watchExits();

  assert.equal(events.length, 0, "no status event for a live session");
  assert.equal(h.get("s1")?.status, "ready");
});

test("watchExits: a session present with alive:false transitions to exited", async () => {
  const fake = new FakeClient();
  fake.listSessionsResults = [[sessionInfo("pty-1", false)]];
  const h = harnessWithSessions(fake, { s1: { ptyId: "pty-1" } });
  const events = collectStatusEvents(h);

  await (h as any).watchExits();

  assert.deepEqual(events, [["s1", "exited"]]);
  assert.equal(h.get("s1"), undefined);
});

test("watchExits: a failing listSessions marks nothing, across repeated failures", async () => {
  const fake = new FakeClient();
  fake.listSessionsResults = [new Error("simulated dropped daemon connection")];
  const h = harnessWithSessions(fake, { s1: { ptyId: "pty-1" } });
  const events = collectStatusEvents(h);

  await (h as any).watchExits();
  await (h as any).watchExits();
  await (h as any).watchExits();

  assert.equal(events.length, 0, "an error must never be read as evidence of death");
  assert.equal(h.get("s1")?.status, "ready");
  assert.equal(fake.listSessionsCalls, 3);
});

test("watchExits: a ptyId this harness never created is ignored entirely", async () => {
  const fake = new FakeClient();
  // s1's own ptyId is present and alive (so this isn't also exercising a
  // death), plus one extra entry - another port's session in the shared
  // namespace - that this harness never tracked.
  fake.listSessionsResults = [[sessionInfo("pty-1", true), sessionInfo("someone-elses-pty", false)]];
  const h = harnessWithSessions(fake, { s1: { ptyId: "pty-1" } });
  const events = collectStatusEvents(h);

  await (h as any).watchExits();

  assert.equal(events.length, 0, "a foreign ptyId must produce no event and not crash");
  assert.equal(h.get("s1")?.status, "ready");
});

test("watchExits: a session that dies before any poll ever saw it alive is still detected", async () => {
  const fake = new FakeClient();
  fake.listSessionsResults = [[]]; // died within the first poll interval
  const h = harnessWithSessions(fake, { s1: { ptyId: "pty-1" } });
  const events = collectStatusEvents(h);

  await (h as any).watchExits();

  // An earlier version required one prior alive sighting before trusting an
  // absence, to guard a create-then-list race. Probing the real daemon showed
  // that race does not exist (newSession only resolves once the session is
  // registered, and a create-then-list-immediately loop never once missed it),
  // while the guard silently lost exactly this case: a session dying inside
  // the first interval was never reported dead at all. Caught by an end to end
  // test against a real daemon that the fakes here had passed.
  assert.deepEqual(events, [["s1", "exited"]]);
  assert.equal(h.get("s1"), undefined);
});
