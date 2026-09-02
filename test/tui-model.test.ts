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
import type { ProviderInfo, SessionSnapshot } from "@loom/core/wire";
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
  findPickItems,
  focusedChildOf,
  focusedPending,
  footerHints,
  formatEvent,
  groupsOf,
  initialState,
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
  reduce,
  selectedSession,
  sessionLog,
  sortSessions,
  toLogLine,
  transcriptText,
  visibleLog,
  type LogLine,
  type TuiState,
} from "@loom/tui/model";
import { detailRows, promptRows } from "@loom/tui/components";
import { buffer } from "@loom/tui/editor";
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
    subagents: [],
    backgroundTasks: [],
    rateLimits: {},
    cache: { ttlMinutes: 0, lastTurnAt: 0, lastRead: 0, lastWrite: 0 },
    keepWarm: false,
    canRewind: true,
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

const daemon = { pid: 1, version: "0.0.1", repoRoot: "/tmp/demo" };

// ---------------------------------------------------------------------------
// hello / selection / ordering
// ---------------------------------------------------------------------------

test("hello seeds the daemon, sorts sessions, and selects the first", () => {
  const a = snap({ id: "a", status: "idle" });
  const b = snap({ id: "b", status: "running" });
  const s = reduce(initialState(), { t: "hello", daemon, sessions: [a, b] });
  assert.equal(s.connection, "live");
  assert.deepEqual(s.daemon, daemon);
  assert.deepEqual(
    s.sessions.map((x) => x.id),
    ["b", "a"], // running sorts ahead of idle
  );
  assert.equal(s.selectedId, "b");
});

test("hello keeps the current selection when that session is still present", () => {
  const a = snap({ id: "a", status: "running" });
  const b = snap({ id: "b", status: "running" });
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [a, b] });
  s = reduce(s, { t: "select", id: "b" });
  s = reduce(s, { t: "hello", daemon, sessions: [b, a] });
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

test("an optimistic select survives an unrelated session_updated until its row arrives (U4)", () => {
  let s = reduce(initialState(), {
    t: "hello",
    daemon,
    sessions: [snap({ id: "a", status: "running" }), snap({ id: "b", status: "idle" })],
  });
  // User creates session "new1"; its row hasn't landed yet.
  s = reduce(s, { t: "select", id: "new1" });
  assert.equal(s.selectedId, "new1");
  assert.equal(s.pendingSelectId, "new1");

  // An unrelated session ticks out a session_updated.
  s = reduce(s, {
    t: "push",
    frame: {
      kind: "push",
      seq: 1,
      type: "session_updated",
      session: snap({ id: "a", status: "idle" }),
      version: 2,
    },
  });
  assert.equal(s.selectedId, "new1", "not bounced to the fleet head");

  // "new1" finally arrives — the hold is released.
  s = reduce(s, {
    t: "push",
    frame: {
      kind: "push",
      seq: 2,
      type: "session_updated",
      session: snap({ id: "new1", status: "starting" }),
      version: 1,
    },
  });
  assert.equal(s.selectedId, "new1");
  assert.equal(s.pendingSelectId, undefined);

  // A later unrelated update with "new1" gone from a stale list won't drop it now
  // that it's real, and if "new1" is removed the hold is not resurrected.
  s = reduce(s, {
    t: "push",
    frame: { kind: "push", seq: 3, type: "session_removed", sessionId: "new1" },
  });
  assert.notEqual(s.selectedId, "new1");
  assert.equal(s.pendingSelectId, undefined);
});

test("move clamps at both ends of the sorted list", () => {
  const list = [
    snap({ id: "a", status: "awaiting_input" }),
    snap({ id: "b", status: "running" }),
    snap({ id: "c", status: "idle" }),
  ];
  let s = reduce(initialState(), { t: "hello", daemon, sessions: list });
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
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [fanout] });
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
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [fanout] });
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
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [snap({ id: "a" })] });
  s = reduce(s, { t: "childEnter" });
  assert.equal(s.selectedChild, null);
});

