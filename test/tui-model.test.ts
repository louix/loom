import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessEvent } from "@loom/core/events";
import type { ProviderInfo, SessionSnapshot } from "@loom/core/wire";
import type { EventPush } from "@loom/core/wire";
import {
  actionsFor,
  allowedActs,
  commandsFor,
  cacheHeat,
  cacheStatus,
  defaultModeOf,
  defaultModelOf,
  defaultProviderId,
  effortPickItems,
  escapeTarget,
  findPickItems,
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
import { buffer } from "@loom/tui/editor";
import {
  bar,
  humanTokens,
  money,
  setThemeMode,
  spinnerFrame,
  statusLook,
  toneColor,
  truncate,
  wrapText,
} from "@loom/tui/theme";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let clock = 1_000;

const snap = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => {
  const now = ++clock;
  return {
    id: over.id ?? `s${now}`,
    parentId: null,
    forkTurn: null,
    provider: "fake",
    model: null,
    effort: null,
    mode: "default",
    status: "idle",
    awaitReason: null,
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
    rateLimits: {},
    cache: { ttlMinutes: 0, lastTurnAt: 0, lastRead: 0, lastWrite: 0 },
    git: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
};

const ev = (over: Partial<HarnessEvent> & { type: HarnessEvent["type"] }): HarnessEvent => {
  return { sessionId: "s1", ts: 5_000, ...(over as object) } as HarnessEvent;
};

const push = (seq: number, event: HarnessEvent): EventPush => {
  return { kind: "push", seq, type: "event", event };
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
    { type: "tool_call", id: "t2", name: "Bash", input: { command: "ls", description: "List files" } },
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
    toLogLine(6, { ...ev({ type: "result", ok: true }), ts: 9000 }),
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

// ---------------------------------------------------------------------------
// contextual actions
// ---------------------------------------------------------------------------

test("actionsFor offers the right verbs per session state, plus the globals", () => {
  const acts = (o: Partial<SessionSnapshot>) => allowedActs(snap(o));
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
  assert.equal(toLogLine(1, ev({ type: "assistant_text", text: "hi" })).full, undefined);
  assert.equal(toLogLine(2, ev({ type: "assistant_text", text: long })).full, long);
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

test("connection action drives the header lamp state", () => {
  let s = reduce(initialState(), { t: "connection", value: "reconnecting" });
  assert.equal(s.connection, "reconnecting");
  s = reduce(s, { t: "connection", value: "live" });
  assert.equal(s.connection, "live");
});

test("toggleTheme flips dark ↔ light, defaulting to dark", () => {
  let s = initialState();
  assert.equal(s.theme, "dark");
  s = reduce(s, { t: "toggleTheme" });
  assert.equal(s.theme, "light");
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

test("status_changed events stay out of the log; result is a terse marker", () => {
  let s = initialState();
  s = reduce(s, {
    t: "push",
    frame: push(1, ev({ type: "assistant_text", text: "here is the answer" })),
  });
  s = reduce(s, {
    t: "push",
    frame: push(2, ev({ type: "status_changed", status: "idle", reason: "result" })),
  });
  s = reduce(s, {
    t: "push",
    frame: push(3, ev({ type: "result", ok: true, summary: "here is the answer" })),
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

// keep a reference to TuiState so the import is load-bearing for type checks
const _typecheck: TuiState = initialState();
void _typecheck;
