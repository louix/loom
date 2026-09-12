import { snap, fleet, daemon } from "./tui-fixtures.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AwaitReason, HarnessEvent } from "@loom/core/events";
import type { SessionInteraction } from "@loom/core/interaction";
import { stateIdle } from "@loom/core/session-state";
import type { ProviderInfo, SessionSnapshot } from "@loom/core/wire";
import { loadableFailed, loadableLoaded, loadablePending } from "@loom/core/loadable";
import type { PushFrame, EventPush, HistoryCursor, HistoryPage } from "@loom/core/wire";
import {
  actionsFor,
  allowedActs,
  commandsFor,
  cacheHeat,
  cacheStatus,
  childrenOf,
  defaultModeOf,
  defaultModelOf,
  defaultProviderId,
  effortPickItems,
  escapePicker,
  fleetHits,
  focusedChildOf,
  footerHints,
  groupsOf,
  initialState,
  newSettings,
  modelPickEmptyText,
  modelPickItems,
  modelSupportsEffort,
  providerColorOf,
  providerPickItems,
  versionMismatchAction,
  compactingFor,
  reduce,
  selectedSession,
  sessionLog,
  shownLog,
  sortSessions,
  visibleLog,
  type Action,
  type TuiState,
  connectionOf,
  fleetDaemon,
  fleetSessions,
} from "@loom/tui/model";
import {
  TRANSCRIPT_CAP,
  condenseLog,
  headFailed,
  headLoaded,
  olderFailed,
  olderLoaded,
  olderLoading,
  openTranscript,
  formatEvent,
  logRowCount,
  toLogLine,
  transcriptText,
  liveFrame,
  mkTranscript,
  transcriptLines,
  noTranscript,
  type Transcript,
  type LogLine,
} from "@loom/tui/transcript";
import { detailLayout, promptPaneRows, promptRows } from "@loom/tui/components";
import { buffer } from "@loom/tui/editor";
import {
  discussPrompt,
  heldPlan,
  makePicker,
  newPrompt,
  openPrompt,
  pickerCurrent,
  pickerVisible,
  promptKind,
  questionsPrompt,
  sessionPrompt,
  type NewSessionSettings,
  type Overlay,
  type Picker,
  type PickerDest,
  type PlanReview,
} from "@loom/tui/overlay";
import { activeRequest, liveQNav, mkInteractions, requestsFor } from "@loom/tui/interactions";
import { enqueue, outboxOf } from "@loom/tui/composer";
import { mkClock, mkDeadline, SPIN_MS, type Beat } from "@loom/tui/clock";
import { openFind } from "@loom/tui/fleet-search";

/** Put an overlay up — the action every open/close goes through. */
const open = (overlay: Overlay): Action => ({ t: "overlay", overlay });
const promptOf = (s: TuiState) => openPrompt(s.overlay);
const planOf = (s: TuiState) => (s.overlay.t === "plan" ? s.overlay.plan : null);
const pickerOf = (s: TuiState) => (s.overlay.t === "picker" ? s.overlay.picker : null);
const confirmOf = (s: TuiState) => (s.overlay.t === "confirm" ? s.overlay.confirm : null);

/** A `new` prompt's creation settings, as a fresh state produces them. */
const settings: NewSessionSettings = { mode: "default", provider: null, model: null, effort: null };
import {
  bar,
  humanTokens,
  money,
  setThemeMode,
  spinnerFrame,
  statusLook,
  themeMode,
  toneColor,
  truncate,
  wrapText,
} from "@loom/tui/theme";
import { loadPersistedTheme, persistTheme } from "@loom/tui/theme-store";

/** The request selectors read the daemon's snapshots, not the whole state. */
const reqs = (s: TuiState, id: string) => requestsFor(fleetSessions(s), id);
const shown = (s: TuiState, id: string) => activeRequest(fleetSessions(s), id);

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const ev = (over: Partial<HarnessEvent> & { type: HarnessEvent["type"] }): HarnessEvent => {
  return { sessionId: "s1", ts: 5_000, ...(over as object) } as HarnessEvent;
};

/**
 * A live push for an event the daemon persisted: `id` is its durable transcript
 * identity, the same one `session.events` returns for it. `seq` is a diagnostic
 * counter and does not identify anything in the transcript.
 */
const push = (id: number, event: HarnessEvent): EventPush => {
  return { kind: "push", seq: id, epoch: "e1", type: "event", event, id };
};

/** A live push the daemon did not persist — a heartbeat, with no durable id. */
const transient = (event: HarnessEvent): EventPush => {
  return { kind: "push", seq: 1, epoch: "e1", type: "event", event };
};

/** Every line the reducer holds: durable entries, then the derived queue markers. */
const lines = (s: TuiState): LogLine[] => sessionLog(s);

/** A `session.events` response carrying `entries` as one page. */
const historyPage = (
  entries: ReadonlyArray<{ id: number; event: HarnessEvent }>,
  olderCursor: HistoryCursor | null = null,
): HistoryPage => ({ items: entries.map((e) => ({ id: e.id, event: e.event })), olderCursor });

type WithTranscript = TuiState & { transcript: Transcript };
const pushed = (s: TuiState & { transcript?: Transcript }, frame: PushFrame): WithTranscript => ({
  ...reduce(s, { t: "push", frame }),
  transcript: liveFrame(s.transcript ?? noTranscript, frame),
});

/** The transcript opened on `sessionId`, as the handle does on selection. */
const opened = (s: TuiState = initialState(), sessionId = "s1"): WithTranscript => ({
  ...s,
  transcript: openTranscript(sessionId),
});

/** The newest page landing. */
const headPage = (s: WithTranscript, page: HistoryPage, sessionId = "s1"): WithTranscript => ({
  ...s,
  transcript: headLoaded(s.transcript, sessionId, page),
});

/** An older page landing. */
const olderPage = (s: WithTranscript, page: HistoryPage, sessionId = "s1"): WithTranscript => ({
  ...s,
  transcript: olderLoaded(s.transcript, sessionId, page),
});

/** A loaded, empty transcript following the live tail — what selecting a
 *  session and getting an empty first page leaves behind. */
const tailing = (s: TuiState = initialState(), sessionId = "s1"): WithTranscript =>
  headPage(opened(s, sessionId), historyPage([]), sessionId);

/** The loaded window, with its variant: `tailing` while it ends at the live
 *  tail, `detached` once paging back has evicted that end. */
const win = (s: WithTranscript) => {
  const t = s.transcript;
  assert.ok(t.t === "tailing" || t.t === "detached", `expected a window, got ${t.t}`);
  return t;
};

// ---------------------------------------------------------------------------
// hello / selection / ordering
// ---------------------------------------------------------------------------

test("hello seeds the daemon, sorts sessions, and selects the first", () => {
  const a = snap({ id: "a", status: "idle" });
  const b = snap({ id: "b", status: "running" });
  const s = reduce(initialState(), fleet([a, b]));
  assert.equal(connectionOf(s), "live");
  assert.deepEqual(fleetDaemon(s), daemon);
  assert.deepEqual(
    fleetSessions(s).map((x) => x.id),
    ["b", "a"], // running sorts ahead of idle
  );
  assert.equal(s.selectedId, "b");
});

test("hello keeps the current selection when that session is still present", () => {
  const a = snap({ id: "a", status: "running" });
  const b = snap({ id: "b", status: "running" });
  let s = reduce(initialState(), fleet([a, b]));
  s = reduce(s, { t: "select", id: "b" });
  s = reduce(s, fleet([b, a]));
  assert.equal(s.selectedId, "b");
});

test("sortSessions: status group first, then most-recently-updated", () => {
  const older = snap({ id: "old", status: "running", updatedAt: 10 });
  const newer = snap({ id: "new", status: "running", updatedAt: 99 });
  const waiting = snap({ id: "wait", status: "awaiting_input" });
  assert.deepEqual(
    sortSessions([older, newer, waiting]).map((x) => x.id),
    ["wait", "new", "old"],
  );
});

test("sortSessions: starting never outranks running, even when more recent", () => {
  const running = snap({ id: "run", status: "running", updatedAt: 10 });
  const starting = snap({ id: "start", status: "starting", updatedAt: 99 });
  assert.deepEqual(
    sortSessions([starting, running]).map((x) => x.id),
    ["run", "start"],
    "flat nav order must match the rendered section order (running above starting)",
  );
});

test("an optimistic select survives an unrelated snapshot until its row arrives (U4)", () => {
  const b = snap({ id: "b", status: "idle" });
  let s = reduce(initialState(), fleet([snap({ id: "a", status: "running" }), b]));
  // User creates session "new1"; its row hasn't landed yet.
  s = reduce(s, { t: "select", id: "new1" });
  assert.equal(s.selectedId, "new1");
  assert.equal(s.pendingSelectId, "new1");

  // An unrelated session changes; the snapshot still has no "new1".
  s = reduce(s, fleet([snap({ id: "a", status: "idle" }), b]));
  assert.equal(s.selectedId, "new1", "not bounced to the fleet head");

  // "new1" finally arrives — the hold is released.
  const created = snap({ id: "new1", status: "starting" });
  s = reduce(s, fleet([snap({ id: "a", status: "idle" }), b, created]));
  assert.equal(s.selectedId, "new1");
  assert.equal(s.pendingSelectId, undefined);

  // Once it's real, a snapshot without it means it was removed — and the hold
  // is not resurrected.
  s = reduce(s, fleet([snap({ id: "a", status: "idle" }), b]));
  assert.notEqual(s.selectedId, "new1");
  assert.equal(s.pendingSelectId, undefined);
});

test("move clamps at both ends of the sorted list", () => {
  const list = [
    snap({ id: "a", status: "awaiting_input" }),
    snap({ id: "b", status: "running" }),
    snap({ id: "c", status: "idle" }),
  ];
  let s = reduce(initialState(), fleet(list));
  assert.equal(s.selectedId, "a");
  s = reduce(s, { t: "move", delta: -1 });
  assert.equal(s.selectedId, "a", "cannot move above the top");
  s = reduce(s, { t: "move", delta: 1 });
  s = reduce(s, { t: "move", delta: 1 });
  s = reduce(s, { t: "move", delta: 1 });
  assert.equal(s.selectedId, "c", "cannot move past the bottom");
});

// ---------------------------------------------------------------------------
// fleet drill-down (child focus)
// ---------------------------------------------------------------------------

/** A session with the full fan-out: background tasks + one live, one settled sub-agent. */
const fanout = snap({
  id: "fan",
  status: "working_background",
  backgroundTasks: [
    { id: "task1", kind: "shell", title: "npm test --watch" },
    { id: "task2", kind: "subagent", title: "explore refs" },
  ],
  subagents: [
    { id: "t1", name: "reviewer", active: true },
    { id: "t2", name: "done-agent", active: false },
  ],
});

test("childrenOf lists live background tasks then active sub-agents", () => {
  assert.deepEqual(
    childrenOf(fanout).map((k) => k.key),
    ["bg:task1", "bg:task2", "sub:t1"],
  );
  assert.equal(childrenOf(snap({ id: "empty" })).length, 0);
});

test("childEnter lands on the first child; childMove clamps within the list", () => {
  let s = reduce(initialState(), fleet([fanout]));
  assert.equal(s.selectedChild, null);
  s = { ...s, ...reduce(s, { t: "childEnter" }) };
  assert.equal(s.selectedChild, "bg:task1");
  s = reduce(s, { t: "childMove", delta: 1 });
  s = reduce(s, { t: "childMove", delta: 1 });
  assert.equal(s.selectedChild, "sub:t1", "settled sub-agents are not selectable");
  s = reduce(s, { t: "childMove", delta: 1 });
  assert.equal(s.selectedChild, "sub:t1", "cannot move past the last child");
  s = reduce(s, { t: "childMove", delta: -3 });
  assert.equal(s.selectedChild, "bg:task1", "cannot move above the first child");
});

test("childEnter while focused keeps the current child; after an exit it restarts", () => {
  let s = reduce(initialState(), fleet([fanout]));
  s = reduce(s, { t: "childEnter" });
  s = { ...s, ...reduce(s, { t: "childMove", delta: 2 }) }; // → sub:t1
  s = reduce(s, { t: "childEnter" });
  assert.equal(s.selectedChild, "sub:t1", "→ again while focused doesn't jump");
  s = reduce(s, { t: "childExit" });
  assert.equal(s.selectedChild, null);
  s = reduce(s, { t: "childEnter" });
  assert.equal(s.selectedChild, "bg:task1", "a fresh entry starts at the first child");
});

test("childEnter on a session with no live children is a no-op", () => {
  let s = reduce(initialState(), fleet([snap({ id: "a" })]));
  s = reduce(s, { t: "childEnter" });
  assert.equal(s.selectedChild, null);
});

test("a drained child snaps to a survivor; an emptied list exits focus", () => {
  let s = reduce(initialState(), fleet([fanout]));
  s = reduce(s, { t: "childEnter" });
  s = reduce(s, { t: "childMove", delta: 1 }); // → bg:task2
  // Membership churn: the background tasks drained → snap to the first survivor.
  s = reduce(s, fleet([{ ...fanout, backgroundTasks: [] }]));
  assert.equal(s.selectedChild, "sub:t1");
  // Everything drains → the drill-down exits rather than pointing at nothing.
  s = reduce(s, fleet([{ ...fanout, backgroundTasks: [], subagents: [] }]));
  assert.equal(s.selectedChild, null);
});

test("changing the session selection clears the child focus", () => {
  const other = snap({ id: "other", status: "idle" });
  let s = reduce(initialState(), fleet([fanout, other]));
  s = reduce(s, { t: "childEnter" });
  assert.equal(s.selectedChild, "bg:task1");
  s = reduce(s, { t: "select", id: "other" });
  assert.equal(s.selectedChild, null);
  s = reduce(s, { t: "select", id: "fan" });
  s = reduce(s, { t: "childEnter" });
  s = reduce(s, { t: "move", delta: 1 });
  assert.equal(s.selectedId, "other");
  assert.equal(s.selectedChild, null, "moving between sessions drops the focus too");
});

test("selectChild selects the session and focuses the child; stale/unknown fall back", () => {
  let s = reduce(initialState(), fleet([snap({ id: "a", status: "idle" }), fanout]));
  s = reduce(s, { t: "selectChild", sessionId: "fan", key: "sub:t1" });
  assert.equal(s.selectedId, "fan");
  assert.equal(s.selectedChild, "sub:t1");

  // a key the fleet no longer renders → snap to the first live child.
  s = reduce(s, { t: "selectChild", sessionId: "fan", key: "sub:gone" });
  assert.equal(s.selectedChild, "bg:task1");

  // an unknown session → optimistic hold, no child.
  s = reduce(s, { t: "selectChild", sessionId: "ghost", key: "bg:x" });
  assert.equal(s.selectedId, "ghost");
  assert.equal(s.selectedChild, null);
  assert.equal(s.pendingSelectId, "ghost");
});