test("a drained child snaps to a survivor; an emptied list exits focus", () => {
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [fanout] });
  s = reduce(s, { t: "childEnter" });
  s = reduce(s, { t: "childMove", delta: 1 }); // → bg:task2
  // Membership churn: the background tasks drained → snap to the first survivor.
  s = reduce(s, {
    t: "sessions",
    sessions: [{ ...fanout, backgroundTasks: [] }],
  });
  assert.equal(s.selectedChild, "sub:t1");
  // Everything drains → the drill-down exits rather than pointing at nothing.
  s = reduce(s, {
    t: "sessions",
    sessions: [{ ...fanout, backgroundTasks: [], subagents: [] }],
  });
  assert.equal(s.selectedChild, null);
});

test("changing the session selection clears the child focus", () => {
  const other = snap({ id: "other", status: "idle" });
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [fanout, other] });
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

test("visibleLog narrows to the focused child's agentId-tagged events", () => {
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [fanout] });
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
  assert.equal(visibleLog(s).length, 3);
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
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [fanout] });
  const keys = (st: TuiState) => footerHints(st).map((h) => h.keys);
  assert.ok(keys(s).includes("→"), "sessions with live children offer →");
  s = reduce(s, { t: "childEnter" });
  assert.equal(keys(s)[0], "←", "← leads while drilled in");
  assert.ok(!keys(s).includes("→"), "→ is redundant once focused");
  const bare = reduce(initialState(), { t: "hello", daemon, sessions: [snap({ id: "a" })] });
  assert.ok(!keys(bare).includes("→"), "childless sessions don't offer the drill-down");
});

test("session_updated upserts, re-sorts, and preserves selection", () => {
  const a = snap({ id: "a", status: "running", updatedAt: 1 });
  const b = snap({ id: "b", status: "running", updatedAt: 2 });
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [a, b] });
  s = reduce(s, { t: "select", id: "a" });
  // a finishes its turn — should drop below b (idle group) but stay selected
  s = reduce(s, {
    t: "push",
    frame: {
      kind: "push",
      seq: 1,
      type: "session_updated",
      session: snap({ id: "a", status: "idle", updatedAt: 9 }),
      version: 2,
    },
  });
  assert.deepEqual(
    s.sessions.map((x) => x.id),
    ["b", "a"],
  );
  assert.equal(s.selectedId, "a");
});

test("session_removed drops the row and reselects the head", () => {
  const a = snap({ id: "a", status: "awaiting_input" });
  const b = snap({ id: "b", status: "running" });
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [a, b] });
  s = reduce(s, { t: "select", id: "b" });
  s = reduce(s, {
    t: "push",
    frame: { kind: "push", seq: 1, type: "session_removed", sessionId: "b" },
  });
  assert.deepEqual(
    s.sessions.map((x) => x.id),
    ["a"],
  );
  assert.equal(s.selectedId, "a");
});

test("providers_updated adopts the pushed list as the new-session defaults", () => {
  let s = withProviders();
  // The daemon remembered a different last-used provider / model — the push
  // replaces the connect-time snapshot wholesale.
  const fresh: ProviderInfo[] = [
    { ...PROVIDERS[1]!, isDefault: true, defaultModel: "gpt-5-mini" },
    { ...PROVIDERS[0]!, isDefault: false },
  ];
  s = reduce(s, {
    t: "push",
    frame: { kind: "push", seq: 2, type: "providers_updated", providers: fresh },
  });
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
  let s = initialState();
  for (let i = 0; i < 10_050; i++) {
    s = reduce(s, {
      t: "push",
      frame: push(i, ev({ type: "assistant_text", text: `line ${i}`, sessionId: "s1" })),
    });
  }
  assert.equal(s.log.length, 10_000);
  assert.equal(s.log[0]?.seq, 50, "oldest 50 lines were trimmed");
  assert.equal(s.log.at(-1)?.seq, 10_049, "newest line retained");
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

test("a sessions/hello snapshot drops pending for a session it says is no longer blocked (U2)", () => {
  const blocked = snap({ id: "a", status: "awaiting_input", awaitReason: "permission" });
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [blocked] });
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
  s = reduce(s, { t: "sessions", sessions: [snap({ id: "a", status: "idle" })] });
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
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [a, b] });
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
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [a] });
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
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [a] });
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
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [a] });
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
  s = reduce(s, {
    t: "push",
    frame: {
      kind: "push",
      seq: 5,
      type: "session_updated",
      session: snap({ id: "a", status: "running" }),
      version: 3,
    },
  });
  assert.equal(firstPerm(pendingFor(s, "a")), undefined);
});

