// Run with: npx tsx --test src/harness.test.ts  (no extra test deps; uses node:test)
//
// ClaudeHarness.create() is the only public constructor, and it connects a
// real PupptyeerClient. To test sendPrompt's picker guard without a daemon,
// these tests build the instance directly (`new ClaudeHarness()`) and inject
// a fake client plus a minimal session record through casts, bypassing the
// private fields the same way a hand-rolled test double always has to when a
// class exposes no seam for it. sendPrompt only ever reads `session.ptyId`,
// so the fake session doesn't need a real tailer or any other Session field.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Screen } from "pupptyeer-client";
import { ClaudeHarness, PickerOpenError } from "./harness.js";

class FakeClient {
  writes: string[] = [];
  captureCalls = 0;
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