test("fleetHits maps every FLEET entry to its screen row", () => {
  const a = snap({ id: "a", status: "idle" });
  const b = snap({ id: "b", status: "idle" });
  let s = reduce(initialState(), fleet([a, b, fanout]));
  const geom = { originX: 1, listW: 40, originY: 2, maxY: 100 };

  const flat = fleetHits(s, geom);
  // Two status groups (working_background then idle, or vice-versa) — every
  // session is present, rows strictly increase, and the row span stays inside
  // the fleet column.
  const sessions = flat.filter((h) => h.kind === "session");
  assert.deepEqual(
    new Set(sessions.map((h) => (h.kind === "session" ? h.id : ""))),
    new Set(["a", "b", "fan"]),
  );
  for (const h of flat) {
    assert.equal(h.x0, 1);
    assert.equal(h.x1, 40);
  }
  const ys = flat.map((h) => h.y);
  assert.deepEqual(
    [...ys].sort((x, y) => x - y),
    ys,
    "rows are top-to-bottom",
  );
  assert.equal(new Set(ys).size, ys.length, "one entry per row");

  // Sessions in the same group sit on consecutive rows.
  const [ay, by] = [
    sessions.find((h) => h.kind === "session" && h.id === "a")!.y,
    sessions.find((h) => h.kind === "session" && h.id === "b")!.y,
  ];
  assert.equal(Math.abs(ay - by), 1);

  // `fan` is not drilled in: its 3 live children each get a `child` row, capped
  // rows would get a `childMore` (only 3 kids here, so none).
  const kids = flat.filter((h) => h.kind === "child");
  assert.deepEqual(
    kids.map((h) => (h.kind === "child" ? h.key : "")),
    ["bg:task1", "bg:task2", "sub:t1"],
  );
  const fanY = sessions.find((h) => h.kind === "session" && h.id === "fan")!.y;
  assert.deepEqual(
    kids.map((h) => h.y),
    [fanY + 1, fanY + 2, fanY + 3],
    "child rows follow their session row",
  );

  // maxY clips: nothing below the last visible row survives.
  assert.ok(fleetHits(s, { ...geom, maxY: fanY }).every((h) => h.y <= fanY));
});

test("fleetHits shifts every row down when the filter box is open", () => {
  const a = snap({ id: "a", status: "idle", title: "alpha" });
  let s = reduce(initialState(), fleet([a]));
  const geom = { originX: 1, listW: 40, originY: 2, maxY: 100 };
  const before = fleetHits(s, geom).find((h) => h.kind === "session")!.y;
  const after = fleetHits({ ...s, find: openFind() }, geom).find((h) => h.kind === "session")!.y;
  assert.equal(after - before, 2, "the marginTop + the InputLine push the list down");
});

test("detail layout points at the Detail status row's chip cell", () => {
  const plain = snap({ id: "p", status: "idle", mode: "default" });
  const hit = detailLayout(plain, { width: 80 }).hits({ x: 1, y: 2 })[0];
  assert.ok(hit);
  // border + DETAIL header + title + the status row's marginTop.
  assert.equal(hit!.y, 6);
  assert.ok(hit!.x0 > 1 && hit!.x1 >= hit!.x0);

  // account + fork lines each push the status row down one.
  const forked = snap({ id: "f", status: "idle", parentId: "p", forkTurn: 3 });
  const fh = detailLayout(forked, { width: 80, account: "x (y)" }).hits({ x: 1, y: 2 })[0];
  assert.equal(fh!.y, 8);

  assert.deepEqual(detailLayout(null, { width: 80 }).hits({ x: 1, y: 2 }), []);
  // a pane too narrow to fit the chip drops the region.
  assert.deepEqual(detailLayout(plain, { width: 8 }).hits({ x: 1, y: 2 }), []);
});

test("visibleLog: the main view hides child-tagged frames; a focused child narrows to them", () => {
  let s = tailing(reduce(initialState(), fleet([fanout])), "fan");
  s = pushed(s, push(1, ev({ sessionId: "fan", type: "assistant_text", text: "mainline" })));
  s = pushed(
    s,
    push(2, ev({ sessionId: "fan", type: "assistant_text", text: "from reviewer", agentId: "t1" })),
  );
  s = pushed(
    s,
    push(3, ev({ sessionId: "fan", type: "assistant_text", text: "from task", agentId: "task1" })),
  );
  assert.deepEqual(
    visibleLog(s).map((l) => l.text),
    ["mainline"],
  );
  s = { ...s, ...reduce(s, { t: "childEnter" }) };
  const child = focusedChildOf(s);
  assert.equal(child?.key, "bg:task1");
  assert.deepEqual(
    visibleLog(s, child).map((l) => l.text),
    ["from task"],
  );
  s = { ...s, ...reduce(s, { t: "childMove", delta: 2 }) }; // → sub:t1
  assert.deepEqual(
    visibleLog(s, focusedChildOf(s)).map((l) => l.text),
    ["from reviewer"],
  );
});

test("footerHints advertises the drill-down and the way back out", () => {
  let s = reduce(initialState(), fleet([fanout]));
  const keys = (st: TuiState) => footerHints(st).map((h) => h.keys);
  assert.ok(keys(s).includes("→"), "sessions with live children offer →");
  s = reduce(s, { t: "childEnter" });
  assert.equal(keys(s)[0], "←", "← leads while drilled in");
  assert.ok(!keys(s).includes("→"), "→ is redundant once focused");
  const bare = reduce(initialState(), fleet([snap({ id: "a" })]));
  assert.ok(!keys(bare).includes("→"), "childless sessions don't offer the drill-down");
});

test("a snapshot re-sorts the fleet and preserves selection", () => {
  const a = snap({ id: "a", status: "running", updatedAt: 1 });
  const b = snap({ id: "b", status: "running", updatedAt: 2 });
  let s = reduce(initialState(), fleet([a, b]));
  s = tailing(reduce(s, { t: "select", id: "a" }), "a");
  // a finishes its turn — should drop below b (idle group) but stay selected
  s = reduce(s, fleet([snap({ id: "a", status: "idle", updatedAt: 9 }), b]));
  assert.deepEqual(
    fleetSessions(s).map((x) => x.id),
    ["b", "a"],
  );
  assert.equal(s.selectedId, "a");
});

test("a session missing from the snapshot drops out and reselects the head", () => {
  const a = snap({ id: "a", status: "awaiting_input" });
  const b = snap({ id: "b", status: "running" });
  let s = reduce(initialState(), fleet([a, b]));
  s = reduce(s, { t: "select", id: "b" });
  s = reduce(s, fleet([a]));
  assert.deepEqual(
    fleetSessions(s).map((x) => x.id),
    ["a"],
  );
  assert.equal(s.selectedId, "a");
});

test("a removed session selects the row above, not the fleet head", () => {
  const a = snap({ id: "a", status: "awaiting_input" });
  const b = snap({ id: "b", status: "running" });
  const c = snap({ id: "c", status: "idle" });
  let s = reduce(initialState(), fleet([a, b, c]));
  assert.deepEqual(
    fleetSessions(s).map((x) => x.id),
    ["a", "b", "c"],
  );
  s = reduce(s, { t: "select", id: "b" });
  s = reduce(s, fleet([a, c]));
  // b sat between a and c — losing it should land on a (the row above), not
  // snap back to the fleet head.
  assert.deepEqual(
    fleetSessions(s).map((x) => x.id),
    ["a", "c"],
  );
  assert.equal(s.selectedId, "a");
});

test("a removed session falls back to the new head when it was already on top", () => {
  const a = snap({ id: "a", status: "awaiting_input" });
  const b = snap({ id: "b", status: "running" });
  let s = reduce(initialState(), fleet([a, b]));
  s = reduce(s, { t: "select", id: "a" });
  s = reduce(s, fleet([b]));
  // Nothing was above a — the only sensible landing spot is the new head.
  assert.deepEqual(
    fleetSessions(s).map((x) => x.id),
    ["b"],
  );
  assert.equal(s.selectedId, "b");
});

test("a snapshot's providers become the new-session defaults", () => {
  let s = withProviders();
  // The daemon remembered a different last-used provider / model — the next
  // snapshot replaces the connect-time list wholesale.
  const fresh: ProviderInfo[] = [
    { ...PROVIDERS[1]!, isDefault: true, defaultModel: "gpt-5-mini" },
    { ...PROVIDERS[0]!, isDefault: false },
  ];
  s = reduce(s, fleet(fleetSessions(s), fresh));
  assert.equal(defaultProviderId(s), "openai");
  assert.equal(defaultModelOf(s, "openai"), "gpt-5-mini");
});

// ---------------------------------------------------------------------------
// event log
// ---------------------------------------------------------------------------

test("event pushes append transcript lines in durable order", () => {
  let s = tailing();
  for (const id of [11, 12, 13]) {
    s = pushed(s, push(id, ev({ type: "assistant_text", text: `line ${id}`, sessionId: "s1" })));
  }
  assert.deepEqual(
    lines(s).map((l) => l.id),
    [11, 12, 13],
  );
});

test("a push with no durable id is a heartbeat, never a transcript line", () => {
  let s = tailing();
  s = pushed(
    s,
    transient(
      ev({
        type: "compact_progress",
        sessionId: "s1",
        ts: 10_000,
        elapsedMs: 4_000,
        generated: 128,
        before: 90_000,
      }),
    ),
  );
  assert.deepEqual(lines(s), [], "the daemon didn't persist it, so it isn't transcript");

  // The compaction the beat reports is read off the snapshot instead, so a
  // client that attached mid-compaction sees exactly what everyone else does.
  s = {
    ...s,
    ...reduce(
      s,
      fleet([
        snap({
          id: "s1",
          status: "running",
          compacting: { startedAt: 6_000, before: 90_000, generated: 128 },
        }),
      ]),
    ),
  };
  assert.deepEqual(compactingFor(s, "s1"), {
    startedAt: 6_000,
    before: 90_000,
    generated: 128,
  });

  // ...and it stops when the daemon stops reporting it, with no local
  // bookkeeping to get out of step. The landing `compact` event *is* transcript.
  s = pushed(
    s,
    push(
      3,
      ev({ type: "compact", sessionId: "s1", trigger: "manual", before: 90_000, after: 12_000 }),
    ),
  );
  s = { ...s, ...reduce(s, fleet([snap({ id: "s1", status: "idle" })])) };
  assert.equal(compactingFor(s, "s1"), null);
  assert.equal(lines(s).length, 1);
  assert.match(lines(s)[0]?.text ?? "", /context compacted/);
});

test("a repeated durable id folds once, and ids order the transcript, not timestamps", () => {
  let s = tailing();
  // Deliberately out of timestamp order: the provider reported the second entry
  // with an *earlier* clock than the first, and a burst shares a millisecond.
  s = pushed(s, push(1, ev({ type: "assistant_text", text: "first", sessionId: "s1", ts: 9_000 })));
  s = pushed(
    s,
    push(2, ev({ type: "assistant_text", text: "second", sessionId: "s1", ts: 1_000 })),
  );
  s = pushed(s, push(3, ev({ type: "assistant_text", text: "third", sessionId: "s1", ts: 1_000 })));
  assert.deepEqual(
    lines(s).map((l) => l.text),
    ["first", "second", "third"],
    "durable order, not clock order",
  );

  // A page overlapping the live stream supplies the same entry again.
  // One entry, and the reducer says nothing moved.
  const before = s;
  s = pushed(
    s,
    push(2, ev({ type: "assistant_text", text: "second", sessionId: "s1", ts: 1_000 })),
  );
  assert.deepEqual(
    lines(s).map((l) => l.text),
    ["first", "second", "third"],
  );
  assert.equal(lines(s).length, lines(before).length);
});

// ---------------------------------------------------------------------------
// transcript retention: one contiguous window, bounded at both ends
// ---------------------------------------------------------------------------

/** `n` durable entries ending at `lastId`, oldest first — one page's worth. */
const bulkPage = (lastId: number, n: number, olderCursor: HistoryCursor | null): HistoryPage => ({
  items: Array.from({ length: n }, (_, i) => {
    const id = lastId - n + 1 + i;
    return { id, event: ev({ type: "assistant_text", text: `line ${id}`, sessionId: "s1" }) };
  }),
  olderCursor,
});

/** A transcript at exactly the cap, following the live tail, with entries older
 *  than it still on the daemon. */
const atCapacity = (): WithTranscript =>
  headPage(opened(), bulkPage(11_000, TRANSCRIPT_CAP, { olderThan: 1_001 }));

test("the cap evicts the oldest lines and points the older cursor at them", () => {
  let s = atCapacity();
  assert.equal(win(s).lines.length, TRANSCRIPT_CAP);

  s = pushed(s, push(11_001, ev({ type: "assistant_text", text: "the newest", sessionId: "s1" })));

  const t = win(s);
  assert.equal(t.lines.length, TRANSCRIPT_CAP);
  assert.equal(t.lines[0]?.id, 1_002, "the oldest line was evicted");
  assert.equal(t.lines.at(-1)?.text, "the newest");
  assert.equal(t.t, "tailing", "the window still ends at the live tail");
  // The point of the whole exercise: running out of room here must never read
  // as the daemon running out of history, or scroll-back stops at the cap.
  assert.deepEqual(
    t.olderCursor,
    { olderThan: 1_002 },
    "eviction re-points the cursor at what it dropped, so the page is refetchable",
  );
});

test("three legal pages never retain more than the cap", () => {
  let s = headPage(opened(), bulkPage(15_000, 5_000, { olderThan: 10_001 }));
  s = olderPage(s, bulkPage(10_000, 5_000, { olderThan: 5_001 }));
  s = olderPage(s, bulkPage(5_000, 5_000, null));

  const t = win(s);
  assert.equal(t.lines.length, TRANSCRIPT_CAP, "15,000 legal entries, 10,000 retained");
  // Paging back keeps the end being read: the oldest, not the newest.
  assert.equal(t.lines[0]?.id, 1);
  assert.equal(t.lines.at(-1)?.id, 10_000);
  assert.equal(t.t, "detached", "the newest end was evicted, so the tail is no longer held");
  assert.equal(t.olderCursor, null, "and the retained front IS the daemon's oldest entry");
});

test("older paging at capacity advances, without looping or claiming false exhaustion", () => {
  let s = atCapacity();
  const cursors: Array<number | null> = [win(s).olderCursor?.olderThan ?? null];

  s = olderPage(s, bulkPage(1_000, 500, { olderThan: 501 }));
  cursors.push(win(s).olderCursor?.olderThan ?? null);
  s = olderPage(s, bulkPage(500, 500, null));
  cursors.push(win(s).olderCursor?.olderThan ?? null);

  assert.deepEqual(cursors, [1_001, 501, null], "each page starts strictly earlier than the last");
  const t = win(s);
  assert.equal(t.lines.length, TRANSCRIPT_CAP);
  assert.equal(t.lines[0]?.id, 1, "and the window reached the daemon's first entry");
});