test("a permission's matching tool_result clears it, even mid-replay with the session still awaiting_input", () => {
  // Reconnect/history-replay: the daemon has long since resolved p1 (no
  // dedicated event marks that — only the `tool_result` does, per the
  // daemon's own `#trackPerms`), but the session is genuinely awaiting_input
  // again for p2. Without tracking `tool_result`, p1 would sit in
  // `permissions` forever and `firstPerm` would keep surfacing it instead of
  // the real, current request.
  const a = snap({ id: "a", status: "awaiting_input", awaitReason: "permission" });
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [a] });
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
  let s = reduce(initialState(), {
    t: "hello",
    daemon,
    sessions: [snap({ id: "a", status: "awaiting_input", awaitReason: "question" })],
  });
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
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [a] });
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
  s = reduce(s, {
    t: "push",
    frame: {
      kind: "push",
      seq: 2,
      type: "session_updated",
      session: snap({ id: "a", status: "running" }),
      version: 3,
    },
  });
  assert.equal(s.plan, null);
  assert.equal(s.mode, "browse");
  assert.equal(pendingFor(s, "a").plan, undefined);
});

test("a plan is cleared by its matching tool_result once the decision lands", () => {
  // The plan_review is keyed on the ExitPlanMode / exit_plan tool-call id, so
  // its `tool_result` is the only durable mark that the plan was decided —
  // the daemon clears its own map in `respondToPlan`, but that never reaches
  // the event log a client backfills from.
  let s = reduce(initialState(), {
    t: "hello",
    daemon,
    sessions: [snap({ id: "a", status: "awaiting_input", awaitReason: "plan_review" })],
  });
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
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [a] });
  s = reduce(s, {
    t: "push",
    frame: push(1, ev({ type: "plan_review", id: "pr1", plan: "old plan", sessionId: "a" })),
  });
  s = reduce(s, {
    t: "push",
    frame: {
      kind: "push",
      seq: 2,
      type: "session_updated",
      session: snap({ id: "a", status: "running" }),
      version: 3,
    },
  });
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
  // a settled selected session also gets mode + model + effort + title + delete
  const S = ["mode", "model", "effort", "fork", "title", "delete", ...G];

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
  assert.deepEqual([...acts({ status: "running" })].sort(), ["interrupt", "send", ...S].sort());
  assert.deepEqual([...acts({ status: "idle" })].sort(), ["send", "done", ...S].sort());
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
    sessions: [snap({ id: "s1", status: "idle" })],
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
    sessions: [snap({ id: "s1", status: "idle", provider: "openai", turns: 3 })],
    selectedId: "s1",
  };
  const ids = commandsFor(base).map((c) => c.id);
  // contextual session verbs (idle aisdk session, >1 turn)
  for (const v of ["send", "done", "mode", "model", "undo", "fork", "title", "delete"]) {
    assert.ok(ids.includes(v as any), `missing ${v}`);
  }
  // app / view commands that never earn a footer slot
  for (const v of [
    "viewlog",
    "filter",
    "fullscreen",
    "theme",
    "restart",
    "quitall",
    "new",
    "find",
    "help",
  ]) {
    assert.ok(ids.includes(v as any), `missing ${v}`);
  }
  // no duplicates, and each carries its key as the hint
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(commandsFor(base).find((c) => c.id === "delete")?.hint, "X");
  assert.equal(commandsFor(base).find((c) => c.id === "fork")?.hint, "F");

  // clearqueue only shows when the selected session actually has a queue
  assert.ok(!commandsFor(base).some((c) => c.id === "clearqueue"));
  const withQueue: TuiState = { ...base, queue: { s1: ["pending note"] } };
  assert.ok(commandsFor(withQueue).some((c) => c.id === "clearqueue"));
});

