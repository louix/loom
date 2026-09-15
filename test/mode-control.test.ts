import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSnapshot } from "@loom/core/wire";
import type { SessionMode } from "@loom/core/types";
import { mkModeControl, pendingMode } from "@loom/tui/mode-control";
import { modeChipText } from "@loom/tui/theme";
import { snap } from "./tui-fixtures.ts";

/** A controller over a mutable session list, with `session.setMode` parked so a
 *  test can settle each call by hand. The debounce is short but real. */
const mkModes = (sessions: SessionSnapshot[], debounceMs = 5) => {
  const sent: SessionMode[] = [];
  const calls: Array<{ ok: () => void; fail: (e: unknown) => void }> = [];
  const notes: string[] = [];
  const reviews: string[] = [];
  const ctl = mkModeControl({
    setMode: (_id, mode) => {
      sent.push(mode);
      return new Promise<void>((res, rej) => calls.push({ ok: () => res(), fail: rej }));
    },
    fleet: () => sessions,
    note: (text) => notes.push(text),
    planPending: (id) => reviews.push(id),
    debounceMs,
  });
  const wait = (ms = debounceMs * 4): Promise<void> =>
    new Promise((r) => setTimeout(r, ms)) as Promise<void>;
  return {
    ctl,
    sent,
    calls,
    notes,
    reviews,
    wait,
    choice: (id: string) => ctl.get()[id],
    pending: (id: string) => pendingMode(ctl.get(), id),
  };
};

test("a rapid cycle shows every press and applies only the mode it settles on", async () => {
  const m = mkModes([snap({ id: "a", status: "idle", mode: "default" })]);

  m.ctl.cycle("a");
  // Feedback is immediate — before any network work — and it names the target
  // without touching the applied mode, which is still the snapshot's.
  assert.equal(m.pending("a"), "plan");
  assert.equal(modeChipText("default", m.pending("a")), "[plan]");
  assert.deepEqual(m.sent, [], "nothing has gone to the daemon yet");

  m.ctl.cycle("a");
  m.ctl.cycle("a");
  assert.equal(m.pending("a"), "auto", "each press moves on from the target, not the snapshot");

  await m.wait();
  // `plan` is not a permission level — it flips the SDK session into plan mode
  // — so a cycle through it must not stop there on the way to `auto`.
  assert.deepEqual(m.sent, ["auto"]);
  assert.deepEqual(m.notes, ["mode → plan", "mode → acceptEdits", "mode → auto"]);
});

test("a press during an outstanding mode change is kept, and applied when it settles", async () => {
  const m = mkModes([snap({ id: "a", status: "idle", mode: "default" })]);
  m.ctl.cycle("a");
  await m.wait();
  assert.deepEqual(m.sent, ["plan"]);
  assert.equal(m.pending("a"), "plan");

  m.ctl.cycle("a");
  m.ctl.cycle("a");
  await m.wait();
  assert.deepEqual(m.sent, ["plan"], "one application is outstanding per session");
  assert.equal(m.pending("a"), "auto", "the last target replaces intermediate choices");

  m.calls[0]!.ok();
  await m.wait();
  assert.deepEqual(m.sent, ["plan", "auto"], "the target chosen meanwhile went on the same rules");

  m.calls[1]!.ok();
  await m.wait();
  assert.equal(m.pending("a"), null, "nothing pending — the chip is the snapshot's again");
});

test("a refused mode change gives the chip back to the daemon and stops there", async () => {
  const m = mkModes([snap({ id: "a", status: "idle", mode: "default" })]);
  m.ctl.cycle("a");
  await m.wait();
  m.ctl.cycle("a"); // queued behind the call in flight

  m.calls[0]!.fail(new Error("provider said no"));
  await m.wait();
  assert.equal(m.pending("a"), null, "the authoritative mode is the one shown");
  assert.deepEqual(m.sent, ["plan"], "the target behind it is dropped, not applied blind");
  assert.match(m.notes.at(-1)!, /mode switch failed: provider said no/);
});

test("a mode change that may have arrived waits for the user, not for a retry", async () => {
  const m = mkModes([snap({ id: "a", status: "idle", mode: "default" })]);
  m.ctl.cycle("a");
  await m.wait();
  m.calls[0]!.fail(Object.assign(new Error("dropped"), { code: "disconnected" }));
  await m.wait();
  assert.deepEqual(m.sent, ["plan"], "no automatic re-send — the daemon may have taken it");
  assert.equal(m.pending("a"), null);
  assert.match(m.notes.at(-1)!, /may not have arrived/);
});

test("a session refusing to leave plan opens the review instead of answering it", async () => {
  const m = mkModes([snap({ id: "a", status: "idle", mode: "plan" })]);
  m.ctl.cycle("a");
  await m.wait();
  m.calls[0]!.fail(Object.assign(new Error("plan review is pending"), { code: "plan_pending" }));
  await m.wait();
  assert.deepEqual(m.reviews, ["a"], "the real plan-review UI, not a chip that silently allows");
  assert.match(m.notes.at(-1)!, /plan review is pending/);
  assert.equal(m.pending("a"), null, "the chip says `plan`, which is where the session still is");
});

test("a session that goes takes its scheduled mode change with it", async () => {
  const sessions = [snap({ id: "a", status: "idle", mode: "default" })];
  const m = mkModes(sessions);
  m.ctl.cycle("a");
  sessions.length = 0;
  m.ctl.settle();
  assert.equal(m.pending("a"), null, "the choice is forgotten with the session");
  await m.wait();
  assert.deepEqual(m.sent, [], "and the timer it left behind fires at nothing");

  m.ctl.cycle("a");
  assert.deepEqual(m.notes.at(-1), "session is gone");
});

test("cancelled or disposed mode applications cannot revive a queued target", async () => {
  for (const dispose of [false, true]) {
    const m = mkModes([snap({ id: "a", status: "idle", mode: "default" })]);
    m.ctl.cycle("a");
    await m.wait();
    m.ctl.cycle("a");
    if (dispose) m.ctl.dispose();
    else m.ctl.cancel();
    const notes = [...m.notes];
    m.calls[0]!.ok();
    await m.wait();
    assert.deepEqual(m.sent, ["plan"]);
    assert.deepEqual(m.notes, notes);
    m.ctl.dispose();
  }
});