test("a live event while browsing an older window changes nothing but the notice", () => {
  // Page back past the cap: the newest end is evicted and the window no longer
  // ends at the live tail.
  let s = olderPage(atCapacity(), bulkPage(1_000, 500, { olderThan: 501 }));
  const before = win(s);
  assert.equal(before.t, "detached");

  s = pushed(
    s,
    push(99_999, ev({ type: "permission_request", id: "p1", tool: "Bash", input: {} })),
  );

  const after = win(s);
  assert.equal(after.lines, before.lines, "the rows being read are untouched");
  assert.equal(
    after.lines.at(-1)?.id,
    before.lines.at(-1)?.id,
    "and nothing was appended across the evicted span",
  );
  assert.match(
    s.notice?.text ?? "",
    /Bash needs approval/,
    "the live event still reaches the user",
  );
});

test("jump to latest reloads the newest window; evicted older pages can return", () => {
  let s = olderPage(atCapacity(), bulkPage(1_000, 500, { olderThan: 501 }));
  assert.equal(win(s).t, "detached");

  // `End`: the handle reopens the transcript, which is what makes it refetch.
  s = opened(s);
  assert.equal(s.transcript.t, "loading");
  assert.deepEqual(sessionLog(s), [], "the older window is dropped");

  // The newest page lands, and paging back from it reaches entries the older
  // browsing session had evicted.
  s = headPage(s, bulkPage(11_000, 1_000, { olderThan: 10_001 }));
  assert.equal(win(s).t, "tailing");
  assert.equal(win(s).lines.at(-1)?.id, 11_000);
  s = olderPage(s, bulkPage(10_000, 1_000, { olderThan: 9_001 }));
  const t = win(s);
  assert.equal(t.lines[0]?.id, 9_001, "previously evicted entries are back");
  assert.equal(t.lines.length, 2_000);
});

test("duplicate and out-of-order live entries cannot bypass the cap or repeat an id", () => {
  let s = atCapacity();
  const same = ev({ type: "assistant_text", text: "again", sessionId: "s1" });
  s = pushed(s, push(11_001, same));
  s = pushed(s, push(11_001, same));
  // An entry the daemon delivers late, older than everything held.
  s = pushed(s, push(7, ev({ type: "assistant_text", text: "late", sessionId: "s1" })));

  const t = win(s);
  assert.equal(t.lines.length, TRANSCRIPT_CAP, "still exactly at the cap");
  const ids = t.lines.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, "no id appears twice");
  assert.deepEqual(
    ids,
    [...ids].sort((a, b) => (a ?? 0) - (b ?? 0)),
    "and durable order still holds",
  );
});

test("a failed older page keeps the window that is already loaded", () => {
  const s = atCapacity();
  const before = win(s).lines;
  const failed = { ...s, transcript: olderFailed(s.transcript, "s1", "history unavailable") };

  const t = win(failed);
  assert.equal(t.lines, before, "the rows on screen stay on screen");
  assert.deepEqual(
    t.older,
    { t: "failed", error: "history unavailable" },
    "the failure belongs to the page that failed, not to the window",
  );
  assert.equal(t.t, "tailing", "and the window is still the one being read");
});

test("a failed first page keeps whatever arrived live, and End retries it", () => {
  let s = opened();
  s = pushed(s, push(4, ev({ type: "assistant_text", text: "streamed in", sessionId: "s1" })));
  s = { ...s, transcript: headFailed(s.transcript, "s1", "no history") };

  assert.equal(s.transcript.t, "failed");
  assert.deepEqual(
    sessionLog(s).map((l) => l.text),
    ["streamed in"],
    "the live stream kept running while the fetch failed, and those rows stay",
  );

  // `End` reopens, and the retry merges what arrived meanwhile.
  s = opened(s);
  s = headPage(
    s,
    historyPage([
      { id: 3, event: ev({ type: "assistant_text", text: "older", sessionId: "s1" }) },
      { id: 4, event: ev({ type: "assistant_text", text: "streamed in", sessionId: "s1" }) },
    ]),
  );
  assert.deepEqual(
    sessionLog(s).map((l) => l.text),
    ["older", "streamed in"],
    "one entry each, merged by durable id",
  );
});

test("permission / question / fatal-error events raise a notice", () => {
  let s = initialState();
  s = pushed(s, push(1, ev({ type: "permission_request", id: "p1", tool: "Bash", input: {} })));
  assert.match(s.notice?.text ?? "", /Bash needs approval/);
  assert.equal(s.notice?.tone, "accent");

  s = pushed(s, push(2, ev({ type: "question", id: "q1", question: "which db?" })));
  assert.match(s.notice?.text ?? "", /question waiting/);

  s = pushed(s, push(3, ev({ type: "error", message: "boom", fatal: true })));
  assert.equal(s.notice?.tone, "bad");
});

test("a history page and the live stream merge by durable id, one entry each", () => {
  const a = snap({ id: "a", status: "running" });
  let s = opened(reduce(reduce(initialState(), fleet([a])), { t: "select", id: "a" }), "a");

  // Live frames arrive first — the push subscription is up before any fetch —
  // and their ids overlap the page that is still in flight.
  const live = (id: number, e: Parameters<typeof ev>[0], ts: number) =>
    (s = pushed(s, push(id, { ...ev(e), sessionId: "a", ts })));
  live(20, { type: "user_message", text: "follow up", injected: false }, 2_000);
  live(21, { type: "assistant_text", text: "on it" }, 2_100);

  // The page covers older history *and* the two entries already held. Note the
  // timestamps: the older turn ran before a daemon restart and its clock is not
  // ordered against the newer one — only the durable ids are.
  s = headPage(
    s,
    historyPage(
      [
        {
          id: 18,
          event: {
            ...ev({ type: "user_message", text: "original task", injected: false }),
            sessionId: "a",
            ts: 9_000,
          },
        },
        {
          id: 19,
          event: {
            ...ev({ type: "assistant_text", text: "first answer" }),
            sessionId: "a",
            ts: 100,
          },
        },
        {
          id: 20,
          event: {
            ...ev({ type: "user_message", text: "follow up", injected: false }),
            sessionId: "a",
            ts: 2_000,
          },
        },
        {
          id: 21,
          event: { ...ev({ type: "assistant_text", text: "on it" }), sessionId: "a", ts: 2_100 },
        },
      ],
      { olderThan: 18 },
    ),
    "a",
  );

  assert.deepEqual(
    sessionLog(s).map((l) => l.text),
    ["original task", "first answer", "follow up", "on it"],
    "the older turn sorts ahead by id, whatever its clock says",
  );
  assert.equal(
    sessionLog(s).filter((l) => l.text === "follow up").length,
    1,
    "an entry the live stream already delivered is not duplicated by the page",
  );
  const t = win(s);
  assert.equal(t.t, "tailing");
  assert.deepEqual(t.olderCursor, { olderThan: 18 }, "the page says where the next one starts");
});
test("an older page preserves the loaded entries while it is in flight, and prepends when it lands", () => {
  const a = snap({ id: "a", status: "running" });
  let s = opened(reduce(reduce(initialState(), fleet([a])), { t: "select", id: "a" }), "a");
  s = headPage(
    s,
    historyPage(
      [{ id: 9, event: { ...ev({ type: "assistant_text", text: "newest" }), sessionId: "a" } }],
      { olderThan: 9 },
    ),
    "a",
  );

  s = { ...s, transcript: olderLoading(s.transcript, "a") };
  assert.deepEqual(win(s).older, { t: "loading" });
  assert.deepEqual(
    sessionLog(s).map((l) => l.text),
    ["newest"],
    "what is already loaded stays on screen while the older page loads",
  );

  s = olderPage(
    s,
    historyPage([
      { id: 7, event: { ...ev({ type: "assistant_text", text: "older" }), sessionId: "a" } },
    ]),
    "a",
  );
  assert.deepEqual(
    sessionLog(s).map((l) => l.text),
    ["older", "newest"],
  );
  assert.deepEqual(win(s).older, { t: "idle" });
  assert.equal(win(s).olderCursor, null, "the page reached the start of the history and said so");
});

test("the active request is the one the daemon says the turn is blocked on", () => {
  const perm = (id: string): SessionInteraction => ({
    kind: "permission",
    id,
    tool: "bash",
    input: {},
    at: 1,
  });
  const plan: SessionInteraction = { kind: "plan_review", id: "pr1", plan: "the plan", at: 2 };
  const blocked = (requests: SessionInteraction[], on: AwaitReason) =>
    snap({ id: "a", status: "awaiting_input", awaitReason: on, requests });

  // A permission was raised first, but the turn is parked on the plan review.
  let s = reduce(initialState(), fleet([blocked([perm("p1"), plan], "plan_review")]));
  assert.equal(shown(s, "a")?.id, "pr1", "the awaiting reason picks the request");
  assert.deepEqual(
    reqs(s, "a").map((r) => r.id),
    ["p1", "pr1"],
    "and the rest are still outstanding, in the daemon's order",
  );

  // A reason nothing matches falls back to the first request rather than
  // showing nothing to act on.
  s = reduce(initialState(), fleet([blocked([perm("p1"), perm("p2")], "question")]));
  assert.equal(shown(s, "a")?.id, "p1");

  // Not blocked at all: no request, and no local state left claiming otherwise.
  s = reduce(s, fleet([snap({ id: "a", status: "running" })]));
  assert.equal(shown(s, "a"), null);
  assert.deepEqual(reqs(s, "a"), []);
});

test("expireNotice clears the notice only once its ttl has elapsed", () => {
  let s = reduce(initialState(), { t: "notice", text: "hi", tone: "good" });
  const at = s.notice?.at ?? 0;
  s = reduce(s, { t: "expireNotice", now: at + 1_000, ttlMs: 4_000 });
  assert.ok(s.notice, "still fresh");
  s = reduce(s, { t: "expireNotice", now: at + 5_000, ttlMs: 4_000 });
  assert.equal(s.notice, null);
});

test("the event log always shows just the selected session", () => {
  const a = snap({ id: "a", status: "running" });
  const b = snap({ id: "b", status: "running" });
  let s = reduce(initialState(), fleet([a, b]));
  s = tailing(reduce(s, { t: "select", id: "a" }), "a");
  s = pushed(s, push(1, ev({ type: "assistant_text", text: "for a", sessionId: "a" })));
  s = pushed(s, push(2, ev({ type: "assistant_text", text: "for b", sessionId: "b" })));
  assert.deepEqual(
    sessionLog(s).map((l) => l.text),
    ["for a"],
  );
  assert.deepEqual(
    visibleLog(s).map((l) => l.text),
    ["for a"],
  );
});

test("chat view collapses tool traffic and thinking; chat_and_tools keeps calls but drops results; everything keeps it all", () => {
  const a = snap({ id: "a", status: "running" });
  let s = reduce(initialState(), fleet([a]));
  s = tailing(reduce(s, { t: "select", id: "a" }), "a");
  const at = (n: number, e: Parameters<typeof ev>[0], ts: number) =>
    (s = pushed(s, push(n, { ...ev(e), sessionId: "a", ts })));
  at(1, { type: "assistant_text", text: "let me look" }, 1_000);
  at(2, { type: "thinking", text: "hmm" }, 2_000);
  at(3, { type: "thinking", text: "still hmm" }, 5_000); // 3s of thinking
  at(4, { type: "tool_call", id: "t1", name: "Bash", input: {} }, 6_000);
  at(5, { type: "tool_result", id: "t1", ok: true, output: {} }, 6_500);
  at(6, { type: "tool_call", id: "t2", name: "Grep", input: {} }, 7_000);
  at(7, { type: "tool_result", id: "t2", ok: true, output: {} }, 7_500);
  at(8, { type: "assistant_text", text: "done" }, 8_000);

  assert.equal(sessionLog(s).length, 8);

  s = reduce(s, { t: "logFilter", value: "chat" });
  const chat = visibleLog(s);
  // Neither call has an input `description`, so they collapse to one count marker.
  assert.deepEqual(
    chat.map((l) => l.text),
    ["let me look", "thought for 3s", "2 tool calls", "done"],
  );

  s = reduce(s, { t: "logFilter", value: "chat_and_tools" });
  const chatAndTools = visibleLog(s);
  assert.deepEqual(
    chatAndTools.map((l) => l.kind),
    ["assistant_text", "thinking", "tool_call", "tool_call", "assistant_text"],
  );
  assert.deepEqual(
    chatAndTools.map((l) => l.text),
    ["let me look", "thought for 3s", "Bash", "Grep", "done"],
  );

  s = reduce(s, { t: "logFilter", value: "everything" });
  assert.equal(visibleLog(s).length, 8);
});

test("chat view: tool calls with an input `description` get their own line; those without still collapse to a count", () => {
  const a = snap({ id: "a", status: "running" });
  let s = reduce(initialState(), fleet([a]));
  s = tailing(reduce(s, { t: "select", id: "a" }), "a");
  const at = (n: number, e: Parameters<typeof ev>[0], ts: number) =>
    (s = pushed(s, push(n, { ...ev(e), sessionId: "a", ts })));
  at(1, { type: "tool_call", id: "t1", name: "Read", input: { file_path: "a.ts" } }, 1_000);
  at(2, { type: "tool_result", id: "t1", ok: true, output: {} }, 1_100);
  at(
    3,
    {
      type: "tool_call",
      id: "t2",
      name: "Bash",
      input: { command: "ls", description: "List files" },
    },
    2_000,
  );
  at(4, { type: "tool_result", id: "t2", ok: true, output: {} }, 2_100);
  at(5, { type: "tool_call", id: "t3", name: "Grep", input: { pattern: "foo" } }, 3_000);
  at(6, { type: "tool_result", id: "t3", ok: true, output: {} }, 3_100);
  at(7, { type: "tool_call", id: "t4", name: "Glob", input: { pattern: "*.ts" } }, 3_200);
  at(8, { type: "tool_result", id: "t4", ok: true, output: {} }, 3_300);

  s = reduce(s, { t: "logFilter", value: "chat" });
  assert.deepEqual(
    visibleLog(s).map((l) => l.text),
    ["1 tool call", "List files", "2 tool calls"],
  );
});

test("transcriptText renders [time] role + body, skips metadata, no raw JSON", () => {
  const L = [
    toLogLine(1, {
      ...ev({ type: "user_message", text: "do the thing", injected: false }),
      ts: 5000,
    }),
    toLogLine(2, { ...ev({ type: "assistant_text", text: "on it" }), ts: 6000 }),
    toLogLine(3, {
      ...ev({ type: "tool_call", id: "t", name: "Bash", input: { command: "ls -la" } }),
      ts: 7000,
    }),
    toLogLine(4, {
      ...ev({ type: "tool_result", id: "t", ok: true, output: { text: "a\nb" } }),
      ts: 8000,
    }),
    toLogLine(5, {
      ...ev({
        type: "usage",
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        contextUsed: 1,
        contextLimit: 2,
      }),
      ts: 8500,
    }),
    toLogLine(6, { ...ev({ type: "result", kind: "ok" }), ts: 9000 }),
  ];
  const t = transcriptText(L);
  assert.match(t, /^\[\d\d:\d\d:\d\d\]  you\ndo the thing\n\n\[\d\d:\d\d:\d\d\]  agent\non it/);
  assert.match(t, /\]  tool call: Bash\ncommand: ls -la/);
  assert.match(t, /\]  tool result\na\nb/);
  assert.doesNotMatch(t, /\{|\}/, "no JSON braces");
  assert.doesNotMatch(t, /usage|turn complete/, "metadata is skipped");
});