test("cacheStatus: unknown without a pinned TTL or a turn", () => {
  assert.equal(cacheStatus(null, 1000).state, "unknown");
  assert.equal(
    cacheStatus(
      snap({ cache: { ttlMinutes: 0, lastTurnAt: 5000, lastRead: 9, lastWrite: 0 } }),
      6000,
    ).state,
    "unknown",
  );
  assert.equal(
    cacheStatus(snap({ cache: { ttlMinutes: 60, lastTurnAt: 0, lastRead: 0, lastWrite: 0 } }), 6000)
      .state,
    "unknown",
  );
});

test("cacheStatus: warm counts down from lastTurnAt + ttl, then goes cold", () => {
  const c = snap({
    cache: { ttlMinutes: 5, lastTurnAt: 1_000_000, lastRead: 8000, lastWrite: 300 },
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
    cacheStatus(snap({ cache: { ttlMinutes: 60, lastTurnAt: 1000, lastRead, lastWrite } }), 2000)
      .lastHit;
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
        snap({ cache: { ttlMinutes: 60, lastTurnAt: T0, lastRead: 9, lastWrite: 1 } }),
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
        snap({ cache: { ttlMinutes: 0, lastTurnAt: T0, lastRead: 0, lastWrite: 0 } }),
        T0,
      ),
    ),
    null, // unknown (no pinned TTL)
  );
});

test("compact only appears once the context meter passes half", () => {
  assert.ok(
    !allowedActs(snap({ status: "idle", contextUsed: 40, contextLimit: 100 })).has("compact"),
  );
  assert.ok(
    allowedActs(snap({ status: "idle", contextUsed: 60, contextLimit: 100 })).has("compact"),
  );
  assert.ok(
    allowedActs(snap({ status: "running", contextUsed: 90, contextLimit: 100 })).has("compact"),
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
  let s = reduce(initialState(), {
    t: "hello",
    daemon,
    sessions: [snap({ id: "a", status: "awaiting_input" })],
  });
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
  s = reduce(s, {
    t: "push",
    frame: {
      kind: "push",
      seq: 2,
      type: "session_updated",
      session: snap({ id: "a", status: "running" }),
      version: 2,
    },
  });
  assert.deepEqual(pendingFor(s, "a"), {});
});

test("queue entries are pruned when their session disappears", () => {
  let s = reduce(initialState(), {
    t: "hello",
    daemon,
    sessions: [snap({ id: "a", status: "running" })],
  });
  s = reduce(s, { t: "enqueue", sessionId: "a", text: "later" });
  s = reduce(s, { t: "sessions", sessions: [] });
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
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [a] });
  s = reduce(s, { t: "help", value: true });
  assert.equal(s.mode, "help");
  assert.equal(s.selectedId, "a");
  s = reduce(s, { t: "help", value: false });
  assert.equal(s.mode, "browse");
});

test("doctor: open sets the mode, doctorLoaded caches the report, close returns to browse", () => {
  const a = snap({ id: "a", status: "running" });
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [a] });
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
  const s = reduce(initialState(), { t: "hello", daemon, sessions: [] });
  assert.ok(commandsFor(s).some((it) => it.id === "doctor"));
});

