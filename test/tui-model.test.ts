import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AwaitReason, HarnessEvent } from "@loom/core/events";
import {
  type SessionState,
  type SessionStateKind,
  stateAwaitingInput,
  stateIdle,
} from "@loom/core/session-state";
import type { DaemonInfo, ProviderInfo, SessionSnapshot } from "@loom/core/wire";
import { loadableFailed, loadableLoaded, loadablePending } from "@loom/core/loadable";
import type { EventPush } from "@loom/core/wire";
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
  escapeTarget,
  fleetHits,
  focusedChildOf,
  focusedPending,
  footerHints,
  formatEvent,
  groupsOf,
  initialState,
  liveQNav,
  makePicker,
  makePrompt,
  modelPickEmptyText,
  modelPickItems,
  modelSupportsEffort,
  pendingFor,
  pickerCurrent,
  pickerVisible,
  providerColorOf,
  providerPickItems,
  versionMismatchAction,
  queueFor,
  condenseLog,
  firstPerm,
  LOG_CAP,
  reduce,
  selectedSession,
  sessionLog,
  sortSessions,
  toLogLine,
  transcriptText,
  visibleLog,
  type LogLine,
  type Action,
  type TuiState,
  connectionOf,
  fleetDaemon,
  fleetSessions,
} from "@loom/tui/model";
import {
  detailRows,
  logRowCount,
  modeChipHit,
  promptPaneRows,
  promptRows,
} from "@loom/tui/components";
import { buffer } from "@loom/tui/editor";
import { searchSessions, type FleetView } from "@loom/tui/fleet-search";
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

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let clock = 1_000;

/** Build a `SessionState` from a bare kind (+ an await reason), for fixtures. */
const toState = (
  kind: SessionStateKind = "idle",
  awaitReason: AwaitReason | null = null,
): SessionState => {
  switch (kind) {
    case "awaiting_input":
      return stateAwaitingInput(awaitReason ?? "permission");
    case "interrupted":
      return { kind: "interrupted", by: "user" };
    case "error":
      return { kind: "error", message: "" };
    default:
      return { kind } as SessionState;
  }
};

const snap = (
  over: Partial<Omit<SessionSnapshot, "status">> & {
    status?: SessionStateKind;
    awaitReason?: AwaitReason | null;
  } = {},
): SessionSnapshot => {
  const now = ++clock;
  const { status: statusKind, awaitReason, ...rest } = over;
  return {
    id: over.id ?? `s${now}`,
    parentId: null,
    forkTurn: null,
    provider: "fake",
    model: null,
    effort: null,
    mode: "default",
    status: toState(statusKind, awaitReason),
    title: "a task",
    comment: null,
    worktree: null,
    branch: null,
    baseBranch: null,
    inPlace: false,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextUsed: 0,
    contextLimit: 0,
    costUsd: 0,
    costSource: "none",
    turns: 0,
    requests: [],
    subagents: [],
    backgroundTasks: [],
    rateLimits: {},
    cache: { ttlMinutes: 0, ttlSource: "none", lastTurnAt: 0, lastRead: 0, lastWrite: 0 },
    keepWarm: false,
    canRewind: true,
    resumable: true,
    git: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
};

const ev = (over: Partial<HarnessEvent> & { type: HarnessEvent["type"] }): HarnessEvent => {
  return { sessionId: "s1", ts: 5_000, ...(over as object) } as HarnessEvent;
};

const push = (seq: number, event: HarnessEvent, epoch = "e1"): EventPush => {
  return { kind: "push", seq, epoch, type: "event", event };
};

const daemon: DaemonInfo = {
  pid: 1,
  version: "0.0.1",
  repoRoot: "/tmp/demo",
  startedAt: 0,
  epoch: "e1",
};

/**
 * A complete-replacement snapshot action — the only way fleet state reaches the
 * reducer. Tests that used to push a single `session_updated` now hand over the
 * whole fleet as it stands after the change, which is exactly what the daemon
 * does.
 */
const fleet = (sessions: SessionSnapshot[], providers: ProviderInfo[] = []): Action => ({
  t: "state",
  state: loadableLoaded({ daemon, providers, sessions }),
});

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
  s = reduce(s, { t: "childEnter" });
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
  s = reduce(s, { t: "childMove", delta: 2 }); // → sub:t1
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
  s = reduce(s, { t: "openFind" });
  const after = fleetHits(s, geom).find((h) => h.kind === "session")!.y;
  assert.equal(after - before, 2, "the marginTop + the InputLine push the list down");
});

test("modeChipHit points at the Detail status row's chip cell", () => {
  const plain = snap({ id: "p", status: "idle", mode: "default" });
  const hit = modeChipHit(plain, { originX: 1, originY: 2, paneW: 80 });
  assert.ok(hit);
  // border + DETAIL header + title + the status row's marginTop.
  assert.equal(hit!.y, 6);
  assert.ok(hit!.x0 > 1 && hit!.x1 >= hit!.x0);

  // account + fork lines each push the status row down one.
  const forked = snap({ id: "f", status: "idle", parentId: "p", forkTurn: 3 });
  const fh = modeChipHit(forked, { originX: 1, originY: 2, paneW: 80, account: "x (y)" });
  assert.equal(fh!.y, 8);

  assert.equal(modeChipHit(null, { originX: 1, originY: 2, paneW: 80 }), null);
  // a pane too narrow to fit the chip drops the region.
  assert.equal(modeChipHit(plain, { originX: 1, originY: 2, paneW: 8 }), null);
});