test("condenseLog: a lone thinking / tool line still collapses; other kinds pass through", () => {
  const mk = (kind: LogLine["kind"], ts: number): LogLine => ({
    id: ts + 1,
    sessionId: "a",
    kind,
    glyph: "x",
    text: kind,
    tone: "plain",
    ts,
  });
  const out = condenseLog([mk("thinking", 0), mk("tool_call", 100), mk("error", 200)]);
  assert.deepEqual(
    out.map((l) => l.text),
    ["thought a moment", "1 tool call", "error"],
  );
});

// ---------------------------------------------------------------------------
// pending round-trips
// ---------------------------------------------------------------------------

test("resolving one of several permissions retires exactly that one, FIFO", () => {
  const perm = (id: string, command: string): SessionInteraction => ({
    kind: "permission",
    id,
    tool: "bash",
    input: { command },
    at: 1,
  });
  const blocked = (requests: SessionInteraction[]) =>
    snap({ id: "a", status: "awaiting_input", awaitReason: "permission", requests });
  let s = reduce(initialState(), fleet([blocked([perm("p1", "ls"), perm("p2", "pwd")])]));

  assert.deepEqual(shown(s, "a"), perm("p1", "ls"), "oldest first");
  assert.equal(reqs(s, "a").length, 2, "and the queue behind it is not discarded");

  // Another client answers p1. It stops being in the snapshot, exactly that one
  // disappears, the next is actionable, and the session is still blocked.
  s = reduce(s, fleet([blocked([perm("p2", "pwd")])]));
  assert.deepEqual(
    reqs(s, "a").map((r) => r.id),
    ["p2"],
  );
  assert.equal(shown(s, "a")?.id, "p2");
  assert.equal(fleetSessions(s)[0]?.status.kind, "awaiting_input");

  // And a session moving on leaves nothing to answer.
  s = reduce(s, fleet([snap({ id: "a", status: "running" })]));
  assert.equal(shown(s, "a"), null);
});

test("a resolved request closes the UI bound to it, and nothing else", () => {
  const q = (id: string): SessionInteraction => ({
    kind: "user_question",
    id,
    tool: "AskUserQuestion",
    input: { questions: [] },
    at: 1,
  });
  const blocked = (requests: SessionInteraction[]) =>
    snap({ id: "a", status: "awaiting_input", awaitReason: "user_question", requests });

  // Typing an answer to q1, with an unrelated cancelled send draft beside it.
  let s = reduce(initialState(), fleet([blocked([q("q1")]), snap({ id: "b", status: "idle" })]));
  s = { ...s, drafts: { ...s.drafts, last: "an unrelated half-typed message" } };
  s = reduce(s, open({ t: "prompt", prompt: questionsPrompt("a", "q1", "answer") }));
  s = reduce(s, {
    t: "qnavSet",
    nav: { sessionId: "a", requestId: "q1", idx: 1, answers: { "Q one": "x" } },
  });

  // Another client answers q1 and the agent asks something new.
  s = reduce(s, fleet([blocked([q("q2")]), snap({ id: "b", status: "idle" })]));

  assert.equal(promptOf(s), null, "the prompt for a request that is gone closes");
  assert.equal(s.overlay.t, "browse");
  assert.equal(s.qnav, null, "and so does the navigation through its questions");
  assert.match(s.notice?.text ?? "", /resolved elsewhere/);
  assert.equal(s.drafts.last, "an unrelated half-typed message", "an unrelated draft is untouched");

  // Nothing typed for q1 is re-aimed at q2: opening its prompt starts clean.
  assert.equal(shown(s, "a")?.id, "q2");
  assert.equal(liveQNav(s.qnav, "a", "q2"), null);
});

test("a send or title prompt is not closed because some request was resolved", () => {
  const perm: SessionInteraction = { kind: "permission", id: "p1", tool: "bash", input: {}, at: 1 };
  const blocked = (requests: SessionInteraction[]) =>
    snap({ id: "a", status: "awaiting_input", awaitReason: "permission", requests });
  let s = reduce(initialState(), fleet([blocked([perm])]));
  s = reduce(s, open({ t: "prompt", prompt: sessionPrompt("send", "a", "send", "half typed") }));

  s = reduce(s, fleet([snap({ id: "a", status: "idle" })]));
  assert.equal(
    promptOf(s) && promptKind(promptOf(s)!),
    "send",
    "a prompt with no request id has nothing to reconcile",
  );
  assert.equal(promptOf(s)?.buffer.text, "half typed");
});

test("liveQNav gates on session + request id", () => {
  const nav = { sessionId: "a", requestId: "q1", idx: 1, answers: { "Q one": "x" } };
  assert.equal(liveQNav(nav, "a", "q1"), nav);
  assert.equal(liveQNav(nav, "b", "q1"), null, "wrong session → stale");
  assert.equal(liveQNav(nav, "a", "q2"), null, "wrong request → stale");
  assert.equal(liveQNav(null, "a", "q1"), null);
});

test("a question carries its text and context, and goes when the snapshot drops it", () => {
  const q: SessionInteraction = {
    kind: "question",
    id: "q1",
    question: "which store?",
    context: "for the cache",
    at: 1,
  };
  let s = reduce(
    initialState(),
    fleet([snap({ id: "a", status: "awaiting_input", awaitReason: "question", requests: [q] })]),
  );
  assert.deepEqual(shown(s, "a"), q, "id, kind and payload travel together");

  s = reduce(s, fleet([snap({ id: "a", status: "running" })]));
  assert.equal(shown(s, "a"), null);
});
/** A plan review as the `a` / `planreview` action opens one. */
const review = (requestId: string, text: string): PlanReview => ({
  sessionId: "a",
  requestId,
  text,
  mode: "acceptEdits",
  impl: null,
});

test("a plan_review stashes the plan text; the plan overlay carries its own mode", () => {
  const a = snap({
    id: "a",
    status: "awaiting_input",
    awaitReason: "plan_review",
    requests: [{ kind: "plan_review", id: "pr1", plan: "step one\nstep two", at: 1 }],
  });
  let s = reduce(initialState(), fleet([a]));
  const active = shown(s, "a");
  assert.equal(active?.id, "pr1");
  assert.equal(active?.kind === "plan_review" ? active.plan : "", "step one\nstep two");

  s = reduce(s, open({ t: "plan", plan: review("pr1", "step one\nstep two") }));
  assert.equal(s.overlay.t, "plan");
  assert.equal(planOf(s)?.requestId, "pr1");
  assert.equal(planOf(s)?.mode, "acceptEdits");

  // ⇧⇥ cycles the implement mode — manual → acceptEdits → auto → manual.
  s = reduce(s, { t: "cyclePlanMode" });
  assert.equal(planOf(s)?.mode, "auto");
  s = reduce(s, { t: "cyclePlanMode" });
  assert.equal(planOf(s)?.mode, "default");
  s = reduce(s, { t: "cyclePlanMode" });
  assert.equal(planOf(s)?.mode, "acceptEdits");

  // the session moving on closes the overlay and clears pending
  s = reduce(s, fleet([snap({ id: "a", status: "running" })]));
  assert.equal(planOf(s), null);
  assert.equal(s.overlay.t, "browse");
  assert.equal(shown(s, "a"), null);
});

test("a detour off the plan review carries it, so backing out restores it exactly", () => {
  const a = snap({ id: "a", status: "awaiting_input", awaitReason: "plan_review" });
  let s = reduce(initialState(), fleet([a]));
  s = reduce(s, { t: "overlay", overlay: { t: "plan", plan: review("pr1", "the plan") } });
  s = reduce(s, { t: "cyclePlanMode" }); // → auto, must survive the detour
  const cycled = planOf(s)!;

  // The `⌥p` retarget wizard opens over the review, holding it as its
  // destination — there is no second slot for the review to sit in.
  s = reduce(
    s,
    open({
      t: "picker",
      picker: makePicker({
        step: "model",
        title: "retarget · model · claude",
        items: [{ id: "m1", label: "m1" }],
        dest: { t: "planImpl", plan: cycled },
        chosen: { provider: "claude", model: null },
      }),
    }),
  );
  assert.equal(s.overlay.t, "picker");
  assert.equal(heldPlan(s.overlay)?.requestId, "pr1");
  assert.equal(heldPlan(s.overlay)?.mode, "auto");

  // Esc out of the wizard's first step returns the review untouched.
  const back = escapePicker(pickerOf(s)!, s);
  assert.deepEqual(back, { t: "plan", plan: cycled });

  // A discuss prompt carries it the same way, so Esc puts it back with the
  // cycled mode and anything staged.
  const staged: PlanReview = {
    ...cycled,
    impl: { provider: "openai", model: "gpt-x", effort: "high" },
  };
  s = reduce(s, { t: "overlay", overlay: { t: "prompt", prompt: discussPrompt(staged) } });
  assert.equal(promptOf(s)?.t, "discuss");
  s = reduce(s, { t: "closePrompt", saveDraft: false });
  assert.equal(s.overlay.t, "plan");
  assert.deepEqual(planOf(s)?.impl, { provider: "openai", model: "gpt-x", effort: "high" });
  assert.equal(planOf(s)?.mode, "auto");
});

test("makePicker clamps its initial index into range", () => {
  const items = [
    { id: "a", label: "a" },
    { id: "b", label: "b" },
  ];
  const p = (index?: number) =>
    makePicker({
      step: "model",
      title: "t",
      items,
      dest: { t: "command" },
      ...(index !== undefined ? { index } : {}),
    });
  assert.equal(p(1).index, 1);
  assert.equal(p(9).index, 1);
  assert.equal(p(-1).index, 0);
  assert.equal(p().index, 0);
});

// ---------------------------------------------------------------------------
// contextual actions
// ---------------------------------------------------------------------------

test("actionsFor offers the right verbs per session state, plus the globals", () => {
  const acts = (o: Parameters<typeof snap>[0]) => allowedActs(snap(o));
  const G = ["find", "help", "new", "quit"]; // globals, always present
  // a settled selected session also gets mode + model + effort + provider + title + delete
  const S = ["mode", "model", "effort", "provider", "fork", "title", "comment", "delete", ...G];

  // awaiting_input is "request mode" — only the keys that resolve the round-trip,
  // plus interrupt and the globals. No mode / model / rename / fork.
  assert.deepEqual(
    [...acts({ status: "awaiting_input", awaitReason: "permission" })].sort(),
    ["approve", "deny", "interrupt", ...G].sort(),
  );
  assert.deepEqual(
    [...acts({ status: "awaiting_input", awaitReason: "question" })].sort(),
    ["answer", "interrupt", ...G].sort(),
  );
  assert.deepEqual(
    [...acts({ status: "awaiting_input", awaitReason: "plan_review" })].sort(),
    ["planreview", "interrupt", ...G].sort(),
  );
  // AskUserQuestion is a real permission gate — unlike Loom's own ask_user,
  // denying it is meaningful, so both answer and deny are offered.
  assert.deepEqual(
    [...acts({ status: "awaiting_input", awaitReason: "user_question" })].sort(),
    ["answer", "deny", "interrupt", ...G].sort(),
  );
  // compact rides along on any live session (running / idle / working_background),
  // whatever the context meter reads — see the footer-vs-palette split below.
  assert.deepEqual(
    [...acts({ status: "running" })].sort(),
    ["interrupt", "send", "compact", ...S].sort(),
  );
  assert.deepEqual([...acts({ status: "idle" })].sort(), ["send", "done", "compact", ...S].sort());
  // a stopped session: `send` (the daemon revives it) — no separate "resume"
  assert.deepEqual([...acts({ status: "interrupted" })].sort(), ["send", "done", ...S].sort());
  assert.deepEqual([...acts({ status: "error" })].sort(), ["send", "done", ...S].sort());
  assert.deepEqual([...allowedActs(null)].sort(), ["find", "help", "new", "quit"].sort());
});

test("an in-place session offers undo but not hard fork", () => {
  const inPlace = allowedActs(
    snap({ status: "idle", provider: "openai", inPlace: true, turns: 3 }),
  );
  assert.ok(!inPlace.has("fork"), "no worktree → no hard fork");
  assert.ok(inPlace.has("undo"), "undo is conversation-only, still available");

  const isolated = allowedActs(
    snap({ status: "idle", provider: "openai", inPlace: false, turns: 3 }),
  );
  assert.ok(isolated.has("fork"));
  assert.ok(isolated.has("undo"));
});

test("actionsFor keeps the salient action first", () => {
  const first = actionsFor(snap({ status: "awaiting_input", awaitReason: "permission" }))[0];
  assert.equal(first?.act, "approve");
});

test("footerHints gives every overlay its own fixed key set", () => {
  const base: TuiState = {
    ...initialState(),
    fleet: loadableLoaded({
      daemon,
      providers: [],
      sessions: [snap({ id: "s1", status: "idle" })],
    }),
    selectedId: "s1",
  };
  const keysFor = (overlay: Overlay) => footerHints({ ...base, overlay }).map((h) => h.label);

  // the editor draws itself
  assert.deepEqual(keysFor({ t: "prompt", prompt: sessionPrompt("send", "s1", "send") }), []);
  assert.deepEqual(
    keysFor({
      t: "picker",
      picker: makePicker({ step: "command", title: "t", items: [], dest: { t: "command" } }),
    }),
    ["move", "pick", "cancel"],
  );
  const confirmOverlay = (branchName?: string): Overlay => ({
    t: "confirm",
    confirm: {
      title: "x",
      danger: true,
      action: "deleteSession",
      sessionId: "s1",
      ...(branchName ? { branchName } : {}),
    },
  });
  assert.deepEqual(keysFor(confirmOverlay()), ["confirm", "cancel"]);
  // a delete confirm that carries a branch gets the extra toggle
  assert.deepEqual(keysFor(confirmOverlay("loom/x")), ["confirm", "+ branch", "cancel"]);
  assert.deepEqual(keysFor({ t: "plan", plan: review("pr1", "p") }), [
    "implement",
    "fresh",
    "edit",
    "discuss",
    "view",
  ]);
  assert.deepEqual(keysFor({ t: "help" }), ["close help"]);
  // browse delegates to the selected session's contextual actions
  assert.ok(keysFor({ t: "browse" }).includes("send"));
  // …trimmed to the footer subset, then the palette pointer
  assert.equal(keysFor({ t: "browse" }).at(-1), "more");
  assert.ok(!keysFor({ t: "browse" }).includes("rename"), "second-tier verbs stay off the footer");
});