test("connection action drives the header lamp state", () => {
  let s = reduce(initialState(), { t: "connection", value: "reconnecting" });
  assert.equal(s.connection, "reconnecting");
  s = reduce(s, { t: "connection", value: "live" });
  assert.equal(s.connection, "live");
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
  const s = reduce(initialState(), {
    t: "hello",
    daemon,
    sessions: [snap({ id: "z", status: "running" })],
  });
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

const withProviders = (): TuiState => {
  return reduce(initialState(), { t: "providers", list: PROVIDERS });
};

test("providers action populates state and the derived helpers", () => {
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
  assert.match(modelPickEmptyText("claude"), /configured model/); // still there if the list is empty
  assert.match(modelPickEmptyText("oai"), /no models detected.*loom models oai/s);
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

  s = reduce(s, { t: "pickerFilter", value: "mini" });
  assert.equal(pickerVisible(s.picker!).length, 1);
  assert.equal(s.picker!.index, 0); // reset on filter
  assert.equal(pickerCurrent(s.picker!)?.id, "gpt-5-mini");

  s = reduce(s, { t: "closePicker" });
  assert.equal(s.mode, "browse");
  assert.equal(s.picker, null);
});

test("find picker items fold message text into the fuzzy blob", () => {
  let s = reduce(withProviders(), {
    t: "hello",
    daemon,
    sessions: [snap({ id: "aaa", status: "running" }), snap({ id: "bbb", status: "idle" })],
  });
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

  const items = findPickItems(s);
  const bbb = items.find((i) => i.id === "bbb")!;
  assert.match(bbb.blob ?? "", /refactor the parser/);

  const picker = makePicker({ kind: "find", title: "find", items });
  const filtered = pickerVisible({ ...picker, filter: "parser" });
  assert.deepEqual(
    filtered.map((i) => i.id),
    ["bbb"],
  );
});

test("a live model picker closes if its session is removed", () => {
  let s = reduce(withProviders(), {
    t: "hello",
    daemon,
    sessions: [snap({ id: "live", status: "running", provider: "openai" })],
  });
  s = reduce(s, {
    t: "openPicker",
    picker: makePicker({
      kind: "model",
      title: "model",
      items: modelPickItems(s, "openai"),
      ctx: { provider: "openai", liveSessionId: "live" },
    }),
  });
  s = reduce(s, {
    t: "push",
    frame: { type: "session_removed", seq: 2, sessionId: "live" },
  } as never);
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
  const s = reduce(initialState(), {
    t: "providers",
    list: PROVIDERS.map((p) => ({ ...p, defaultMode: "acceptEdits" })),
  });
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
    cache: { ttlMinutes: 5, lastTurnAt: Date.now(), lastRead: 2, lastWrite: 1 },
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
  assert.equal(promptRows(initialState()), 2);
  const noted = reduce(initialState(), { t: "notice", text: "sent", tone: "good" });
  assert.equal(promptRows(noted), 3);
  // A prompt's footer never renders the notice — its budget stays 1 + editor + 1.
  const prompted = reduce(noted, {
    t: "openPrompt",
    prompt: makePrompt({ kind: "send", sessionId: "a", label: "send" }),
  });
  assert.equal(promptRows(prompted), 3);
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
    compacting: { startedAt: 9_000, before: 120_000 },
  });
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [mid] });
  assert.deepEqual(s.compacting["a"], { startedAt: 9_000, generated: 0, before: 120_000 });

  // The gate released — a snapshot without the flag clears the entry (the
  // daemon only clears it after the boundary has already been broadcast).
  s = reduce(s, {
    t: "push",
    frame: {
      kind: "push",
      seq: 1,
      type: "session_updated",
      session: snap({ id: "a", status: "idle", updatedAt: 99 }),
      version: 2,
    },
  });
  assert.equal(s.compacting["a"], undefined);
});

test("session_updated seeds the overlay mid-flight and never clobbers live beats", () => {
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [snap({ id: "s1" })] });
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
  s = reduce(s, {
    t: "push",
    frame: {
      kind: "push",
      seq: 2,
      type: "session_updated",
      session: snap({
        id: "s1",
        status: "idle",
        compacting: { startedAt: 1, before: 1 },
        updatedAt: 50,
      }),
      version: 3,
    },
  });
  assert.deepEqual(s.compacting["s1"], { startedAt: 6_000, generated: 128, before: 90_000 });

  // Another session's compaction seeds on its own session_updated without
  // touching the first.
  s = reduce(s, {
    t: "push",
    frame: {
      kind: "push",
      seq: 3,
      type: "session_updated",
      session: snap({
        id: "s2",
        status: "idle",
        compacting: { startedAt: 42_000, before: 77_000 },
        updatedAt: 51,
      }),
      version: 4,
    },
  });
  assert.deepEqual(s.compacting["s2"], { startedAt: 42_000, generated: 0, before: 77_000 });
  assert.deepEqual(s.compacting["s1"], { startedAt: 6_000, generated: 128, before: 90_000 });
});