test("visibleLog: the main view hides child-tagged frames; a focused child narrows to them", () => {
  let s = reduce(initialState(), fleet([fanout]));
  s = reduce(s, {
    t: "push",
    frame: push(1, ev({ sessionId: "fan", type: "assistant_text", text: "mainline" })),
  });
  s = reduce(s, {
    t: "push",
    frame: push(
      2,
      ev({ sessionId: "fan", type: "assistant_text", text: "from reviewer", agentId: "t1" }),
    ),
  });
  s = reduce(s, {
    t: "push",
    frame: push(
      3,
      ev({ sessionId: "fan", type: "assistant_text", text: "from task", agentId: "task1" }),
    ),
  });
  assert.deepEqual(
    visibleLog(s).map((l) => l.text),
    ["mainline"],
  );
  s = reduce(s, { t: "childEnter" });
  const child = focusedChildOf(s);
  assert.equal(child?.key, "bg:task1");
  assert.deepEqual(
    visibleLog(s, child).map((l) => l.text),
    ["from task"],
  );
  s = reduce(s, { t: "childMove", delta: 2 }); // → sub:t1
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
  s = reduce(s, { t: "select", id: "a" });
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

test("event pushes append log lines and never truncate", () => {
  let s = initialState();
  for (let i = 0; i < 5; i++) {
    s = reduce(s, {
      t: "push",
      frame: push(i, ev({ type: "assistant_text", text: `line ${i}`, sessionId: "s1" })),
    });
  }
  assert.equal(s.log.length, 5);
  assert.deepEqual(
    s.log.map((l) => l.seq),
    [0, 1, 2, 3, 4],
  );
});

test("state.log is capped — a marathon session drops the oldest lines, keeps the newest", () => {
  // Built directly: driving 100k lines through `reduce` would be O(n²) (each
  // push copies the log). One extra push over the cap still exercises the trim.
  const backlog: LogLine[] = [];
  for (let i = 0; i < LOG_CAP + 50; i++) {
    backlog.push(
      toLogLine(i, "e1", ev({ type: "assistant_text", text: `line ${i}`, sessionId: "s1" })),
    );
  }
  let s: TuiState = { ...initialState(), log: backlog };
  s = reduce(s, {
    t: "push",
    frame: push(LOG_CAP + 50, ev({ type: "assistant_text", text: "the newest", sessionId: "s1" })),
  });
  assert.equal(s.log.length, LOG_CAP);
  assert.equal(s.log[0]?.seq, 51, "oldest lines were trimmed (50 backlog + the push)");
  assert.equal(s.log.at(-1)?.seq, LOG_CAP + 50, "newest line retained");
});

test("a seq that collides across daemon epochs is a new line, not a dropped dupe", () => {
  // The daemon restarts mid-session and its seq counter resets to 1. Every
  // post-restart frame reuses seqs the log already holds from the previous
  // epoch — keying dedupe on seq alone silently swallowed the whole new epoch
  // (the user's messages vanished while the agent kept responding to them).
  let s = initialState();
  s = reduce(s, {
    t: "push",
    frame: push(464, ev({ type: "tool_call", id: "t1", name: "bash", input: {}, sessionId: "s1" })),
  });
  s = reduce(s, {
    t: "push",
    frame: push(
      464,
      ev({
        type: "user_message",
        text: "So how did we get on with the context status?",
        sessionId: "s1",
      }),
      "e2", // a different daemon epoch — same seq, different event
    ),
  });
  assert.equal(s.log.length, 2, "post-restart frame must not collide with a pre-restart seq");
  assert.equal(s.log[1]?.kind, "user_message");

  // Within one epoch a repeated seq is still the startup overlap dupe → dropped.
  s = reduce(s, {
    t: "push",
    frame: push(
      464,
      ev({
        type: "user_message",
        text: "So how did we get on with the context status?",
        sessionId: "s1",
      }),
      "e2",
    ),
  });
  assert.equal(s.log.length, 2);
});

test("compact_progress drives the compacting indicator without hitting the log", () => {
  let s = initialState();
  s = reduce(s, {
    t: "push",
    frame: push(
      1,
      ev({
        type: "compact_progress",
        sessionId: "s1",
        ts: 10_000,
        elapsedMs: 4_000,
        generated: 128,
        before: 90_000,
      }),
    ),
  });
  assert.equal(s.log.length, 0, "heartbeat is not a transcript line");
  assert.deepEqual(s.compacting["s1"], { startedAt: 6_000, generated: 128, before: 90_000 });

  // a later beat refreshes it
  s = reduce(s, {
    t: "push",
    frame: push(
      2,
      ev({
        type: "compact_progress",
        sessionId: "s1",
        ts: 12_000,
        elapsedMs: 6_000,
        generated: 400,
        before: 90_000,
      }),
    ),
  });
  assert.equal(s.compacting["s1"]?.generated, 400);

  // the boundary clears it and *is* logged
  s = reduce(s, {
    t: "push",
    frame: push(
      3,
      ev({ type: "compact", sessionId: "s1", trigger: "manual", before: 90_000, after: 12_000 }),
    ),
  });
  assert.equal(s.compacting["s1"], undefined);
  assert.equal(s.log.length, 1);
  assert.match(s.log[0]?.text ?? "", /context compacted/);
});

test("an error (fatal or not) abandons the compacting indicator", () => {
  for (const fatal of [true, false]) {
    let s = initialState();
    s = reduce(s, {
      t: "push",
      frame: push(
        1,
        ev({
          type: "compact_progress",
          sessionId: "s1",
          ts: 10_000,
          elapsedMs: 0,
          generated: 0,
          before: 50_000,
        }),
      ),
    });
    assert.ok(s.compacting["s1"]);
    s = reduce(s, {
      t: "push",
      frame: push(2, ev({ type: "error", message: "boom", fatal, sessionId: "s1" })),
    });
    assert.equal(s.compacting["s1"], undefined, `fatal=${fatal}`);
  }
});

test("resync drops all compacting indicators", () => {
  let s = initialState();
  s = reduce(s, {
    t: "push",
    frame: push(
      1,
      ev({
        type: "compact_progress",
        sessionId: "s1",
        ts: 10_000,
        elapsedMs: 0,
        generated: 0,
        before: 50_000,
      }),
    ),
  });
  assert.ok(s.compacting["s1"]);
  s = reduce(s, { t: "push", frame: { kind: "push", seq: 2, type: "resync", reason: "rolled" } });
  assert.deepEqual(s.compacting, {});
});

test("permission / question / fatal-error events raise a notice", () => {
  let s = initialState();
  s = reduce(s, {
    t: "push",
    frame: push(1, ev({ type: "permission_request", id: "p1", tool: "Bash", input: {} })),
  });
  assert.match(s.notice?.text ?? "", /Bash needs approval/);
  assert.equal(s.notice?.tone, "accent");

  s = reduce(s, {
    t: "push",
    frame: push(2, ev({ type: "question", id: "q1", question: "which db?" })),
  });
  assert.match(s.notice?.text ?? "", /question waiting/);

  s = reduce(s, { t: "push", frame: push(3, ev({ type: "error", message: "boom", fatal: true })) });
  assert.equal(s.notice?.tone, "bad");
});

test("a replayed (backfilled) event never raises a notice — it's transcript, not live (U2)", () => {
  let s = initialState();
  s = reduce(s, {
    t: "push",
    replay: true,
    frame: push(1, ev({ type: "permission_request", id: "p1", tool: "Bash", input: {} })),
  });
  s = reduce(s, {
    t: "push",
    replay: true,
    frame: push(2, ev({ type: "error", message: "old boom", fatal: true })),
  });
  assert.equal(s.notice, null, "no notice flashed from replayed history");
  // …but the frame still lands in the log.
  assert.ok(
    s.log.some((l) => l.seq === 1) && s.log.some((l) => l.seq === 2),
    "replayed frames are still logged",
  );
});

test("backfill stitches durable history in by (epoch, seq) and re-sorts by ts (cross-restart order)", () => {
  const a = snap({ id: "a", status: "running" });
  let s = reduce(initialState(), fleet([a]));
  s = reduce(s, { t: "select", id: "a" });

  // The `hello` ring replay only carries the current epoch ("e2") — the turn
  // taken after a daemon restart. These land as ordinary appends.
  const seed = (seq: number, e: Parameters<typeof ev>[0], ts: number) =>
    (s = reduce(s, {
      t: "push",
      replay: true,
      frame: push(seq, { ...ev(e), sessionId: "a", ts }, "e2"),
    }));
  seed(2, { type: "user_message", text: "follow up", injected: false }, 2_000);
  seed(3, { type: "assistant_text", text: "on it" }, 2_100);

  // `session.events` returns the whole history: the pre-restart turn ("e1")
  // ahead of what the ring already held ("e2").
  s = reduce(s, {
    t: "backfill",
    frames: [
      push(
        18,
        {
          ...ev({ type: "user_message", text: "original task", injected: false }),
          sessionId: "a",
          ts: 1_000,
        },
        "e1",
      ),
      push(
        19,
        { ...ev({ type: "assistant_text", text: "first answer" }), sessionId: "a", ts: 1_100 },
        "e1",
      ),
      push(
        2,
        {
          ...ev({ type: "user_message", text: "follow up", injected: false }),
          sessionId: "a",
          ts: 2_000,
        },
        "e2",
      ),
      push(
        3,
        { ...ev({ type: "assistant_text", text: "on it" }), sessionId: "a", ts: 2_100 },
        "e2",
      ),
    ],
  });

  assert.deepEqual(
    sessionLog(s).map((l) => l.text),
    ["original task", "first answer", "follow up", "on it"],
    "the pre-restart turn is ordered ahead of the newer frames, not appended below them",
  );
  assert.equal(
    sessionLog(s).filter((l) => l.text === "follow up").length,
    1,
    "frames already logged by (epoch, seq) aren't duplicated",
  );

  // A second backfill with nothing new is a no-op (same state ref → no re-render).
  assert.equal(reduce(s, { t: "backfill", frames: [] }), s);
});

test("a sessions/hello snapshot drops pending for a session it says is no longer blocked (U2)", () => {
  const blocked = snap({ id: "a", status: "awaiting_input", awaitReason: "permission" });
  let s = reduce(initialState(), fleet([blocked]));
  s = reduce(s, {
    t: "push",
    replay: true,
    frame: push(
      1,
      ev({ type: "permission_request", id: "p1", tool: "bash", input: {}, sessionId: "a" }),
    ),
  });
  assert.ok(s.pending["a"]?.permissions?.length, "replayed request tracked while still blocked");

  // The daemon's snapshot now shows the session idle — the pending is stale.
  s = reduce(s, fleet([snap({ id: "a", status: "idle" })]));
  assert.equal(s.pending["a"], undefined, "settled pending pruned by the snapshot");
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
  s = reduce(s, { t: "select", id: "a" });
  s = reduce(s, {
    t: "push",
    frame: push(1, ev({ type: "assistant_text", text: "for a", sessionId: "a" })),
  });
  s = reduce(s, {
    t: "push",
    frame: push(2, ev({ type: "assistant_text", text: "for b", sessionId: "b" })),
  });
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
  s = reduce(s, { t: "select", id: "a" });
  const at = (n: number, e: Parameters<typeof ev>[0], ts: number) =>
    (s = reduce(s, { t: "push", frame: push(n, { ...ev(e), sessionId: "a", ts }) }));
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
  s = reduce(s, { t: "select", id: "a" });
  const at = (n: number, e: Parameters<typeof ev>[0], ts: number) =>
    (s = reduce(s, { t: "push", frame: push(n, { ...ev(e), sessionId: "a", ts }) }));
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
    toLogLine(1, "e1", {
      ...ev({ type: "user_message", text: "do the thing", injected: false }),
      ts: 5000,
    }),
    toLogLine(2, "e1", { ...ev({ type: "assistant_text", text: "on it" }), ts: 6000 }),
    toLogLine(3, "e1", {
      ...ev({ type: "tool_call", id: "t", name: "Bash", input: { command: "ls -la" } }),
      ts: 7000,
    }),
    toLogLine(4, "e1", {
      ...ev({ type: "tool_result", id: "t", ok: true, output: { text: "a\nb" } }),
      ts: 8000,
    }),
    toLogLine(5, "e1", {
      ...ev({
        type: "usage",
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        contextUsed: 1,
        contextLimit: 2,
      }),
      ts: 8500,
    }),
    toLogLine(6, "e1", { ...ev({ type: "result", kind: "ok" }), ts: 9000 }),
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
    seq: ts,
    epoch: "e1",
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

test("parallel permission requests queue; each resolvePerm advances; session_updated clears", () => {
  const a = snap({ id: "a", status: "awaiting_input", awaitReason: "permission" });
  let s = reduce(initialState(), fleet([a]));
  s = reduce(s, {
    t: "push",
    frame: push(
      1,
      ev({
        type: "permission_request",
        id: "p1",
        tool: "bash",
        input: { command: "ls" },
        sessionId: "a",
      }),
    ),
  });
  s = reduce(s, {
    t: "push",
    frame: push(
      2,
      ev({
        type: "permission_request",
        id: "p2",
        tool: "bash",
        input: { command: "pwd" },
        sessionId: "a",
      }),
    ),
  });
  assert.deepEqual(firstPerm(pendingFor(s, "a")), {
    id: "p1",
    tool: "bash",
    input: { command: "ls" },
  });
  assert.equal(pendingFor(s, "a").permissions?.length, 2);

  // a replayed request isn't double-counted
  s = reduce(s, {
    t: "push",
    frame: push(
      3,
      ev({ type: "permission_request", id: "p1", tool: "bash", input: {}, sessionId: "a" }),
    ),
  });
  assert.equal(pendingFor(s, "a").permissions?.length, 2);

  s = reduce(s, { t: "resolvePerm", sessionId: "a", id: "p1" });
  assert.equal(firstPerm(pendingFor(s, "a"))?.id, "p2");

  s = reduce(s, { t: "resolvePerm", sessionId: "a", id: "p2" });
  assert.equal(firstPerm(pendingFor(s, "a")), undefined);
  assert.equal(pendingFor(s, "a").permissions, undefined);

  // and a session moving on wipes any leftover
  s = reduce(s, {
    t: "push",
    frame: push(
      4,
      ev({ type: "permission_request", id: "p3", tool: "bash", input: {}, sessionId: "a" }),
    ),
  });
  s = reduce(s, fleet([snap({ id: "a", status: "running" })]));
  assert.equal(firstPerm(pendingFor(s, "a")), undefined);
});

test("qnav: liveQNav gates on session + request id, and resolvePerm clears a match", () => {
  const nav = { sessionId: "a", requestId: "q1", idx: 1, answers: { "Q one": "x" } };
  assert.equal(liveQNav(nav, "a", "q1"), nav);
  assert.equal(liveQNav(nav, "b", "q1"), null, "wrong session → stale");
  assert.equal(liveQNav(nav, "a", "q2"), null, "wrong request → stale");
  assert.equal(liveQNav(null, "a", "q1"), null);

  let s = reduce(initialState(), { t: "qnavSet", nav });
  assert.deepEqual(s.qnav, nav);
  // resolving an unrelated request leaves it alone
  s = reduce(s, { t: "resolvePerm", sessionId: "a", id: "other" });
  assert.deepEqual(s.qnav, nav);
  // resolving the one it tracks clears it
  s = reduce(s, { t: "resolvePerm", sessionId: "a", id: "q1" });
  assert.equal(s.qnav, null);
});

test("a permission's matching tool_result clears it, even mid-replay with the session still awaiting_input", () => {
  // Reconnect/history-replay: the daemon has long since resolved p1 (no
  // dedicated event marks that — only the `tool_result` does, per the
  // daemon's own `#trackPerms`), but the session is genuinely awaiting_input
  // again for p2. Without tracking `tool_result`, p1 would sit in
  // `permissions` forever and `firstPerm` would keep surfacing it instead of
  // the real, current request.
  const a = snap({ id: "a", status: "awaiting_input", awaitReason: "permission" });
  let s = reduce(initialState(), fleet([a]));
  s = reduce(s, {
    t: "push",
    frame: push(
      1,
      ev({
        type: "permission_request",
        id: "p1",
        tool: "bash",
        input: { command: "ls" },
        sessionId: "a",
      }),
    ),
  });
  s = reduce(s, {
    t: "push",
    frame: push(2, ev({ type: "tool_result", id: "p1", ok: true, output: "", sessionId: "a" })),
  });
  assert.equal(firstPerm(pendingFor(s, "a")), undefined);

  s = reduce(s, {
    t: "push",
    frame: push(
      3,
      ev({
        type: "permission_request",
        id: "p2",
        tool: "bash",
        input: { command: "pwd" },
        sessionId: "a",
      }),
    ),
  });
  assert.equal(firstPerm(pendingFor(s, "a"))?.id, "p2");

  // a tool_result for an unrelated id is a no-op
  s = reduce(s, {
    t: "push",
    frame: push(4, ev({ type: "tool_result", id: "other", ok: true, output: "", sessionId: "a" })),
  });
  assert.equal(firstPerm(pendingFor(s, "a"))?.id, "p2");
});

test("pending question is cleared by the matching answer event", () => {
  let s = reduce(
    initialState(),
    fleet([snap({ id: "a", status: "awaiting_input", awaitReason: "question" })]),
  );
  s = reduce(s, {
    t: "push",
    frame: push(1, ev({ type: "question", id: "q1", question: "?", sessionId: "a" })),
  });
  assert.equal(pendingFor(s, "a").question, "q1");
  s = reduce(s, {
    t: "push",
    frame: push(2, ev({ type: "answer", id: "q1", text: "sqlite", sessionId: "a" })),
  });
  assert.equal(pendingFor(s, "a").question, undefined);
});

test("a plan_review stashes the plan text; openPlan / closePlan drive the overlay", () => {
  const a = snap({ id: "a", status: "awaiting_input", awaitReason: "plan_review" });
  let s = reduce(initialState(), fleet([a]));
  s = reduce(s, {
    t: "push",
    frame: push(
      1,
      ev({ type: "plan_review", id: "pr1", plan: "step one\nstep two", sessionId: "a" }),
    ),
  });
  assert.equal(pendingFor(s, "a").plan, "pr1");
  assert.equal(pendingFor(s, "a").planText, "step one\nstep two");

  s = reduce(s, { t: "openPlan", sessionId: "a", requestId: "pr1", text: "step one\nstep two" });
  assert.equal(s.mode, "plan");
  assert.equal(s.plan?.requestId, "pr1");
  assert.equal(s.plan?.mode, "acceptEdits");

  // ⇧⇥ cycles the implement mode — manual → acceptEdits → auto → manual.
  s = reduce(s, { t: "cyclePlanMode" });
  assert.equal(s.plan?.mode, "auto");
  s = reduce(s, { t: "cyclePlanMode" });
  assert.equal(s.plan?.mode, "default");
  s = reduce(s, { t: "cyclePlanMode" });
  assert.equal(s.plan?.mode, "acceptEdits");

  // reopening the same review (esc out of the discuss prompt) keeps the cycled
  // mode; a different review starts fresh at acceptEdits.
  s = reduce(s, { t: "cyclePlanMode" }); // → auto
  s = reduce(s, { t: "openPlan", sessionId: "a", requestId: "pr1", text: "step one\nstep two" });
  assert.equal(s.plan?.mode, "auto");
  s = reduce(s, { t: "openPlan", sessionId: "a", requestId: "pr2", text: "next plan" });
  assert.equal(s.plan?.mode, "acceptEdits");

  // the session moving on closes the overlay and clears pending
  s = reduce(s, fleet([snap({ id: "a", status: "running" })]));
  assert.equal(s.plan, null);
  assert.equal(s.mode, "browse");
  assert.equal(pendingFor(s, "a").plan, undefined);
});

test("⌥p stages an implement-fresh retarget onto the plan overlay", () => {
  const a = snap({ id: "a", status: "awaiting_input", awaitReason: "plan_review" });
  let s = reduce(initialState(), fleet([a]));
  s = reduce(s, { t: "openPlan", sessionId: "a", requestId: "pr1", text: "the plan" });
  s = reduce(s, { t: "cyclePlanMode" }); // → auto, must survive the wizard

  // The `⌥p` wizard opens over the review — `plan` rides through, unlike the
  // `new` / find pickers which clear it.
  const wiz = makePicker({
    kind: "model",
    title: "retarget · model · claude",
    items: [{ id: "m1", label: "m1" }],
    ctx: { planStage: true, provider: "claude" },
  });
  s = reduce(s, { t: "openPicker", picker: wiz });
  assert.equal(s.mode, "picker");
  assert.equal(s.plan?.requestId, "pr1");
  assert.equal(s.plan?.mode, "auto");

  // Esc out of a plan-stage step returns to the overlay, nothing staged.
  const openWiz = s.picker ?? wiz;
  assert.deepEqual(escapeTarget(openWiz, s), { t: "closePicker" });
  s = reduce(s, { t: "closePicker" });
  assert.equal(s.mode, "plan");
  assert.equal(s.plan?.impl, undefined);

  // Picking through the wizard stages provider / model / effort and reopens
  // the overlay with the cycled mode intact.
  s = reduce(s, { t: "openPicker", picker: wiz });
  s = reduce(s, { t: "stagePlanImpl", provider: "openai", model: "gpt-x", effort: "high" });
  assert.equal(s.mode, "plan");
  assert.equal(s.picker, null);
  assert.deepEqual(s.plan?.impl, { provider: "openai", model: "gpt-x", effort: "high" });
  assert.equal(s.plan?.mode, "auto");

  // Reopening the same review (esc out of discuss) keeps the staged retarget.
  s = reduce(s, { t: "openPlan", sessionId: "a", requestId: "pr1", text: "the plan" });
  assert.deepEqual(s.plan?.impl, { provider: "openai", model: "gpt-x", effort: "high" });
  // A different review starts clean.
  s = reduce(s, { t: "openPlan", sessionId: "a", requestId: "pr2", text: "another" });
  assert.equal(s.plan?.impl, undefined);
});

test("makePicker clamps its initial index into range", () => {
  const items = [
    { id: "a", label: "a" },
    { id: "b", label: "b" },
  ];
  assert.equal(makePicker({ kind: "model", title: "t", items, index: 1 }).index, 1);
  assert.equal(makePicker({ kind: "model", title: "t", items, index: 9 }).index, 1);
  assert.equal(makePicker({ kind: "model", title: "t", items, index: -1 }).index, 0);
  assert.equal(makePicker({ kind: "model", title: "t", items }).index, 0);
});

test("a plan is cleared by its matching tool_result once the decision lands", () => {
  // The plan_review is keyed on the ExitPlanMode / exit_plan tool-call id, so
  // its `tool_result` is the only durable mark that the plan was decided —
  // the daemon clears its own map in `respondToPlan`, but that never reaches
  // the event log a client backfills from.
  let s = reduce(
    initialState(),
    fleet([snap({ id: "a", status: "awaiting_input", awaitReason: "plan_review" })]),
  );
  s = reduce(s, {
    t: "push",
    frame: push(1, ev({ type: "plan_review", id: "p1", plan: "the plan", sessionId: "a" })),
  });
  s = reduce(s, {
    t: "push",
    frame: push(
      2,
      ev({ type: "tool_result", id: "p1", ok: true, output: "Plan approved.", sessionId: "a" }),
    ),
  });
  assert.equal(pendingFor(s, "a").plan, undefined);

  // an unrelated tool_result leaves the plan alone
  s = reduce(s, {
    t: "push",
    frame: push(3, ev({ type: "plan_review", id: "p2", plan: "next plan", sessionId: "a" })),
  });
  s = reduce(s, {
    t: "push",
    frame: push(4, ev({ type: "tool_result", id: "other", ok: true, output: "", sessionId: "a" })),
  });
  assert.equal(pendingFor(s, "a").plan, "p2");
});

test("a replayed plan_review can't resurrect a plan the session already moved past", () => {
  // Reconnect/history-backfill: the plan was approved while the client
  // watched live, `session_updated` settled pending — then a selection
  // change replays the durable history, which still holds the plan_review
  // (nothing in the event stream marks a plan resolved). Re-applying it
  // would pin the request panel on the stale plan text while the session
  // is genuinely parked on something else.
  const a = snap({ id: "a", status: "awaiting_input", awaitReason: "permission" });
  let s = reduce(initialState(), fleet([a]));
  s = reduce(s, {
    t: "push",
    frame: push(1, ev({ type: "plan_review", id: "pr1", plan: "old plan", sessionId: "a" })),
  });
  s = reduce(s, fleet([snap({ id: "a", status: "running" })]));
  assert.equal(pendingFor(s, "a").plan, undefined);

  // the backfill re-dispatches the same (seq, epoch) frame — a duplicate
  s = reduce(s, {
    t: "push",
    frame: push(1, ev({ type: "plan_review", id: "pr1", plan: "old plan", sessionId: "a" })),
  });
  assert.equal(pendingFor(s, "a").plan, undefined);
});

test("focusedPending keeps only the surface the daemon says the session is parked on", () => {
  const stale = {
    plan: "pr-old",
    planText: "old plan",
    permissions: [{ id: "p1", tool: "bash", input: { command: "ls" } }],
  };
  // parked on a permission → the stale plan must not win the panel
  assert.deepEqual(focusedPending(stale, "permission"), {
    permissions: stale.permissions,
  });
  // parked on the plan → the plan stays
  assert.deepEqual(focusedPending(stale, "plan_review"), {
    plan: "pr-old",
    planText: "old plan",
  });
  // an `on` with nothing matching keeps everything (no info to drop by)
  assert.deepEqual(focusedPending(stale, "question"), stale);
  assert.deepEqual(focusedPending(stale, null), stale);
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
  const keysFor = (mode: TuiState["mode"]) => footerHints({ ...base, mode }).map((h) => h.label);

  assert.deepEqual(footerHints({ ...base, mode: "prompt" }), []); // editor draws itself
  assert.deepEqual(keysFor("picker"), ["move", "pick", "cancel"]);
  assert.deepEqual(keysFor("confirm"), ["confirm", "cancel"]);
  // a delete confirm that carries a branch gets the extra toggle
  assert.deepEqual(
    footerHints({
      ...base,
      mode: "confirm",
      confirm: {
        title: "x",
        danger: true,
        action: "deleteSession",
        sessionId: "s1",
        branchName: "loom/x",
      },
    }).map((h) => h.label),
    ["confirm", "+ branch", "cancel"],
  );
  assert.deepEqual(keysFor("plan"), ["implement", "fresh", "edit", "discuss", "view"]);
  assert.deepEqual(keysFor("help"), ["close help"]);
  // browse delegates to the selected session's contextual actions
  assert.ok(keysFor("browse").includes("send"));
  // …trimmed to the footer subset, then the palette pointer
  assert.equal(keysFor("browse").at(-1), "more");
  assert.ok(!keysFor("browse").includes("rename"), "second-tier verbs stay off the footer");
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
  const withQueue: TuiState = { ...base, queue: { s1: ["pending note"] } };
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

test("cacheHeat bands the remaining fraction; null when not warm", () => {
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
  assert.equal(toLogLine(1, "e1", ev({ type: "assistant_text", text: "hi" })).full, undefined);
  assert.equal(toLogLine(2, "e1", ev({ type: "assistant_text", text: long })).full, long);
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

  // once the reducer has seen the matching tool_call, the tool_result's `full`
  // — the whole file — is dropped: the call line already says enough, and the
  // user can see the file themselves.
  const a = snap({ id: "a", status: "running" });
  let s = reduce(initialState(), fleet([a]));
  s = reduce(s, { t: "select", id: "a" });
  s = reduce(s, {
    t: "push",
    frame: push(
      1,
      ev({
        type: "tool_call",
        id: "r1",
        name: "Read",
        input: { file_path: "a.ts" },
        sessionId: "a",
      }),
    ),
  });
  s = reduce(s, {
    t: "push",
    frame: push(
      2,
      ev({
        type: "tool_result",
        id: "r1",
        ok: true,
        output: { text: "line one\nline two" },
        sessionId: "a",
      }),
    ),
  });
  const result = sessionLog(s).at(-1);
  assert.equal(result?.text, "ok");
  assert.equal(result?.full, undefined, "the file content isn't duplicated into the log");

  // an error result from a Read is still shown in full — it's short and useful
  s = reduce(s, {
    t: "push",
    frame: push(
      3,
      ev({
        type: "tool_call",
        id: "r2",
        name: "Read",
        input: { file_path: "missing.ts" },
        sessionId: "a",
      }),
    ),
  });
  s = reduce(s, {
    t: "push",
    frame: push(
      4,
      ev({ type: "tool_result", id: "r2", ok: false, output: { text: "ENOENT" }, sessionId: "a" }),
    ),
  });
  const failed = sessionLog(s).at(-1);
  assert.equal(failed?.full, "error\nENOENT");
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
  let s = reduce(initialState(), {
    t: "openPrompt",
    prompt: makePrompt({ kind: "send", sessionId: "a", label: "send" }),
  });
  assert.equal(s.mode, "prompt");
  s = reduce(s, { t: "promptSet", buffer: buffer("hello") });
  assert.equal(s.prompt?.buffer.text, "hello");
  s = reduce(s, { t: "closePrompt" });
  assert.equal(s.mode, "browse");
  assert.equal(s.prompt, null);
});

test("Esc on a new/send prompt stashes the draft; either prompt can restore it; submitting clears it", () => {
  // cancelling a `new` prompt saves the draft
  let s = reduce(initialState(), {
    t: "openPrompt",
    prompt: makePrompt({ kind: "new", sessionId: null, label: "new session" }),
  });
  s = reduce(s, { t: "promptSet", buffer: buffer("fix the bug") });
  s = reduce(s, { t: "closePrompt", saveDraft: true });
  assert.equal(s.lastDraft, "fix the bug");

  // ...and a `send` prompt opened afterwards picks it up
  s = reduce(s, {
    t: "openPrompt",
    prompt: makePrompt({ kind: "send", sessionId: "a", label: "send", text: s.lastDraft }),
  });
  assert.equal(s.prompt?.buffer.text, "fix the bug");

  // cancelling without saveDraft (e.g. a plain closePrompt) leaves it untouched
  let untouched = reduce(s, { t: "closePrompt" });
  assert.equal(untouched.lastDraft, "");

  // cancelling a `title` prompt never touches the shared draft
  let withDraft = reduce(initialState(), { t: "closePrompt", saveDraft: true }); // no prompt open: no-op
  assert.equal(withDraft.lastDraft, "");
  withDraft = { ...withDraft, lastDraft: "fix the bug" };
  withDraft = reduce(withDraft, {
    t: "openPrompt",
    prompt: makePrompt({ kind: "title", sessionId: "a", label: "rename", text: "old title" }),
  });
  withDraft = reduce(withDraft, { t: "promptSet", buffer: buffer("new title") });
  withDraft = reduce(withDraft, { t: "closePrompt", saveDraft: true });
  assert.equal(
    withDraft.lastDraft,
    "fix the bug",
    "renaming doesn't clobber the send/new draft slot",
  );

  // submitting (closePrompt without saveDraft) consumes the draft
  let sent = reduce(initialState(), {
    t: "openPrompt",
    prompt: makePrompt({ kind: "send", sessionId: "a", label: "send", text: "fix the bug" }),
  });
  sent = { ...sent, lastDraft: "fix the bug" };
  sent = reduce(sent, { t: "closePrompt" });
  assert.equal(sent.lastDraft, "", "a sent message shouldn't linger as a restorable draft");
});

test("promptCycleMode only cycles for a `new` prompt", () => {
  let s = reduce(initialState(), {
    t: "openPrompt",
    prompt: makePrompt({ kind: "new", sessionId: null, label: "new" }),
  });
  assert.equal(
    s.prompt?.mode,
    undefined,
    "a fresh new-prompt carries no mode — it just uses the default",
  );
  s = reduce(s, { t: "promptCycleMode" });
  assert.equal(s.prompt?.mode, "plan");
  s = reduce(s, { t: "promptCycleMode" });
  assert.equal(s.prompt?.mode, "acceptEdits");

  let t = reduce(initialState(), {
    t: "openPrompt",
    prompt: makePrompt({ kind: "send", sessionId: "a", label: "send" }),
  });
  t = reduce(t, { t: "promptCycleMode" });
  assert.equal(t.prompt?.mode, undefined);
});

test("pushHistory dedupes, keeps newest-last, and caps at 50; promptHistoryNav walks it", () => {
  let s = initialState();
  for (const x of ["one", "two", "one", "three"]) s = reduce(s, { t: "pushHistory", text: x });
  assert.deepEqual(s.promptHistory, ["two", "one", "three"]);

  s = reduce(s, {
    t: "openPrompt",
    prompt: makePrompt({ kind: "send", sessionId: "a", label: "send", text: "live" }),
  });
  s = reduce(s, { t: "promptHistoryNav", dir: -1 });
  assert.equal(s.prompt?.buffer.text, "three");
  s = reduce(s, { t: "promptHistoryNav", dir: -1 });
  assert.equal(s.prompt?.buffer.text, "one");
  s = reduce(s, { t: "promptHistoryNav", dir: 1 });
  s = reduce(s, { t: "promptHistoryNav", dir: 1 });
  assert.equal(s.prompt?.buffer.text, "live", "returns to the stashed live draft at index 0");
});

test("editing a recalled history entry detaches it from the walk", () => {
  let s = initialState();
  s = reduce(s, { t: "pushHistory", text: "hi" });
  s = reduce(s, {
    t: "openPrompt",
    prompt: makePrompt({ kind: "send", sessionId: "a", label: "send" }),
  });
  s = reduce(s, { t: "promptHistoryNav", dir: -1 });
  assert.equal(s.prompt?.buffer.text, "hi");
  assert.equal(s.prompt?.histIdx, 1);

  // A cursor-only move (same text) does not detach.
  s = reduce(s, { t: "promptSet", buffer: buffer("hi", 0) });
  assert.equal(s.prompt?.histIdx, 1);

  // Editing the recalled entry makes it the live buffer: ↓ is a no-op, ↑
  // restarts the walk from the newest entry.
  s = reduce(s, { t: "promptSet", buffer: buffer("hello") });
  assert.equal(s.prompt?.histIdx, 0);
  s = reduce(s, { t: "promptHistoryNav", dir: 1 });
  assert.equal(s.prompt?.buffer.text, "hello", "↓ at the live buffer keeps the edit");
  s = reduce(s, { t: "promptHistoryNav", dir: -1 });
  assert.equal(s.prompt?.buffer.text, "hi", "↑ restarts the walk from the newest entry");
  s = reduce(s, { t: "promptHistoryNav", dir: 1 });
  assert.equal(s.prompt?.buffer.text, "hello", "↓ returns to the detached edit");
});

test("↓ at the live buffer never clobbers it with the stashed draft", () => {
  let s = initialState();
  s = reduce(s, { t: "pushHistory", text: "old" });
  s = reduce(s, {
    t: "openPrompt",
    prompt: makePrompt({ kind: "send", sessionId: "a", label: "send" }),
  });
  s = reduce(s, { t: "promptSet", buffer: buffer("typed") });
  s = reduce(s, { t: "promptHistoryNav", dir: 1 });
  assert.equal(s.prompt?.buffer.text, "typed", "↓ is a no-op at the live buffer");
});

test("echo appends a local log line and never truncates", () => {
  let s = initialState();
  const echo = (seq: number, text: string, ts: number): LogLine => ({
    seq,
    epoch: "",
    sessionId: "a",
    kind: "echo",
    glyph: "›",
    text,
    tone: "accent",
    ts,
  });
  s = reduce(s, { t: "echo", line: echo(-1, "hi", 1) });
  s = reduce(s, { t: "echo", line: echo(-2, "there", 2) });
  s = reduce(s, { t: "echo", line: echo(-3, "again", 3) });
  assert.deepEqual(
    s.log.map((l) => l.text),
    ["hi", "there", "again"],
  );
});

test("enqueue / dequeue / clearQueue and queueFor", () => {
  let s = initialState();
  s = reduce(s, { t: "enqueue", sessionId: "a", text: "  first  " });
  s = reduce(s, { t: "enqueue", sessionId: "a", text: "second" });
  s = reduce(s, { t: "enqueue", sessionId: "a", text: "   " }); // blank ignored
  assert.deepEqual(queueFor(s, "a"), ["first", "second"]);
  s = reduce(s, { t: "dequeue", sessionId: "a" });
  assert.deepEqual(queueFor(s, "a"), ["second"]);
  s = reduce(s, { t: "dequeue", sessionId: "a" });
  assert.deepEqual(queueFor(s, "a"), []);
  assert.equal("a" in s.queue, false, "empty queue entry is removed");

  s = reduce(s, { t: "enqueue", sessionId: "b", text: "x" });
  s = reduce(s, { t: "clearQueue", sessionId: "b" });
  assert.deepEqual(queueFor(s, "b"), []);
});

test("a permission_request stashes the tool + input; leaving awaiting_input clears it", () => {
  let s = reduce(initialState(), fleet([snap({ id: "a", status: "awaiting_input" })]));
  s = reduce(s, {
    t: "push",
    frame: push(
      1,
      ev({
        type: "permission_request",
        id: "p1",
        tool: "Bash",
        input: { command: "rm -rf x" },
        sessionId: "a",
      }),
    ),
  });
  assert.deepEqual(firstPerm(pendingFor(s, "a")), {
    id: "p1",
    tool: "Bash",
    input: { command: "rm -rf x" },
  });
  s = reduce(s, fleet([snap({ id: "a", status: "running" })]));
  assert.deepEqual(pendingFor(s, "a"), {});
});

test("queue entries are pruned when their session disappears", () => {
  let s = reduce(initialState(), fleet([snap({ id: "a", status: "running" })]));
  s = reduce(s, { t: "enqueue", sessionId: "a", text: "later" });
  s = reduce(s, fleet([]));
  assert.deepEqual(queueFor(s, "a"), []);
});

test("confirm open / run / close", () => {
  let s = reduce(initialState(), {
    t: "openConfirm",
    confirm: { title: "Restart the daemon?", danger: false, action: "restart" },
  });
  assert.equal(s.mode, "confirm");
  assert.equal(s.confirm?.action, "restart");
  s = reduce(s, { t: "closeConfirm" });
  assert.equal(s.mode, "browse");
  assert.equal(s.confirm, null);
});

test("toggleConfirmBranch flips deleteBranch only when a branch is on offer", () => {
  let s = reduce(initialState(), {
    t: "openConfirm",
    confirm: {
      title: "Delete?",
      danger: true,
      action: "deleteSession",
      sessionId: "s1",
      branchName: "loom/x",
      deleteBranch: false,
    },
  });
  s = reduce(s, { t: "toggleConfirmBranch" });
  assert.equal(s.confirm?.deleteBranch, true);
  s = reduce(s, { t: "toggleConfirmBranch" });
  assert.equal(s.confirm?.deleteBranch, false);

  // no branchName (in-place / gc'd session) → the toggle is inert
  let t = reduce(initialState(), {
    t: "openConfirm",
    confirm: { title: "Delete?", danger: true, action: "deleteSession", sessionId: "s2" },
  });
  t = reduce(t, { t: "toggleConfirmBranch" });
  assert.equal(t.confirm?.deleteBranch, undefined);
});

test("help toggles the mode without disturbing the rest of the state", () => {
  const a = snap({ id: "a", status: "running" });
  let s = reduce(initialState(), fleet([a]));
  s = reduce(s, { t: "help", value: true });
  assert.equal(s.mode, "help");
  assert.equal(s.selectedId, "a");
  s = reduce(s, { t: "help", value: false });
  assert.equal(s.mode, "browse");
});

test("doctor: open sets the mode, doctorLoaded caches the report, close returns to browse", () => {
  const a = snap({ id: "a", status: "running" });
  let s = reduce(initialState(), fleet([a]));
  assert.equal(s.doctor, null);

  s = reduce(s, { t: "doctor", value: true });
  assert.equal(s.mode, "doctor");
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
      eventBuffer: 3,
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
  assert.equal(s.mode, "doctor");

  s = reduce(s, { t: "doctor", value: false });
  assert.equal(s.mode, "browse");
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
  let s = initialState();
  s = reduce(s, {
    t: "push",
    frame: push(1, ev({ type: "assistant_text", text: "here is the answer" })),
  });
  s = reduce(s, {
    t: "push",
    frame: push(2, ev({ type: "status_changed", status: stateIdle, note: "result" })),
  });
  s = reduce(s, {
    t: "push",
    frame: push(3, ev({ type: "result", kind: "ok", summary: "here is the answer" })),
  });
  assert.deepEqual(
    s.log.map((l) => l.glyph),
    ["▪", "■"],
    "no ◈ status line; result kept but terse",
  );
  assert.equal(s.log.at(-1)?.text, "turn complete");
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
  let s = reduce(withProviders(), {
    t: "openPicker",
    picker: makePicker({
      kind: "model",
      title: "model",
      items: modelPickItems(withProviders(), "openai"),
    }),
  });
  assert.equal(s.mode, "picker");
  assert.equal(pickerVisible(s.picker!).length, 3);

  s = reduce(s, { t: "pickerMove", delta: 5 });
  assert.equal(s.picker!.index, 2); // clamped to last

  s = reduce(s, { t: "pickerFilter", buffer: buffer("mini") });
  assert.equal(pickerVisible(s.picker!).length, 1);
  assert.equal(s.picker!.index, 0); // reset on filter
  assert.equal(pickerCurrent(s.picker!)?.id, "gpt-5-mini");

  s = reduce(s, { t: "closePicker" });
  assert.equal(s.mode, "browse");
  assert.equal(s.picker, null);
});

test("the fleet filter matches title + log text and rides the selection", () => {
  let s = reduce(
    withProviders(),
    fleet([
      snap({ id: "aaa", status: "running", title: "renovate the deck" }),
      snap({ id: "bbb", status: "idle", title: "refactor the parser" }),
    ]),
  );
  s = reduce(s, {
    t: "push",
    frame: {
      type: "event",
      seq: 1,
      event: {
        type: "assistant_text",
        sessionId: "bbb",
        ts: 1,
        text: "refactor the parser module",
      },
    },
  } as never);

  s = reduce(s, { t: "openFind" });
  assert.equal(s.find?.buffer.text, "");

  // A query matches the title OR the session's log text; as it narrows, the
  // selection rides onto the first match.
  s = reduce(s, { t: "findSet", buffer: buffer("parser") });
  assert.equal(s.selectedId, "bbb");

  // ↑/↓ walk the matching sessions only, never leaving the filtered set.
  s = reduce(s, { t: "findSet", buffer: buffer("the") }); // both match again
  assert.equal(s.selectedId, "bbb"); // still on a match — no jump
  s = reduce(s, { t: "move", delta: -1 });
  assert.equal(s.selectedId, "aaa");
  s = reduce(s, { t: "move", delta: 1 });
  assert.equal(s.selectedId, "bbb");

  // esc closes the filter; the selection survives.
  s = reduce(s, { t: "closeFind" });
  assert.equal(s.find, null);
  assert.equal(s.selectedId, "bbb");
});

test("a live model picker closes if its session is removed", () => {
  let s = reduce(
    withProviders(),
    fleet([snap({ id: "live", status: "running", provider: "openai" })]),
  );
  s = reduce(s, {
    t: "openPicker",
    picker: makePicker({
      kind: "model",
      title: "model",
      items: modelPickItems(s, "openai"),
      ctx: { provider: "openai", liveSessionId: "live" },
    }),
  });
  // A snapshot the session has dropped out of closes the picker aimed at it.
  s = reduce(s, fleet([]));
  assert.equal(s.picker, null);
  assert.equal(s.mode, "browse");
});

test("escapeTarget: an effort step reached via the model wizard steps back to it; a bare ⌥t doesn't", () => {
  const s = withProviders(); // claude/claude-opus-5 has supportsEffort: true

  // Reached by picking a model that takes one (⌥p wizard, or ⌥m onto such a
  // model) — Esc steps back to the model list, live switch or not.
  const viaWizard = makePicker({
    kind: "effort",
    title: "effort",
    items: [],
    ctx: { provider: "claude", model: "claude-opus-5", viaModelStep: true },
  });
  const backToModel = escapeTarget(viaWizard, s);
  assert.equal(backToModel.t, "openPicker");
  assert.equal(backToModel.t === "openPicker" && backToModel.picker.kind, "model");

  // A bare ⌥t on a live session skipped the model step entirely — Esc must
  // not invent one to go back to; with nothing else to return to, it closes.
  const bareLive = makePicker({
    kind: "effort",
    title: "effort",
    items: [],
    ctx: { provider: "claude", model: "claude-opus-5", liveSessionId: "s1" },
  });
  assert.deepEqual(escapeTarget(bareLive, s), { t: "closePicker" });

  // A bare ⌥t from inside a `send` prompt — no model step, but reopens that
  // prompt with the draft, same as a bare ⌥m would.
  const bareSend = makePicker({
    kind: "effort",
    title: "effort",
    items: [],
    ctx: {
      provider: "claude",
      model: "claude-opus-5",
      liveSessionId: "s1",
      reopenSend: "s1",
      draft: "half-typed",
    },
  });
  const reopened = escapeTarget(bareSend, s);
  assert.equal(reopened.t, "openPrompt");
  assert.equal(reopened.t === "openPrompt" && reopened.prompt.kind, "send");
  assert.equal(reopened.t === "openPrompt" && reopened.prompt.buffer.text, "half-typed");

  // A bare ⌥t from the `new` prompt — restores it with the draft and provider.
  const bareNew = makePicker({
    kind: "effort",
    title: "effort",
    items: [],
    ctx: { provider: "claude", model: "claude-opus-5", draft: "hi" },
  });
  const restored = escapeTarget(bareNew, s);
  assert.equal(restored.t, "openPrompt");
  assert.equal(restored.t === "openPrompt" && restored.prompt.kind, "new");
  assert.equal(restored.t === "openPrompt" && restored.prompt.provider, "claude");
  assert.equal(restored.t === "openPrompt" && restored.prompt.buffer.text, "hi");
});

test("escapeTarget: the live ⌥p provider wizard steps back through its own trail", () => {
  const s = withProviders();

  // Provider step of a live switch opened from a send prompt — Esc restores that
  // prompt with the draft (there is no `new` prompt to fall into).
  const fromSend = makePicker({
    kind: "provider",
    title: "provider",
    items: providerPickItems(s),
    ctx: { liveSessionId: "s1", reopenSend: "s1", draft: "wip" },
  });
  const back1 = escapeTarget(fromSend, s);
  assert.equal(back1.t, "openPrompt");
  assert.equal(back1.t === "openPrompt" && back1.prompt.kind, "send");
  assert.equal(back1.t === "openPrompt" && back1.prompt.buffer.text, "wip");

  // Provider step of a live switch from the fleet view (nothing behind it) —
  // Esc just closes.
  const fromFleet = makePicker({
    kind: "provider",
    title: "provider",
    items: providerPickItems(s),
    ctx: { liveSessionId: "s1" },
  });
  assert.deepEqual(escapeTarget(fromFleet, s), { t: "closePicker" });

  // Model step reached from that live provider step — Esc steps back to the
  // provider list rather than closing.
  const modelStep = makePicker({
    kind: "model",
    title: "model · openai",
    items: modelPickItems(s, "openai"),
    ctx: { provider: "openai", liveSessionId: "s1", viaProviderStep: true },
  });
  const back3 = escapeTarget(modelStep, s);
  assert.equal(back3.t, "openPicker");
  assert.equal(back3.t === "openPicker" && back3.picker.kind, "provider");

  // Regression: the non-live ⌥p new-session wizard still falls back to a `new`
  // prompt, not a live send.
  const newWizard = makePicker({
    kind: "provider",
    title: "provider",
    items: providerPickItems(s),
    ctx: { draft: "idea" },
  });
  const back4 = escapeTarget(newWizard, s);
  assert.equal(back4.t, "openPrompt");
  assert.equal(back4.t === "openPrompt" && back4.prompt.kind, "new");
  assert.equal(back4.t === "openPrompt" && back4.prompt.buffer.text, "idea");
});

test("makePrompt carries provider + model for the ⌃P chooser flow", () => {
  const p = makePrompt({
    kind: "new",
    sessionId: null,
    label: "new",
    provider: "openai",
    model: "o4",
  });
  assert.equal(p.provider, "openai");
  assert.equal(p.model, "o4");
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

test("detailRows counts the Detail pane's physical rows, conditional lines included", () => {
  assert.equal(detailRows(null), 4); // borders + "DETAIL" + the select hint
  assert.equal(detailRows(snap({ id: "a", status: "idle" })), 10);

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
  const rows = detailRows(full, {
    account: "claude pro (acme)",
    compacting: { startedAt: Date.now(), before: 90_000 },
    queued: ["follow up"],
  });
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
  const prompted = reduce(noted, {
    t: "openPrompt",
    prompt: makePrompt({ kind: "new", sessionId: null, label: "new session" }),
  });
  assert.equal(promptRows(prompted, 100), 3);
});

test("promptRows counts word-wrapped editor rows at the terminal's width", () => {
  const open = (text: string) =>
    reduce(initialState(), {
      t: "openPrompt",
      prompt: makePrompt({ kind: "new", sessionId: null, label: "new session", text }),
    });
  // "one two three" fills one row at 80 cols; at 12 cols (room 8) it wraps in two.
  const wide = open("one two three");
  assert.equal(promptRows(wide, 80), 3);
  assert.equal(promptRows(wide, 12), 4);
  // The budget never exceeds MAX_EDITOR_ROWS, however long the text wraps.
  const flood = open("word ".repeat(40));
  assert.equal(promptRows(flood, 12), 10);
});

test("a reply prompt's input budgets on the EVENTS pane, not the footer", () => {
  const open = (text: string) =>
    reduce(initialState(), {
      t: "openPrompt",
      prompt: makePrompt({ kind: "send", sessionId: "a", label: "send", text }),
    });
  // The footer carries only the hints row…
  assert.equal(promptRows(open(""), 100), 1);
  // …and the pane carries label + wrapped editor, capped at MAX_EDITOR_ROWS.
  assert.equal(promptPaneRows(open("one two three"), 100), 2);
  assert.equal(promptPaneRows(open("word ".repeat(40)), 12), 9);
});

// keep a reference to TuiState so the import is load-bearing for type checks
const _typecheck: TuiState = initialState();
void _typecheck;

// --- snapshot-backed compacting (survives a reopen / second client) ---------

test("a snapshot's compacting overlay seeds the indicator across a reopen", () => {
  // hello: a session already mid-compaction at attach time shows "compacting…".
  const mid = snap({
    id: "a",
    status: "idle",
    compacting: { startedAt: 9_000, before: 120_000, generated: 0 },
  });
  let s = reduce(initialState(), fleet([mid]));
  assert.deepEqual(s.compacting["a"], { startedAt: 9_000, generated: 0, before: 120_000 });

  // The gate released — a snapshot without the flag clears the entry (the
  // daemon only clears it after the boundary has already been broadcast).
  s = reduce(s, fleet([snap({ id: "a", status: "idle", updatedAt: 99 })]));
  assert.equal(s.compacting["a"], undefined);
});

test("a snapshot seeds the compacting overlay mid-flight and never clobbers live beats", () => {
  let s = reduce(initialState(), fleet([snap({ id: "s1" })]));
  s = reduce(s, {
    t: "push",
    frame: push(
      1,
      ev({
        type: "compact_progress",
        sessionId: "s1",
        ts: 10_000,
        elapsedMs: 4_000,
        generated: 128,
        before: 90_000,
      }),
    ),
  });
  // A live beat-driven entry is fresher than any snapshot — the seed skips it.
  s = reduce(
    s,
    fleet([
      snap({
        id: "s1",
        status: "idle",
        compacting: { startedAt: 1, before: 1, generated: 0 },
        updatedAt: 50,
      }),
    ]),
  );
  assert.deepEqual(s.compacting["s1"], { startedAt: 6_000, generated: 128, before: 90_000 });

  // A second session's compaction seeds off the same snapshot without touching
  // the first — every snapshot carries the whole fleet, so both are present.
  s = reduce(
    s,
    fleet([
      snap({
        id: "s1",
        status: "idle",
        compacting: { startedAt: 1, before: 1, generated: 0 },
        updatedAt: 50,
      }),
      snap({
        id: "s2",
        status: "idle",
        compacting: { startedAt: 42_000, before: 77_000, generated: 0 },
        updatedAt: 51,
      }),
    ]),
  );
  assert.deepEqual(s.compacting["s2"], { startedAt: 42_000, generated: 0, before: 77_000 });
  assert.deepEqual(s.compacting["s1"], { startedAt: 6_000, generated: 128, before: 90_000 });
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
  const opened = reduce(s, {
    t: "openPicker",
    picker: makePicker({
      kind: "model",
      title: "model · claude",
      items: modelPickItems(s, "claude"),
      emptyText: modelPickEmptyText(s, "claude"),
      ctx: { provider: "claude" },
    }),
  });
  assert.equal(opened.picker?.items.length, 0);

  // …then the daemon's settle push lands — the same picker fills in.
  const settled = reduce(opened, fleet([], PROVIDERS));
  assert.deepEqual(
    settled.picker?.items.map((i) => i.id),
    ["claude-opus-5", "claude-sonnet-5"],
  );
  assert.equal(settled.picker?.emptyText, undefined);
});

test("logRowCount tracks the resolved child through drill and drain", () => {
  const seed = (sessions: SessionSnapshot[]): TuiState => {
    let t = reduce(initialState(), fleet(sessions));
    t = reduce(t, {
      t: "push",
      frame: push(1, ev({ sessionId: "fan", type: "assistant_text", text: "mainline" })),
    });
    t = reduce(t, {
      t: "push",
      frame: push(
        2,
        ev({
          sessionId: "fan",
          type: "assistant_text",
          text: `from reviewer ${"wrap ".repeat(40)}`,
          agentId: "t1",
        }),
      ),
    });
    return t;
  };

  // Drill into the reviewer sub-agent: the pane narrows to its stream.
  let s = seed([fanout]);
  const full = logRowCount(s, 60);
  s = reduce(s, { t: "childEnter" });
  s = reduce(s, { t: "childMove", delta: 2 }); // → sub:t1
  const narrowed = logRowCount(s, 60);
  assert.ok(narrowed > 0 && narrowed !== full, "the narrowed pane measures its own stream");

  // Every child drains at once: the snapshot leaves nothing to focus, so
  // `focusedChildOf` resolves to null and the pane un-narrows. The measurement
  // has to follow the *resolved* child, not the raw selection.
  s = reduce(s, fleet([{ ...fanout, backgroundTasks: [], subagents: [] }]));
  assert.equal(focusedChildOf(s), null);
  assert.equal(logRowCount(s, 60), full, "un-narrowed pane measures the full log again");

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
// fleet search (`/`) — matching, ranking, exclusions
// ---------------------------------------------------------------------------

// The search engine reads a `FleetView`, not the whole UI state — hand it
// exactly that rather than a TuiState that happens to satisfy it structurally.
const searchState = (sessions: SessionSnapshot[], log: LogLine[] = []): FleetView => ({
  sessions,
  log,
});

test("fleet search: a 'term is a literal substring, case-insensitive", () => {
  const s = searchState([
    snap({ id: "lit", title: "say Hello there" }),
    snap({ id: "spread", title: "spelling h-e-l-l-o out" }),
  ]);
  assert.deepEqual(
    searchSessions(s, "'hello").map((m) => m.session.id),
    ["lit"],
  );
});

test("fleet search: bare terms match fuzzily; space-separated terms are AND'd", () => {
  const both = snap({ id: "both", title: "mobile access rollout" });
  const onlyMobile = snap({ id: "m", title: "mobile layout" });
  const onlyAccess = snap({ id: "a", title: "database access" });
  const s = searchState([onlyMobile, onlyAccess, both]);
  assert.deepEqual(
    searchSessions(s, "layout").map((m) => m.session.id),
    ["m"],
  );
  assert.deepEqual(
    searchSessions(s, "mobile access").map((m) => m.session.id),
    ["both"],
  );
});

test("fleet search: title beats your messages beats the agent's", () => {
  const title = snap({ id: "title", title: "mobile rollout" });
  const mine = snap({ id: "mine", title: "chat" });
  const theirs = snap({ id: "theirs", title: "chat" });
  const s = searchState(
    [theirs, mine, title],
    [
      toLogLine(
        1,
        "e1",
        ev({
          type: "user_message",
          text: "start the mobile work",
          injected: false,
          sessionId: "mine",
        }),
      ),
      toLogLine(
        2,
        "e1",
        ev({ type: "assistant_text", text: "the mobile plan is ready", sessionId: "theirs" }),
      ),
    ],
  );
  assert.deepEqual(
    searchSessions(s, "mobile").map((m) => m.session.id),
    ["title", "mine", "theirs"],
  );
});

test("fleet search: tool traffic and thinking are invisible", () => {
  const x = snap({ id: "x", title: "unrelated" });
  const s = searchState(
    [x],
    [
      toLogLine(
        1,
        "e1",
        ev({
          type: "tool_call",
          id: "c1",
          name: "Bash",
          input: { command: "grep mobile *" },
          sessionId: "x",
        }),
      ),
      toLogLine(
        2,
        "e1",
        ev({ type: "tool_result", id: "c1", ok: true, output: { text: "mobile" }, sessionId: "x" }),
      ),
      toLogLine(3, "e1", ev({ type: "thinking", text: "they said mobile, so…", sessionId: "x" })),
    ],
  );
  assert.deepEqual(searchSessions(s, "mobile"), []);
});

test("fleet search: message bodies beyond the one-line summary are searched", () => {
  const long = `${"filler ".repeat(60)}zebra migration`;
  const a = snap({ id: "a", title: "chat" });
  const s = searchState(
    [a],
    [toLogLine(1, "e1", ev({ type: "user_message", text: long, injected: false, sessionId: "a" }))],
  );
  const line = s.log[0]!;
  assert.ok(
    (line.full?.length ?? 0) > line.text.length,
    "fixture: the log line's summary is truncated",
  );
  assert.deepEqual(
    searchSessions(s, "'zebra migration").map((m) => m.session.id),
    ["a"],
  );
});

test("fleet search: equal scores keep the fleet's order (newest first)", () => {
  const older = snap({ id: "older", title: "zebra run", updatedAt: 10 });
  const newer = snap({ id: "newer", title: "zebra run", updatedAt: 99 });
  const s = reduce(initialState(), fleet([older, newer]));
  assert.deepEqual(
    searchSessions({ sessions: fleetSessions(s), log: s.log }, "'zebra").map((m) => m.session.id),
    ["newer", "older"],
  );
});

test("fleet search: an empty query lists every session, unranked", () => {
  const a = snap({ id: "a", title: "x" });
  const b = snap({ id: "b", title: "y" });
  const s = searchState([a, b]);
  assert.deepEqual(
    searchSessions(s, "").map((m) => m.session.id),
    ["a", "b"],
  );
  assert.deepEqual(
    searchSessions(s, "   ").map((m) => m.session.id),
    ["a", "b"],
  );
});

test("fleet search: findSet rides onto the best-ranked match; ↑↓ walk it", () => {
  // The fleet head ("head", newest) doesn't match at all; of the matches, the
  // title hit outranks the message-only hit.
  const weak = snap({ id: "weak", title: "another chat" });
  const best = snap({ id: "best", title: "mobile access" });
  const head = snap({ id: "head", title: "unrelated chatter" });
  let s = reduce(initialState(), fleet([weak, best, head]));
  s = reduce(s, {
    t: "push",
    frame: push(
      1,
      ev({ type: "user_message", text: "mobile thoughts", injected: false, sessionId: "weak" }),
    ),
  });
  s = reduce(s, { t: "openFind" });
  s = reduce(s, { t: "findSet", buffer: buffer("mobile") });
  assert.equal(s.selectedId, "best", "rode onto the title match");
  s = reduce(s, { t: "move", delta: 1 });
  assert.equal(s.selectedId, "weak", "↓ walks down the ranked list");
  s = reduce(s, { t: "move", delta: -1 });
  assert.equal(s.selectedId, "best");
});