test("commandsFor lists every action valid now — session verbs plus the app commands", () => {
  const base: TuiState = {
    ...initialState(),
    fleet: loadableLoaded({
      daemon,
      providers: [],
      sessions: [snap({ id: "s1", status: "idle", provider: "openai", turns: 3 })],
    }),
    selectedId: "s1",
  };
  const ids = commandsFor(base).map((c) => c.id);
  assert(commandsFor(initialState()).some((c) => c.id === "prepareEnvironment"));
  // contextual session verbs (idle aisdk session, >1 turn)
  for (const v of ["send", "done", "mode", "model", "undo", "fork", "title", "delete"]) {
    assert.ok(ids.includes(v as any), `missing ${v}`);
  }
  // app / view commands that never earn a footer slot
  for (const v of ["viewlog", "filter", "theme", "restart", "quitall", "new", "find", "help"]) {
    assert.ok(ids.includes(v as any), `missing ${v}`);
  }
  // no duplicates, and each carries its key as the hint
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(commandsFor(base).find((c) => c.id === "delete")?.hint, "X");
  assert.equal(commandsFor(base).find((c) => c.id === "fork")?.hint, "F");

  // gc only shows when a done session actually has a worktree to collect
  assert.ok(!commandsFor(base).some((c) => c.id === "gc"));
  const withDoneTree = reduce(
    base,
    fleet([
      ...fleetSessions(base),
      snap({ id: "s2", status: "done", provider: "openai", worktree: "/tmp/gc-tree" }),
    ]),
  );
  assert.ok(commandsFor(withDoneTree).some((c) => c.id === "gc"));

  // clearqueue only shows when the selected session actually has a queue
  assert.ok(!commandsFor(base).some((c) => c.id === "clearqueue"));
  const withQueue = { ...base, outbox: { s1: enqueue(outboxOf({}, "s1"), "note") } };
  assert.ok(commandsFor(withQueue).some((c) => c.id === "clearqueue"));

  // rebase needs a worktree, but is offered regardless of the (lag-prone)
  // behindBase count — the RPC is a harmless no-op when there's nothing to do
  assert.ok(!commandsFor(base).some((c) => c.id === "rebase"));
  const mkWt = (behindBase: number): TuiState =>
    reduce(
      base,
      fleet([
        snap({
          id: "s1",
          status: "idle",
          provider: "openai",
          turns: 3,
          worktree: "/tmp/wt",
          git: {
            branch: "loom/s1",
            commits: 1,
            aheadOfBase: 0,
            behindBase,
            dirty: false,
            lastCommitSubject: null,
          },
        }),
      ]),
    );
  const behind = mkWt(2);
  assert.ok(commandsFor(behind).some((c) => c.id === "rebase"));
  assert.equal(commandsFor(behind).find((c) => c.id === "rebase")?.hint, "r");
  assert.equal(commandsFor(behind).find((c) => c.id === "rebase")?.label, "rebase onto base (-2)");
  // up to date (or a stale 0) — still offered, plain label
  const current = mkWt(0);
  assert.ok(commandsFor(current).some((c) => c.id === "rebase"));
  assert.equal(commandsFor(current).find((c) => c.id === "rebase")?.label, "rebase onto base");
});

test("cacheStatus: unknown without a known TTL or a turn", () => {
  assert.equal(cacheStatus(null, 1000).state, "unknown");
  assert.equal(
    cacheStatus(
      snap({
        cache: { ttlMinutes: 0, ttlSource: "none", lastTurnAt: 5000, lastRead: 9, lastWrite: 0 },
      }),
      6000,
    ).state,
    "unknown",
  );
  assert.equal(
    cacheStatus(
      snap({
        cache: { ttlMinutes: 60, ttlSource: "observed", lastTurnAt: 0, lastRead: 0, lastWrite: 0 },
      }),
      6000,
    ).state,
    "unknown",
  );
});

test("cacheStatus: warm counts down from lastTurnAt + ttl, then goes cold", () => {
  const c = snap({
    cache: {
      ttlMinutes: 5,
      ttlSource: "observed",
      lastTurnAt: 1_000_000,
      lastRead: 8000,
      lastWrite: 300,
    },
  });
  const warm = cacheStatus(c, 1_000_000 + 2 * 60_000);
  assert.equal(warm.state, "warm");
  assert.equal(warm.remainingMs, 3 * 60_000);
  assert.equal(warm.lastHit, "hit");

  const cold = cacheStatus(c, 1_000_000 + 6 * 60_000);
  assert.equal(cold.state, "cold");
  assert.equal(cold.remainingMs, 0);
});

test("cacheStatus: a running turn is `live`, not a countdown running the wrong way", () => {
  const T0 = 1_000_000;
  const cache = {
    ttlMinutes: 5,
    ttlSource: "observed" as const,
    lastTurnAt: T0,
    lastRead: 8000,
    lastWrite: 300,
  };
  // Well past the last turn's deadline: idle, that is honestly cold.
  const late = T0 + 9 * 60_000;
  assert.equal(cacheStatus(snap({ status: "idle", cache }), late).state, "cold");

  // Running, it is not — every request of the live turn rewrites the prefix,
  // so there is no deadline to have passed. No number is offered for one.
  const live = cacheStatus(snap({ status: "running", cache }), late);
  assert.equal(live.state, "live");
  assert.equal(live.remainingMs, 0);
  assert.equal(live.lastHit, "hit"); // last turn's split still reads true
  assert.equal(live.source, "observed");

  // Parked on a question, though, nothing is being written and the clock is
  // real — which is exactly when the countdown is worth showing.
  assert.equal(
    cacheStatus(snap({ status: "awaiting_input", awaitReason: "question", cache }), late).state,
    "cold",
  );
  // A session with no TTL at all stays unknown, running or not.
  assert.equal(
    cacheStatus(
      snap({
        status: "running",
        cache: { ttlMinutes: 0, ttlSource: "none", lastTurnAt: T0, lastRead: 0, lastWrite: 0 },
      }),
      late,
    ).state,
    "unknown",
  );
});

test("cacheStatus: lastHit reads the read/write split", () => {
  const mk = (lastRead: number, lastWrite: number) =>
    cacheStatus(
      snap({
        cache: { ttlMinutes: 60, ttlSource: "observed", lastTurnAt: 1000, lastRead, lastWrite },
      }),
      2000,
    ).lastHit;
  assert.equal(mk(9000, 200), "hit"); // big read → continuation
  assert.equal(mk(0, 9000), "rewrote"); // all write → prefix was cold
  assert.equal(mk(0, 0), null);
});

test("cacheHeat bands the remaining fraction; fresh while live, null when not warm", () => {
  const T0 = 1_000_000;
  // ttl 60m; sample at minute offsets from the last turn
  const at = (min: number) =>
    cacheHeat(
      cacheStatus(
        snap({
          cache: {
            ttlMinutes: 60,
            ttlSource: "observed",
            lastTurnAt: T0,
            lastRead: 9,
            lastWrite: 1,
          },
        }),
        T0 + min * 60_000,
      ),
    );
  assert.equal(at(0), "fresh"); // 100% left
  assert.equal(at(30), "fresh"); // 50% left (> 33%)
  assert.equal(at(45), "fading"); // 25% left
  assert.equal(at(58), "expiring"); // ~3% left
  assert.equal(at(61), null); // cold
  // The same session, running: the fleet dot stays green rather than fading
  // toward a deadline the live turn keeps pushing back. Blank is reserved for
  // "no cache at all", which would be the wrong thing to say here.
  assert.equal(
    cacheHeat(
      cacheStatus(
        snap({
          status: "running",
          cache: {
            ttlMinutes: 60,
            ttlSource: "observed",
            lastTurnAt: T0,
            lastRead: 9,
            lastWrite: 1,
          },
        }),
        T0 + 61 * 60_000,
      ),
    ),
    "fresh",
  );
  assert.equal(
    cacheHeat(
      cacheStatus(
        snap({
          cache: { ttlMinutes: 0, ttlSource: "none", lastTurnAt: T0, lastRead: 0, lastWrite: 0 },
        }),
        T0,
      ),
    ),
    null, // unknown (no TTL known)
  );
});

test("compact is offered on any live session; the footer slot waits for half", () => {
  const compactHint = (s: Parameters<typeof allowedActs>[0]) =>
    actionsFor(s).find((h) => h.act === "compact");

  // Below half: still reachable by `c` / the palette, just not in the footer.
  const low = compactHint(snap({ status: "idle", contextUsed: 40, contextLimit: 100 }));
  assert.ok(low);
  assert.ok(!low.footer);
  // An unknown context limit is no reason to withhold it either.
  const unknown = compactHint(snap({ status: "idle", contextUsed: 0, contextLimit: 0 }));
  assert.ok(unknown);
  assert.ok(!unknown.footer);

  // Past half it earns the footer.
  assert.equal(
    compactHint(snap({ status: "idle", contextUsed: 60, contextLimit: 100 }))?.footer,
    true,
  );
  assert.equal(
    compactHint(snap({ status: "running", contextUsed: 90, contextLimit: 100 }))?.footer,
    true,
  );

  // not offered for a session with no live adapter
  assert.ok(
    !allowedActs(snap({ status: "interrupted", contextUsed: 90, contextLimit: 100 })).has(
      "compact",
    ),
  );
});

test("groupsOf only emits non-empty groups, in fleet-view order", () => {
  const g = groupsOf([
    snap({ status: "idle" }),
    snap({ status: "awaiting_input" }),
    snap({ status: "idle" }),
  ]);
  assert.deepEqual(
    g.map((x) => x.status),
    ["awaiting_input", "idle"],
  );
  assert.deepEqual(
    g.map((x) => x.sessions.length),
    [1, 2],
  );
});

// ---------------------------------------------------------------------------
// event formatting
// ---------------------------------------------------------------------------

test("formatEvent renders each event kind to a glyph + one-liner + tone", () => {
  const tc = formatEvent(
    ev({ type: "tool_call", id: "1", name: "Bash", input: { command: "npm test" } }),
  );
  assert.equal(tc.glyph, "⚙");
  assert.equal(tc.text, "Bash  npm test");
  assert.equal(tc.tone, "warn");
  assert.equal(tc.full, "Bash\ncommand: npm test"); // editor view gets readable key: value, not JSON
  const okr = formatEvent(ev({ type: "tool_result", id: "1", ok: true, output: {} }));
  assert.equal(okr.tone, "good");
  assert.equal(okr.text, "ok");
  assert.equal(okr.full, undefined); // empty object → nothing to expand
  const badr = formatEvent(
    ev({ type: "tool_result", id: "1", ok: false, output: { text: "nope" } }),
  );
  assert.equal(badr.tone, "bad");
  assert.equal(badr.full, "error\nnope");
  assert.match(
    formatEvent(ev({ type: "question", id: "q1", question: "which one?" })).text,
    /req q1/,
  );
  assert.match(
    formatEvent(
      ev({
        type: "usage",
        tokens: { input: 1200, output: 30, cacheRead: 0, cacheWrite: 0 },
        contextUsed: 1200,
        contextLimit: 200000,
      }),
    ).text,
    /ctx 1\.2k\/200\.0k/,
  );
  assert.match(
    formatEvent(ev({ type: "plan_review", id: "pr9", plan: "x" })).text,
    /plan ready.*req pr9/,
  );
  const comp = formatEvent(
    ev({ type: "compact", trigger: "manual", before: 120000, after: 24000 }),
  );
  assert.equal(comp.glyph, "⇊");
  assert.match(comp.text, /120\.0k → 24\.0k/);
  // `after` unknown until the next turn — no arrow
  assert.doesNotMatch(
    formatEvent(ev({ type: "compact", trigger: "auto", before: 120000, after: 0 })).text,
    /→/,
  );
  const pc = formatEvent(
    ev({
      type: "provider_changed",
      from: "claude",
      provider: "openai",
      model: "gpt-5",
      effort: "high",
      lossy: false,
    }),
  );
  assert.equal(pc.glyph, "⇄");
  assert.match(pc.text, /claude → openai\/gpt-5 · high/);
  const lossy = formatEvent(
    ev({
      type: "provider_changed",
      from: "openai",
      provider: "claude",
      model: null,
      effort: null,
      lossy: true,
    }),
  );
  assert.match(lossy.text, /context summarized/);
});

test("formatEvent keeps the full body for long / multi-line events", () => {
  const long = "word ".repeat(120).trim(); // ~600 chars
  const at = formatEvent(ev({ type: "assistant_text", text: long }));
  assert.ok(at.text.length < long.length && at.text.endsWith("…"), "pane text is truncated");
  assert.equal(at.full, long, "full body is untouched");

  // newlines survive into `full` but not the pane one-liner
  const multi = formatEvent(ev({ type: "error", message: "line one\nline two\nline three" }));
  assert.equal(multi.full, "line one\nline two\nline three");
  assert.doesNotMatch(multi.text, /\n/);

  // a short event doesn't carry a redundant `full` on the stored LogLine
  assert.equal(toLogLine(1, ev({ type: "assistant_text", text: "hi" })).full, undefined);
  assert.equal(toLogLine(2, ev({ type: "assistant_text", text: long })).full, long);
});

test("Read tool calls show path + range; their tool_result drops the raw file dump", () => {
  const tc = formatEvent(
    ev({
      type: "tool_call",
      id: "1",
      name: "Read",
      input: { file_path: "src/a.ts", offset: 10, limit: 50 },
    }),
  );
  assert.equal(tc.text, "Read  src/a.ts [10+50]");

  // tilth's structural reader collapses the same way, matched by name suffix
  const tilth = formatEvent(
    ev({ type: "tool_call", id: "2", name: "mcp__tilth__tilth_read", input: { path: "b.ts" } }),
  );
  assert.equal(tilth.text, "mcp__tilth__tilth_read  b.ts");

  const tr = mkTranscript({
    fetch: () => new Promise(() => {}),
    connected: () => true,
    shown: transcriptLines,
    paneWidth: () => 80,
    pageRows: () => 20,
  });
  tr.select("a", "everything");
  tr.receive(
    push(
      1,
      ev({
        type: "tool_call",
        id: "r1",
        name: "Read",
        input: { file_path: "a.ts" },
        sessionId: "a",
      }),
    ),
  );
  tr.receive(
    push(
      2,
      ev({
        type: "tool_result",
        id: "r1",
        ok: true,
        output: { text: "line one\nline two" },
        sessionId: "a",
      }),
    ),
  );
  const result = transcriptLines(tr.get().transcript).at(-1);
  assert.equal(result?.text, "ok");
  assert.equal(result?.full, undefined, "the file content isn't duplicated into the log");

  // an error result from a Read is still shown in full — it's short and useful
  tr.receive(
    push(
      3,
      ev({
        type: "tool_call",
        id: "r2",
        name: "Read",
        input: { file_path: "missing.ts" },
        sessionId: "a",
      }),
    ),
  );
  tr.receive(
    push(
      4,
      ev({ type: "tool_result", id: "r2", ok: false, output: { text: "ENOENT" }, sessionId: "a" }),
    ),
  );
  const failed = transcriptLines(tr.get().transcript).at(-1);
  assert.equal(failed?.full, "error\nENOENT");
  tr.dispose();
});

test("an Edit-shaped tool call renders old_string/new_string as a removed/added block", () => {
  const tc = formatEvent(
    ev({
      type: "tool_call",
      id: "1",
      name: "Edit",
      input: { file_path: "a.ts", old_string: "const x = 1;", new_string: "const x = 2;" },
    }),
  );
  assert.equal(tc.full, "Edit  a.ts\n- const x = 1;\n+ const x = 2;");

  // tilth_edit renders the same way, matched by name suffix
  const tilthEdit = formatEvent(
    ev({
      type: "tool_call",
      id: "2",
      name: "mcp__tilth__tilth_edit",
      input: { path: "b.ts", old_string: "foo", new_string: "bar" },
    }),
  );
  assert.equal(tilthEdit.full, "mcp__tilth__tilth_edit  b.ts\n- foo\n+ bar");

  // a multi-line replacement diffs line by line, not as one blob
  const multi = formatEvent(
    ev({
      type: "tool_call",
      id: "3",
      name: "Edit",
      input: { file_path: "a.ts", old_string: "one\ntwo", new_string: "one\nTWO" },
    }),
  );
  assert.equal(multi.full, "Edit  a.ts\n- one\n- two\n+ one\n+ TWO");
});

test("tilth_write's batch `files` renders one block per file, and the one-liner names them", () => {
  const tc = formatEvent(
    ev({
      type: "tool_call",
      id: "1",
      name: "mcp__tilth__tilth_write",
      input: {
        files: [
          { path: "a.ts", mode: "overwrite", content: "const a = 1;" },
          { path: "b.ts", mode: "hash", edits: [{ start: "2:891", content: "const b = 2;" }] },
        ],
      },
    }),
  );
  assert.equal(tc.text, "mcp__tilth__tilth_write  2 files: a.ts, b.ts");
  assert.equal(
    tc.full,
    [
      "mcp__tilth__tilth_write",
      "a.ts  (overwrite)\n+ const a = 1;",
      "b.ts  (hash)\n@ 2:891\n+ const b = 2;",
    ].join("\n\n"),
  );
});

test("prompt open / edit / close transitions", () => {
  let s = reduce(initialState(), open({ t: "prompt", prompt: sessionPrompt("send", "a", "send") }));
  assert.equal(s.overlay.t, "prompt");
  s = reduce(s, { t: "promptSet", buffer: buffer("hello") });
  assert.equal(promptOf(s)?.buffer.text, "hello");
  s = reduce(s, { t: "closePrompt" });
  assert.equal(s.overlay.t, "browse");
  assert.equal(promptOf(s), null);
});

test("Esc on a new/send prompt stashes the draft; either prompt can restore it; submitting clears it", () => {
  // cancelling a `new` prompt saves the draft
  let s = reduce(initialState(), open({ t: "prompt", prompt: newPrompt(settings) }));
  s = reduce(s, { t: "promptSet", buffer: buffer("fix the bug") });
  s = reduce(s, { t: "closePrompt", saveDraft: true });
  assert.equal(s.drafts.last, "fix the bug");

  // ...and a `send` prompt opened afterwards picks it up
  s = reduce(s, open({ t: "prompt", prompt: sessionPrompt("send", "a", "send", s.drafts.last) }));
  assert.equal(promptOf(s)?.buffer.text, "fix the bug");

  // cancelling without saveDraft (e.g. a plain closePrompt) leaves it untouched
  let untouched = reduce(s, { t: "closePrompt" });
  assert.equal(untouched.drafts.last, "");

  // cancelling a `title` prompt never touches the shared draft
  let withDraft = reduce(initialState(), { t: "closePrompt", saveDraft: true }); // no prompt open: no-op
  assert.equal(withDraft.drafts.last, "");
  withDraft = { ...withDraft, drafts: { ...withDraft.drafts, last: "fix the bug" } };
  withDraft = reduce(
    withDraft,
    open({ t: "prompt", prompt: sessionPrompt("title", "a", "rename", "old title") }),
  );
  withDraft = reduce(withDraft, { t: "promptSet", buffer: buffer("new title") });
  withDraft = reduce(withDraft, { t: "closePrompt", saveDraft: true });
  assert.equal(
    withDraft.drafts.last,
    "fix the bug",
    "renaming doesn't clobber the send/new draft slot",
  );

  // submitting (closePrompt without saveDraft) consumes the draft
  let sent = reduce(
    initialState(),
    open({ t: "prompt", prompt: sessionPrompt("send", "a", "send", "fix the bug") }),
  );
  sent = { ...sent, drafts: { ...sent.drafts, last: "fix the bug" } };
  sent = reduce(sent, { t: "closePrompt" });
  assert.equal(sent.drafts.last, "", "a sent message shouldn't linger as a restorable draft");
});

test("promptCycleMode only cycles for a `new` prompt", () => {
  let s = reduce(initialState(), open({ t: "prompt", prompt: newPrompt(settings) }));
  const mode = (x: TuiState) => {
    const p = promptOf(x);
    return p?.t === "new" ? p.settings.mode : null;
  };
  assert.equal(mode(s), "default", "a fresh new-prompt starts on the daemon's default mode");
  s = reduce(s, { t: "promptCycleMode" });
  assert.equal(mode(s), "plan");
  s = reduce(s, { t: "promptCycleMode" });
  assert.equal(mode(s), "acceptEdits");

  let t = reduce(initialState(), open({ t: "prompt", prompt: sessionPrompt("send", "a", "send") }));
  t = reduce(t, { t: "promptCycleMode" });
  assert.equal(promptOf(t)?.t, "session", "a send prompt has no mode to cycle");
});

test("pushHistory dedupes, keeps newest-last, and caps at 50; promptHistoryNav walks it", () => {
  let s = initialState();
  for (const x of ["one", "two", "one", "three"]) s = reduce(s, { t: "pushHistory", text: x });
  assert.deepEqual(s.drafts.history, ["two", "one", "three"]);

  s = reduce(s, open({ t: "prompt", prompt: sessionPrompt("send", "a", "send", "live") }));
  s = reduce(s, { t: "promptHistoryNav", dir: -1 });
  assert.equal(promptOf(s)?.buffer.text, "three");
  s = reduce(s, { t: "promptHistoryNav", dir: -1 });
  assert.equal(promptOf(s)?.buffer.text, "one");
  s = reduce(s, { t: "promptHistoryNav", dir: 1 });
  s = reduce(s, { t: "promptHistoryNav", dir: 1 });
  assert.equal(promptOf(s)?.buffer.text, "live", "returns to the stashed live draft at index 0");
});

test("editing a recalled history entry detaches it from the walk", () => {
  let s = initialState();
  s = reduce(s, { t: "pushHistory", text: "hi" });
  s = reduce(s, open({ t: "prompt", prompt: sessionPrompt("send", "a", "send") }));
  s = reduce(s, { t: "promptHistoryNav", dir: -1 });
  assert.equal(promptOf(s)?.buffer.text, "hi");
  assert.equal(promptOf(s)?.histIdx, 1);

  // A cursor-only move (same text) does not detach.
  s = reduce(s, { t: "promptSet", buffer: buffer("hi", 0) });
  assert.equal(promptOf(s)?.histIdx, 1);

  // Editing the recalled entry makes it the live buffer: ↓ is a no-op, ↑
  // restarts the walk from the newest entry.
  s = reduce(s, { t: "promptSet", buffer: buffer("hello") });
  assert.equal(promptOf(s)?.histIdx, 0);
  s = reduce(s, { t: "promptHistoryNav", dir: 1 });
  assert.equal(promptOf(s)?.buffer.text, "hello", "↓ at the live buffer keeps the edit");
  s = reduce(s, { t: "promptHistoryNav", dir: -1 });
  assert.equal(promptOf(s)?.buffer.text, "hi", "↑ restarts the walk from the newest entry");
  s = reduce(s, { t: "promptHistoryNav", dir: 1 });
  assert.equal(promptOf(s)?.buffer.text, "hello", "↓ returns to the detached edit");
});

test("↓ at the live buffer never clobbers it with the stashed draft", () => {
  let s = initialState();
  s = reduce(s, { t: "pushHistory", text: "old" });
  s = reduce(s, open({ t: "prompt", prompt: sessionPrompt("send", "a", "send") }));
  s = reduce(s, { t: "promptSet", buffer: buffer("typed") });
  s = reduce(s, { t: "promptHistoryNav", dir: 1 });
  assert.equal(promptOf(s)?.buffer.text, "typed", "↓ is a no-op at the live buffer");
});

test("queued follow-ups render after the durable transcript, derived from the outbox", () => {
  const a = snap({ id: "a", status: "running" });
  let s = opened(reduce(reduce(initialState(), fleet([a])), { t: "select", id: "a" }), "a");
  s = headPage(s, historyPage([]), "a");
  s = pushed(
    s,
    push(5, { ...ev({ type: "assistant_text", text: "from the daemon" }), sessionId: "a" }),
  );
  let outbox = { a: enqueue(enqueue(outboxOf({}, "a"), "hi"), "there") };

  assert.deepEqual(
    win(s).lines.map((l) => l.text),
    ["from the daemon"],
    "a marker never enters the durable list, so it cannot be deduplicated or paged",
  );
  assert.deepEqual(
    sessionLog({ ...s, outbox }).map((l) => l.text),
    ["from the daemon", "queued: hi", "queued: there"],
    "a queued send belongs at the bottom — it is about to happen, not part of the record",
  );

  // The message goes on the wire: its marker disappears in the same breath,
  // because the daemon's own `user_message` is what takes its place.
  outbox = { a: { t: "sending", operation: Symbol(), text: "hi", rest: ["there"], barrier: 0 } };
  assert.deepEqual(
    sessionLog({ ...s, outbox }).map((l) => l.text),
    ["from the daemon", "queued: there"],
  );
});

test("a request's guard is its own: an uncertain answer blocks only that request", async () => {
  const settle: Array<(e: unknown) => void> = [];
  const sent: string[] = [];
  let sessions: SessionSnapshot[] = [
    snap({
      id: "a",
      status: "awaiting_input",
      requests: [
        { kind: "permission", id: "p1", tool: "Bash", input: {}, at: 1 },
        { kind: "permission", id: "p2", tool: "Bash", input: {}, at: 2 },
      ],
    }),
  ];
  const it = mkInteractions({
    request: <T>(_m: string, params: Record<string, unknown>) => {
      sent.push(String(params["requestId"]));
      return new Promise<T>((_res, rej) => settle.push(rej));
    },
    by: "me",
    fleet: () => sessions,
  });

  // p1's reply never comes back — it may well have been applied.
  const first = it.respond("a", "p1", { t: "allow" });
  settle[0]?.(Object.assign(new Error("dropped"), { code: "disconnected" }));
  await assert.rejects(first);
  void it.respond("a", "p1", { t: "allow" });
  assert.deepEqual(sent, ["p1"], "p1 is not answered a second time");

  // A different request is a different guard, and answering it changes nothing
  // about p1's — the old single latch released p1 here.
  void it.respond("a", "p2", { t: "deny", message: "" });
  void it.respond("a", "p1", { t: "allow" });
  assert.deepEqual(sent, ["p1", "p2"], "p2 goes, p1 stays held");

  // The daemon stops listing p1: it is settled, whichever way it went, and
  // there is nothing left for its guard to protect.
  sessions = [snap({ id: "a", status: "idle", requests: [] })];
  it.settle();
  void it.respond("a", "p1", { t: "allow" });
  assert.deepEqual(sent, ["p1", "p2", "p1"]);
});

test("a permission carries its tool + input; leaving awaiting_input clears it", () => {
  let s = reduce(
    initialState(),
    fleet([
      snap({
        id: "a",
        status: "awaiting_input",
        requests: [
          { kind: "permission", id: "p1", tool: "Bash", input: { command: "rm -rf x" }, at: 1 },
        ],
      }),
    ]),
  );
  const r = shown(s, "a");
  assert.equal(r?.kind, "permission");
  assert.equal(r?.id, "p1");
  s = reduce(s, fleet([snap({ id: "a", status: "running" })]));
  assert.equal(shown(s, "a"), null);
});

test("confirm open / run / close", () => {
  let s = reduce(
    initialState(),
    open({
      t: "confirm",
      confirm: { title: "Restart the daemon?", danger: false, action: "restart" },
    }),
  );
  assert.equal(s.overlay.t, "confirm");
  assert.equal(confirmOf(s)?.action, "restart");
  s = reduce(s, open({ t: "browse" }));
  assert.equal(s.overlay.t, "browse");
  assert.equal(confirmOf(s), null);
});

test("toggleConfirmBranch flips deleteBranch only when a branch is on offer", () => {
  let s = reduce(
    initialState(),
    open({
      t: "confirm",
      confirm: {
        title: "Delete?",
        danger: true,
        action: "deleteSession",
        sessionId: "s1",
        branchName: "loom/x",
        deleteBranch: false,
      },
    }),
  );
  s = reduce(s, { t: "toggleConfirmBranch" });
  assert.equal(confirmOf(s)?.deleteBranch, true);
  s = reduce(s, { t: "toggleConfirmBranch" });
  assert.equal(confirmOf(s)?.deleteBranch, false);

  // no branchName (in-place / gc'd session) → the toggle is inert
  let t = reduce(
    initialState(),
    open({
      t: "confirm",
      confirm: { title: "Delete?", danger: true, action: "deleteSession", sessionId: "s2" },
    }),
  );
  t = reduce(t, { t: "toggleConfirmBranch" });
  assert.equal(confirmOf(t)?.deleteBranch, undefined);
});

test("help toggles the mode without disturbing the rest of the state", () => {
  const a = snap({ id: "a", status: "running" });
  let s = reduce(initialState(), fleet([a]));
  s = reduce(s, { t: "overlay", overlay: { t: "help" } });
  assert.equal(s.overlay.t, "help");
  assert.equal(s.selectedId, "a");
  s = reduce(s, { t: "overlay", overlay: { t: "browse" } });
  assert.equal(s.overlay.t, "browse");
});

test("doctor: open sets the mode, doctorLoaded caches the report, close returns to browse", () => {
  const a = snap({ id: "a", status: "running" });
  let s = reduce(initialState(), fleet([a]));
  assert.equal(s.doctor, null);

  s = reduce(s, { t: "overlay", overlay: { t: "doctor" } });
  assert.equal(s.overlay.t, "doctor");
  assert.equal(s.selectedId, "a");

  const report = {
    daemon: {
      pid: 1,
      version: "0.0.1",
      startedAt: 0,
      uptimeMs: 5,
      epoch: "e",
      repoRoot: "/r",
      clients: 1,
      connections: 1,
      eventSeq: 3,
      sessions: 1,
      runningSessions: 1,
    },
    connectors: [{ pkg: "@loom/connector-claude", providerIds: ["claude"], loaded: false }],
    mcp: [
      {
        name: "tilth",
        command: "tilth --mcp --edit",
        resolved: "tilth --mcp --edit",
        status: "ok" as const,
        note: "",
      },
    ],
    tools: {
      loom: ["ask_user", "commit"],
      claude: [],
      aisdk: [],
      claudeDisabled: ["Grep", "Glob"],
    },
    webSearch: { backend: "none" as const, enabled: false, note: "no backend configured" },
    configWarnings: [],
  };
  s = reduce(s, { t: "doctorLoaded", report });
  assert.equal(s.doctor?.mcp[0]?.name, "tilth");
  assert.equal(s.overlay.t, "doctor");

  s = reduce(s, { t: "overlay", overlay: { t: "browse" } });
  assert.equal(s.overlay.t, "browse");
  // the cached report survives a close so a reopen paints immediately
  assert.equal(s.doctor?.daemon.pid, 1);
});

test("commandsFor lists doctor in the Space palette", () => {
  const s = reduce(initialState(), fleet([]));
  assert.ok(commandsFor(s).some((it) => it.id === "doctor"));
});

test("the header lamp is derived from the snapshot's loadable state", () => {
  // No second source of truth: idle before the first connect, pending while
  // reconnecting, live once a snapshot lands, closed on a terminal failure.
  assert.equal(connectionOf(initialState()), "connecting");

  let s = reduce(initialState(), { t: "state", state: loadablePending });
  assert.equal(connectionOf(s), "reconnecting");

  s = reduce(s, fleet([snap({ id: "a" })]));
  assert.equal(connectionOf(s), "live");
  assert.equal(fleetSessions(s).length, 1);

  s = reduce(s, { t: "state", state: loadablePending });
  assert.equal(connectionOf(s), "reconnecting");
  assert.deepEqual(fleetSessions(s), [], "a pending client has no fleet to show");

  s = reduce(s, {
    t: "state",
    state: loadableFailed({ kind: "connect_failed", message: "gone" }),
  });
  assert.equal(connectionOf(s), "closed");
});

test("toggleTheme cycles dark → light → argonext, defaulting to dark", () => {
  let s = initialState();
  assert.equal(s.theme, "dark");
  s = reduce(s, { t: "toggleTheme" });
  assert.equal(s.theme, "light");
  s = reduce(s, { t: "toggleTheme" });
  assert.equal(s.theme, "argonext");
  s = reduce(s, { t: "toggleTheme" });
  assert.equal(s.theme, "dark");
});

// ---------------------------------------------------------------------------
// theme helpers
// ---------------------------------------------------------------------------

test("theme formatting helpers", () => {
  assert.equal(humanTokens(999), "999");
  assert.equal(humanTokens(12_345), "12.3k");
  assert.equal(humanTokens(2_000_000), "2.0M");
  assert.equal(bar(0.5, 10), "▰▰▰▰▰▱▱▱▱▱");
  assert.equal(bar(-1, 4), "▱▱▱▱");
  assert.equal(bar(2, 4), "▰▰▰▰");
  assert.equal(truncate("abcdefgh", 5), "abcd…");
  assert.equal(truncate("abc", 5), "abc");
  assert.equal(money(0), "—");
  assert.equal(money(0.4), "$0.40");
  assert.equal(spinnerFrame(0), spinnerFrame(10));
  assert.deepEqual(wrapText("the quick brown fox", 9), ["the quick", "brown fox"]);
  assert.deepEqual(wrapText("supercalifragilistic", 6), ["superc", "alifra", "gilist", "ic"]);
  assert.deepEqual(wrapText("short", 40), ["short"]);
});

test("setThemeMode swaps the shared palette in place — statusLook/toneColor follow immediately", () => {
  setThemeMode("dark");
  const darkGood = statusLook("idle").color;
  const darkBad = toneColor("bad");
  setThemeMode("light");
  assert.notEqual(statusLook("idle").color, darkGood);
  assert.notEqual(toneColor("bad"), darkBad);
  // glyph/label are theme-independent
  assert.equal(statusLook("idle").glyph, "○");
  assert.equal(statusLook("idle").label, "idle");
  setThemeMode("dark"); // restore for any test relying on the default palette
});

test("the theme persists to a file and loads back; junk falls back to null", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-tui-theme-"));
  const file = join(dir, "tui.json");
  try {
    assert.equal(loadPersistedTheme(file), null); // absent
    persistTheme(file, "argonext");
    assert.equal(loadPersistedTheme(file), "argonext");
    writeFileSync(file, "{not json"); // corrupt JSON
    assert.equal(loadPersistedTheme(file), null);
    writeFileSync(file, JSON.stringify({ theme: "hotdog" })); // unknown mode
    assert.equal(loadPersistedTheme(file), null);
    // parents are created — the CLI normally makes `.loom/` first anyway
    const nested = join(dir, "sub", "tui.json");
    persistTheme(nested, "light");
    assert.equal(loadPersistedTheme(nested), "light");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("initialState reports the active theme, so a restored one sticks", () => {
  setThemeMode("argonext");
  assert.equal(themeMode(), "argonext");
  assert.equal(initialState().theme, themeMode());
  setThemeMode("dark"); // restore for any test relying on the default palette
});

test("status_changed events stay out of the log; result is a terse marker", () => {
  let s = tailing();
  s = pushed(s, push(1, ev({ type: "assistant_text", text: "here is the answer" })));
  s = pushed(s, push(2, ev({ type: "status_changed", status: stateIdle, note: "result" })));
  s = pushed(s, push(3, ev({ type: "result", kind: "ok", summary: "here is the answer" })));
  assert.deepEqual(
    lines(s).map((l) => l.glyph),
    ["▪", "■"],
    "no ◈ status line; result kept but terse",
  );
  assert.equal(lines(s).at(-1)?.text, "turn complete");
});

test("selectedSession returns the highlighted row or null", () => {
  assert.equal(selectedSession(initialState()), null);
  const s = reduce(initialState(), fleet([snap({ id: "z", status: "running" })]));
  assert.equal(selectedSession(s)?.id, "z");
});

// ---------------------------------------------------------------------------
// picker: provider / model / find
// ---------------------------------------------------------------------------

const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude",
    models: ["claude-opus-5", "claude-sonnet-5"],
    modelChoices: [
      {
        id: "claude-opus-5",
        label: "Claude Opus 4.8",
        context: 1_000_000,
        supportsEffort: true,
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "high",
      },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    ],
    defaultModel: "claude-sonnet-5",
    defaultEffort: "",
    defaultMode: "default",
    tag: "claude",
    color: "",
    isDefault: true,
  },
  {
    id: "openai",
    models: ["gpt-5", "gpt-5-mini", "o4"],
    defaultModel: "gpt-5",
    defaultEffort: "",
    defaultMode: "default",
    tag: "oai",
    color: "cyan",
    isDefault: false,
  },
  {
    id: "deepseek",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
    defaultEffort: "",
    defaultMode: "default",
    tag: "ds",
    color: "magenta",
    isDefault: false,
  },
];

const withProviders = (): TuiState => reduce(initialState(), fleet([], PROVIDERS));

test("a snapshot's providers populate state and the derived helpers", () => {
  const s = withProviders();
  assert.equal(defaultProviderId(s), "claude");
  assert.equal(providerColorOf(s, "openai"), "cyan");
  assert.equal(providerColorOf(s, "claude"), "");
  assert.deepEqual(
    modelPickItems(s, "deepseek").map((i) => i.id),
    ["deepseek-chat", "deepseek-reasoner"],
  );
  assert.equal(providerPickItems(s).length, 3);
  // claude's picker uses the CLI catalog's friendly names + context tags
  assert.deepEqual(modelPickItems(s, "claude"), [
    { id: "claude-opus-5", label: "Claude Opus 4.8", hint: "1.0M ctx" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  ]);
  // aisdk with no modelChoices falls back to bare ids
  assert.deepEqual(
    modelPickItems(s, "deepseek").map((i) => i.label),
    ["deepseek-chat", "deepseek-reasoner"],
  );
  assert.match(modelPickEmptyText(s, "claude"), /configured model/); // still there if the list is empty
  assert.match(modelPickEmptyText(s, "oai"), /no models detected.*loom models oai/s);
});

test("modelSupportsEffort / effortPickItems: gated per model, per its own enumerated levels", () => {
  const s = withProviders();
  assert.equal(modelSupportsEffort(s, "claude", "claude-opus-5"), true);
  // sibling model with no `supportsEffort` on its ModelChoice
  assert.equal(modelSupportsEffort(s, "claude", "claude-sonnet-5"), false);
  // a provider with no modelChoices at all never offers it
  assert.equal(modelSupportsEffort(s, "deepseek", "deepseek-chat"), false);
  assert.deepEqual(
    effortPickItems(s, "claude", "claude-opus-5").map((i) => i.id),
    ["low", "medium", "high", "xhigh", "max"],
  );
  // the endpoint's advertised default effort is marked in the picker
  assert.deepEqual(
    effortPickItems(s, "claude", "claude-opus-5").map((i) => i.hint ?? ""),
    ["", "", "default", "", ""],
  );
  // a choice without an advertised default marks nothing (falls back to the
  // full EffortLevel set)
  assert.deepEqual(effortPickItems(s, "claude", "claude-sonnet-5"), [
    { id: "low", label: "low" },
    { id: "medium", label: "medium" },
    { id: "high", label: "high" },
    { id: "xhigh", label: "xhigh" },
    { id: "max", label: "max" },
  ]);
});

test("versionMismatchAction: bounce only when alone, otherwise prompt then nag", () => {
  const base = {
    daemonVersion: "1.2.0",
    uiVersion: "1.3.0",
    otherClients: 0,
    liveSessions: 0,
    alreadyHandled: false,
  };
  assert.equal(versionMismatchAction({ ...base, daemonVersion: "1.3.0" }), "ok");
  assert.equal(versionMismatchAction({ ...base, daemonVersion: null }), "ok");
  assert.equal(versionMismatchAction(base), "auto-restart");
  assert.equal(versionMismatchAction({ ...base, otherClients: 1 }), "prompt");
  assert.equal(versionMismatchAction({ ...base, liveSessions: 2 }), "prompt");
  // once we've prompted / tried, don't keep interrupting — just remind
  assert.equal(versionMismatchAction({ ...base, otherClients: 1, alreadyHandled: true }), "nag");
  assert.equal(versionMismatchAction({ ...base, alreadyHandled: true }), "nag");
});

test("picker: open, filter narrows the list, move clamps to the filtered set", () => {
  let s = reduce(
    withProviders(),
    open({
      t: "picker",
      picker: makePicker({
        step: "model",
        title: "model",
        items: modelPickItems(withProviders(), "openai"),
        dest: { t: "newSession", settings, draft: "" },
      }),
    }),
  );
  assert.equal(s.overlay.t, "picker");
  assert.equal(pickerVisible(pickerOf(s)!).length, 3);

  s = reduce(s, { t: "pickerMove", delta: 5 });
  assert.equal(pickerOf(s)!.index, 2); // clamped to last

  s = reduce(s, { t: "pickerFilter", buffer: buffer("mini") });
  assert.equal(pickerVisible(pickerOf(s)!).length, 1);
  assert.equal(pickerOf(s)!.index, 0); // reset on filter
  assert.equal(pickerCurrent(pickerOf(s)!)?.id, "gpt-5-mini");

  s = reduce(s, { t: "overlay", overlay: { t: "browse" } });
  assert.equal(s.overlay.t, "browse");
  assert.equal(pickerOf(s), null);
});

test("a live model picker closes if its session is removed", () => {
  let s = reduce(
    withProviders(),
    fleet([snap({ id: "live", status: "running", provider: "openai" })]),
  );
  s = reduce(
    s,
    open({
      t: "picker",
      picker: makePicker({
        step: "model",
        title: "model",
        items: modelPickItems(s, "openai"),
        dest: { t: "session", sessionId: "live", back: null },
        chosen: { provider: "openai", model: null },
      }),
    }),
  );
  // A snapshot the session has dropped out of closes the picker aimed at it.
  s = reduce(s, fleet([]));
  assert.equal(pickerOf(s), null);
  assert.equal(s.overlay.t, "browse");
});

/** A wizard step, as `pickerStep` builds one. `from` is where the wizard opened. */
const step = (o: {
  step: "provider" | "model" | "effort";
  dest: PickerDest;
  from: "provider" | "model" | "effort";
  provider?: string;
  model?: string;
}): Picker =>
  makePicker({
    step: o.step,
    title: o.step,
    items: [],
    dest: o.dest,
    from: o.from,
    chosen: { provider: o.provider ?? null, model: o.model ?? null },
  });

test("escapePicker: an effort step opened after a model step steps back to it; a bare ⌥t doesn't", () => {
  const s = withProviders(); // claude/claude-opus-5 has supportsEffort: true
  const live: PickerDest = { t: "session", sessionId: "s1", back: null };

  // Reached by picking a model that takes one (⌥p wizard, or ⌥m onto such a
  // model) — Esc steps back to the model list, live switch or not.
  const backToModel = escapePicker(
    step({ step: "effort", dest: live, from: "model", provider: "claude", model: "claude-opus-5" }),
    s,
  );
  assert.equal(backToModel.t, "picker");
  assert.equal(backToModel.t === "picker" && backToModel.picker.step, "model");

  // A bare ⌥t on a live session skipped the model step entirely — Esc must not
  // invent one to go back to; with nothing else to return to, it closes.
  assert.deepEqual(
    escapePicker(
      step({
        step: "effort",
        dest: live,
        from: "effort",
        provider: "claude",
        model: "claude-opus-5",
      }),
      s,
    ),
    { t: "browse" },
  );

  // A bare ⌥t from inside a `send` prompt — no model step, but reopens that
  // prompt with the draft, same as a bare ⌥m would.
  const reopened = escapePicker(
    step({
      step: "effort",
      dest: { t: "session", sessionId: "s1", back: "half-typed" },
      from: "effort",
      provider: "claude",
      model: "claude-opus-5",
    }),
    s,
  );
  assert.equal(reopened.t, "prompt");
  assert.equal(reopened.t === "prompt" && promptKind(reopened.prompt), "send");
  assert.equal(reopened.t === "prompt" && reopened.prompt.buffer.text, "half-typed");

  // A bare ⌥t from the `new` prompt — restores it with its settings and draft.
  const restored = escapePicker(
    step({
      step: "effort",
      dest: {
        t: "newSession",
        settings: { ...settings, provider: "claude" },
        draft: "hi",
      },
      from: "effort",
      provider: "claude",
      model: "claude-opus-5",
    }),
    s,
  );
  assert.equal(restored.t, "prompt");
  assert.equal(restored.t === "prompt" && promptKind(restored.prompt), "new");
  assert.equal(
    restored.t === "prompt" && restored.prompt.t === "new" && restored.prompt.settings.provider,
    "claude",
  );
  assert.equal(restored.t === "prompt" && restored.prompt.buffer.text, "hi");
});

test("escapePicker: a wizard steps back only as far as the step it opened at", () => {
  const s = withProviders();

  // Provider step of a live switch opened from a send prompt — Esc restores
  // that prompt with the draft (there is no `new` prompt to fall into).
  const back1 = escapePicker(
    step({
      step: "provider",
      dest: { t: "session", sessionId: "s1", back: "wip" },
      from: "provider",
    }),
    s,
  );
  assert.equal(back1.t, "prompt");
  assert.equal(back1.t === "prompt" && promptKind(back1.prompt), "send");
  assert.equal(back1.t === "prompt" && back1.prompt.buffer.text, "wip");

  // Provider step of a live switch from the fleet view (nothing behind it) —
  // Esc just closes.
  assert.deepEqual(
    escapePicker(
      step({
        step: "provider",
        dest: { t: "session", sessionId: "s1", back: null },
        from: "provider",
      }),
      s,
    ),
    { t: "browse" },
  );

  // Model step reached from that live provider step — Esc steps back to the
  // provider list rather than closing.
  const back3 = escapePicker(
    step({
      step: "model",
      dest: { t: "session", sessionId: "s1", back: null },
      from: "provider",
      provider: "openai",
    }),
    s,
  );
  assert.equal(back3.t, "picker");
  assert.equal(back3.t === "picker" && back3.picker.step, "provider");

  // Regression: the non-live ⌥p new-session wizard still falls back to a `new`
  // prompt, not a live send.
  const back4 = escapePicker(
    step({
      step: "provider",
      dest: { t: "newSession", settings, draft: "idea" },
      from: "provider",
    }),
    s,
  );
  assert.equal(back4.t, "prompt");
  assert.equal(back4.t === "prompt" && promptKind(back4.prompt), "new");
  assert.equal(back4.t === "prompt" && back4.prompt.buffer.text, "idea");
});

test("newSettings folds the ⌃P chooser's provider + model into the new prompt", () => {
  const p = newPrompt(newSettings(withProviders(), "openai", "o4", null));
  assert.equal(p.t === "new" && p.settings.provider, "openai");
  assert.equal(p.t === "new" && p.settings.model, "o4");
});

test("defaultModelOf reads the provider's advertised default model", () => {
  const s = withProviders();
  assert.equal(defaultModelOf(s, "openai"), "gpt-5");
  assert.equal(defaultModelOf(s, "claude"), "claude-sonnet-5");
  assert.equal(defaultModelOf(s, "nope"), "");
});

test("defaultModeOf reads the daemon's remembered mode, not per-provider", () => {
  assert.equal(defaultModeOf(initialState()), "default");
  const s = reduce(
    initialState(),
    fleet(
      [],
      PROVIDERS.map((p) => ({ ...p, defaultMode: "acceptEdits" as const })),
    ),
  );
  assert.equal(defaultModeOf(s), "acceptEdits");
});

// ---------------------------------------------------------------------------
// layout budgets — the frame must never exceed the terminal (see deriveView)
// ---------------------------------------------------------------------------

test("detail layout counts the Detail pane's physical rows, conditional lines included", () => {
  assert.equal(detailLayout(null).height, 4); // borders + "DETAIL" + the select hint
  assert.equal(detailLayout(snap({ id: "a", status: "idle" })).height, 10);

  // A claude chat mid-flight: profile line, fork lineage, compaction, warm
  // cache, plan windows, commit subject, queued message, sub-agents, bg tasks.
  const full = snap({
    id: "c",
    status: "running",
    parentId: "p",
    forkTurn: 3,
    git: {
      branch: "loom/x",
      commits: 2,
      aheadOfBase: 1,
      behindBase: 0,
      dirty: true,
      lastCommitSubject: "add flag",
    },
    rateLimits: { five_hour: { status: "allowed", utilization: 0.4 } },
    cache: {
      ttlMinutes: 5,
      ttlSource: "observed",
      lastTurnAt: Date.now(),
      lastRead: 2,
      lastWrite: 1,
    },
    subagents: [{ id: "sa", name: "scout", active: true }],
    backgroundTasks: [{ id: "bt", kind: "shell", title: "tail log" }],
  });
  const rows = detailLayout(full, {
    account: "claude pro (acme)",
    compacting: { startedAt: Date.now(), before: 90_000 },
    queued: ["follow up"],
  }).height;
  assert.equal(rows, 19);
  // The layout used to hardcode 13 here — a session like this overflowed the
  // body by 6 rows and pushed the top bar off the alt screen.
  assert.ok(rows > 13, "a full claude Detail exceeds the old hardcoded budget");
});

test("promptRows budgets the footer notice row in browse, never in a prompt", () => {
  assert.equal(promptRows(initialState(), 100), 2);
  const noted = reduce(initialState(), { t: "notice", text: "sent", tone: "good" });
  assert.equal(promptRows(noted, 100), 3);
  // A prompt's footer never renders the notice — its budget stays 1 + editor + 1.
  const prompted = reduce(noted, open({ t: "prompt", prompt: newPrompt(settings) }));
  assert.equal(promptRows(prompted, 100), 3);
});

test("promptRows counts word-wrapped editor rows at the terminal's width", () => {
  const withText = (text: string) =>
    reduce(initialState(), open({ t: "prompt", prompt: newPrompt(settings, text) }));
  // "one two three" fills one row at 80 cols; at 12 cols (room 8) it wraps in two.
  const wide = withText("one two three");
  assert.equal(promptRows(wide, 80), 3);
  assert.equal(promptRows(wide, 12), 4);
  // The budget never exceeds MAX_EDITOR_ROWS, however long the text wraps.
  const flood = withText("word ".repeat(40));
  assert.equal(promptRows(flood, 12), 10);
});

test("a reply prompt's input budgets on the EVENTS pane, not the footer", () => {
  const withText = (text: string) =>
    reduce(initialState(), open({ t: "prompt", prompt: sessionPrompt("send", "a", "send", text) }));
  // The footer carries only the hints row…
  assert.equal(promptRows(withText(""), 100), 1);
  // …and the pane carries label + wrapped editor, capped at MAX_EDITOR_ROWS.
  assert.equal(promptPaneRows(withText("one two three"), 100), 2);
  assert.equal(promptPaneRows(withText("word ".repeat(40)), 12), 9);
});

// keep a reference to TuiState so the import is load-bearing for type checks
const _typecheck: TuiState = initialState();
void _typecheck;

// --- snapshot-backed compacting (survives a reopen / second client) ---------

test("the compacting indicator is whatever the snapshot says, for every client alike", () => {
  // A session already mid-compaction at attach time shows "compacting…" without
  // the client ever having seen a heartbeat: the beats are not persisted, so
  // this is the only thing a second window or a reopened TUI can read it from.
  const mid = snap({
    id: "a",
    status: "idle",
    compacting: { startedAt: 9_000, before: 120_000, generated: 0 },
  });
  let s = reduce(initialState(), fleet([mid]));
  assert.deepEqual(compactingFor(s, "a"), {
    startedAt: 9_000,
    generated: 0,
    before: 120_000,
  });

  // Progress rides the snapshot too, so every client shows the same number.
  s = reduce(
    s,
    fleet([
      snap({
        id: "a",
        status: "idle",
        compacting: { startedAt: 9_000, before: 120_000, generated: 400 },
        updatedAt: 50,
      }),
    ]),
  );
  assert.equal(compactingFor(s, "a")?.generated, 400);

  // The gate released — a snapshot without the flag ends it. There is no local
  // entry that could survive the release and pin "compacting…" forever.
  s = reduce(s, fleet([snap({ id: "a", status: "idle", updatedAt: 99 })]));
  assert.equal(compactingFor(s, "a"), null);
});

test("every session's compaction rides the same snapshot", () => {
  const s = reduce(
    initialState(),
    fleet([
      snap({
        id: "s1",
        status: "idle",
        compacting: { startedAt: 6_000, before: 90_000, generated: 128 },
      }),
      snap({
        id: "s2",
        status: "idle",
        compacting: { startedAt: 42_000, before: 77_000, generated: 0 },
      }),
      snap({ id: "s3", status: "idle" }),
    ]),
  );
  assert.equal(compactingFor(s, "s1")?.generated, 128);
  assert.equal(compactingFor(s, "s2")?.startedAt, 42_000);
  assert.equal(compactingFor(s, "s3"), null);
});

test("a model picker opened while the catalog loads resolves when the fresh list lands", () => {
  const loading: ProviderInfo[] = [
    {
      id: "claude",
      models: [],
      defaultModel: "claude-sonnet-5",
      defaultEffort: "",
      defaultMode: "default",
      tag: "claude",
      color: "",
      isDefault: true,
      modelsLoading: true,
    },
    ...PROVIDERS.slice(1),
  ];
  const s = reduce(initialState(), fleet([], loading));
  assert.match(modelPickEmptyText(s, "claude"), /loading/i);
  assert.deepEqual(modelPickItems(s, "claude"), []);

  // Open the model step mid-load (as the ⌥p wizard does)…
  const opened = reduce(
    s,
    open({
      t: "picker",
      picker: makePicker({
        step: "model",
        title: "model · claude",
        items: modelPickItems(s, "claude"),
        emptyText: modelPickEmptyText(s, "claude"),
        dest: { t: "newSession", settings, draft: "" },
        chosen: { provider: "claude", model: null },
      }),
    }),
  );
  assert.equal(pickerOf(opened)?.items.length, 0);

  const diagnostic = "Claude could not start. Install Claude or set providers.claude.cli_path.";
  const failed = reduce(
    opened,
    fleet(
      [],
      loading.map((p) => ({
        ...p,
        modelsLoading: false,
        modelsError: diagnostic,
      })),
    ),
  );
  assert.equal(modelPickEmptyText(failed, "claude"), diagnostic);
  assert.equal(pickerOf(failed)?.emptyText, diagnostic);

  // …then the daemon's settle push lands — the same picker fills in.
  const settled = reduce(opened, fleet([], PROVIDERS));
  assert.deepEqual(
    pickerOf(settled)?.items.map((i) => i.id),
    ["claude-opus-5", "claude-sonnet-5"],
  );
  assert.equal(pickerOf(settled)?.emptyText, null);
});

test("logRowCount tracks the resolved child through drill and drain", () => {
  const seed = (sessions: SessionSnapshot[]): TuiState => {
    let t = tailing(reduce(initialState(), fleet(sessions)), "fan");
    t = pushed(t, push(1, ev({ sessionId: "fan", type: "assistant_text", text: "mainline" })));
    t = pushed(
      t,
      push(
        2,
        ev({
          sessionId: "fan",
          type: "assistant_text",
          text: `from reviewer ${"wrap ".repeat(40)}`,
          agentId: "t1",
        }),
      ),
    );
    return t;
  };

  // Drill into the reviewer sub-agent: the pane narrows to its stream.
  let s = seed([fanout]);
  const full = logRowCount(shownLog(s), 60);
  s = reduce(s, { t: "childEnter" });
  s = reduce(s, { t: "childMove", delta: 2 }); // → sub:t1
  const narrowed = logRowCount(shownLog(s), 60);
  assert.ok(narrowed > 0 && narrowed !== full, "the narrowed pane measures its own stream");

  // Every child drains at once: the snapshot leaves nothing to focus, so
  // `focusedChildOf` resolves to null and the pane un-narrows. The measurement
  // has to follow the *resolved* child, not the raw selection.
  s = reduce(s, fleet([{ ...fanout, backgroundTasks: [], subagents: [] }]));
  assert.equal(focusedChildOf(s), null);
  assert.equal(logRowCount(shownLog(s), 60), full, "un-narrowed pane measures the full log again");

  // A partial drain instead lands the focus on a surviving sibling rather than
  // leaving it dangling — snapshots reconcile the selection, they don't strand it.
  let partial = seed([fanout]);
  partial = reduce(partial, { t: "childEnter" });
  partial = reduce(partial, { t: "childMove", delta: 2 }); // → sub:t1
  partial = reduce(
    partial,
    fleet([{ ...fanout, subagents: [{ id: "t1", name: "reviewer", active: false }] }]),
  );
  assert.equal(focusedChildOf(partial)?.key, "bg:task1");
});

// ---------------------------------------------------------------------------
// the animation clock
// ---------------------------------------------------------------------------

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("the clock beats only while the frame needs it, and settling does not reset its phase", async () => {
  let need: Beat = null;
  let beats = 0;
  const clock = mkClock({ needs: () => need, beat: () => void (beats += 1) });

  clock.settle();
  await wait(SPIN_MS * 3);
  assert.equal(beats, 0, "a still frame costs no timer at all");

  need = "spin";
  clock.settle();
  // Every publish settles the clock. Re-arming an interval resets its phase, so
  // a steady stream of publishes would starve the spinner of every beat — the
  // one thing this has to get right beyond starting and stopping.
  for (let i = 0; i < 20; i++) {
    clock.settle();
    await wait(SPIN_MS / 4);
  }
  assert.ok(beats >= 3, `the spinner advanced through the publishes (${beats} beats)`);

  need = null;
  clock.settle();
  const settled = beats;
  await wait(SPIN_MS * 3);
  assert.equal(beats, settled, "and it stops the moment nothing on screen animates");
  clock.dispose();
});

test("a deadline fires once, moves when re-armed, and cancels on null", async () => {
  let fired = 0;
  const d = mkDeadline(() => void (fired += 1));

  d.at(10);
  d.at(60); // re-arming replaces the pending firing rather than adding one
  await wait(30);
  assert.equal(fired, 0, "the deadline moved out; the first one did not survive it");
  await wait(60);
  assert.equal(fired, 1);

  d.at(10);
  d.at(null);
  await wait(30);
  assert.equal(fired, 1, "null cancels");
  d.dispose();
});

test("session recall restores persisted messages independently of global history", () => {
  let s = reduce(initialState(), { t: "pushHistory", text: "other chat" });
  s = reduce(
    s,
    open({ t: "prompt", prompt: { ...sessionPrompt("send", "a", "send"), history: [] } }),
  );
  s = reduce(s, { t: "restoreHistory", sessionId: "a", texts: ["opening", "failed\nfollow-up"] });
  assert.equal(s.drafts.last, "");
  s = reduce(s, { t: "promptHistoryNav", dir: -1 });
  assert.equal(promptOf(s)?.buffer.text, "failed\nfollow-up");
  s = reduce(s, { t: "restoreHistory", sessionId: "b", texts: ["wrong chat"] });
  s = reduce(s, { t: "promptHistoryNav", dir: -1 });
  assert.equal(promptOf(s)?.buffer.text, "opening");
  s = reduce(s, { t: "promptHistoryNav", dir: -1 });
  assert.equal(promptOf(s)?.buffer.text, "opening");
});
