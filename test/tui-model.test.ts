import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessEvent } from "../src/protocol/events.ts";
import type { SessionSnapshot } from "../src/protocol/wire.ts";
import type { EventPush } from "../src/protocol/wire.ts";
import {
  actionsFor,
  allowedActs,
  cacheHeat,
  cacheStatus,
  defaultProviderId,
  findPickItems,
  formatEvent,
  groupsOf,
  initialState,
  makePicker,
  makePrompt,
  modelPickItems,
  pendingFor,
  pickerCurrent,
  pickerVisible,
  providerColorOf,
  providerPickItems,
  queueFor,
  reduce,
  selectedSession,
  sortSessions,
  visibleLog,
  type TuiState,
} from "../src/tui/model.ts";
import { buffer } from "../src/tui/editor.ts";
import { bar, humanTokens, money, spinnerFrame, truncate, wrapText } from "../src/tui/theme.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let clock = 1_000;

function snap(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  const now = ++clock;
  return {
    id: over.id ?? `s${now}`,
    parentId: null,
    provider: "fake",
    model: null,
    mode: "default",
    status: "idle",
    awaitReason: null,
    title: "a task",
    worktree: null,
    branch: null,
    baseBranch: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextUsed: 0,
    contextLimit: 0,
    costUsd: 0,
    costSource: "none",
    turns: 0,
    budget: { maxTokens: null, maxCostUsd: null, maxTurns: null },
    budgetState: "ok",
    subagents: [],
    cache: { ttlMinutes: 0, lastTurnAt: 0, lastRead: 0, lastWrite: 0 },
    git: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function ev(over: Partial<HarnessEvent> & { type: HarnessEvent["type"] }): HarnessEvent {
  return { sessionId: "s1", ts: 5_000, ...(over as object) } as HarnessEvent;
}

function push(seq: number, event: HarnessEvent): EventPush {
  return { kind: "push", seq, type: "event", event };
}

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

test("move clamps at both ends of the sorted list", () => {
  const list = [snap({ id: "a", status: "awaiting_input" }), snap({ id: "b", status: "running" }), snap({ id: "c", status: "idle" })];
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
    frame: { kind: "push", seq: 1, type: "session_updated", session: snap({ id: "a", status: "idle", updatedAt: 9 }), version: 2 },
  });
  assert.deepEqual(s.sessions.map((x) => x.id), ["b", "a"]);
  assert.equal(s.selectedId, "a");
});

test("session_removed drops the row and reselects the head", () => {
  const a = snap({ id: "a", status: "awaiting_input" });
  const b = snap({ id: "b", status: "running" });
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [a, b] });
  s = reduce(s, { t: "select", id: "b" });
  s = reduce(s, { t: "push", frame: { kind: "push", seq: 1, type: "session_removed", sessionId: "b" } });
  assert.deepEqual(s.sessions.map((x) => x.id), ["a"]);
  assert.equal(s.selectedId, "a");
});

// ---------------------------------------------------------------------------
// event log
// ---------------------------------------------------------------------------

test("event pushes append log lines and the ring honours logCap", () => {
  let s = initialState(3);
  for (let i = 0; i < 5; i++) {
    s = reduce(s, { t: "push", frame: push(i, ev({ type: "assistant_text", text: `line ${i}`, sessionId: "s1" })) });
  }
  assert.equal(s.log.length, 3);
  assert.deepEqual(s.log.map((l) => l.seq), [2, 3, 4]);
});

test("permission / question / fatal-error events raise a notice", () => {
  let s = initialState();
  s = reduce(s, { t: "push", frame: push(1, ev({ type: "permission_request", id: "p1", tool: "Bash", input: {} })) });
  assert.match(s.notice?.text ?? "", /Bash needs approval/);
  assert.equal(s.notice?.tone, "accent");

  s = reduce(s, { t: "push", frame: push(2, ev({ type: "question", id: "q1", question: "which db?" })) });
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

test("visibleLog respects the selected/all filter", () => {
  const a = snap({ id: "a", status: "running" });
  const b = snap({ id: "b", status: "running" });
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [a, b] });
  s = reduce(s, { t: "select", id: "a" });
  s = reduce(s, { t: "push", frame: push(1, ev({ type: "assistant_text", text: "for a", sessionId: "a" })) });
  s = reduce(s, { t: "push", frame: push(2, ev({ type: "assistant_text", text: "for b", sessionId: "b" })) });
  assert.deepEqual(visibleLog(s).map((l) => l.text), ["for a"]);
  s = reduce(s, { t: "logFilter", value: "all" });
  assert.deepEqual(visibleLog(s).map((l) => l.text), ["for a", "for b"]);
});

// ---------------------------------------------------------------------------
// pending round-trips
// ---------------------------------------------------------------------------

test("pending permission is recorded on request and cleared when the session runs again", () => {
  const a = snap({ id: "a", status: "awaiting_input", awaitReason: "permission" });
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [a] });
  s = reduce(s, { t: "push", frame: push(1, ev({ type: "permission_request", id: "p1", tool: "Write", input: {}, sessionId: "a" })) });
  assert.equal(pendingFor(s, "a").permission, "p1");
  s = reduce(s, {
    t: "push",
    frame: { kind: "push", seq: 2, type: "session_updated", session: snap({ id: "a", status: "running" }), version: 3 },
  });
  assert.equal(pendingFor(s, "a").permission, undefined);
});

test("pending question is cleared by the matching answer event", () => {
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [snap({ id: "a", status: "awaiting_input", awaitReason: "question" })] });
  s = reduce(s, { t: "push", frame: push(1, ev({ type: "question", id: "q1", question: "?", sessionId: "a" })) });
  assert.equal(pendingFor(s, "a").question, "q1");
  s = reduce(s, { t: "push", frame: push(2, ev({ type: "answer", id: "q1", text: "sqlite", sessionId: "a" })) });
  assert.equal(pendingFor(s, "a").question, undefined);
});

test("a plan_review stashes the plan text; openPlan / closePlan drive the overlay", () => {
  const a = snap({ id: "a", status: "awaiting_input", awaitReason: "plan_review" });
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [a] });
  s = reduce(s, { t: "push", frame: push(1, ev({ type: "plan_review", id: "pr1", plan: "step one\nstep two", sessionId: "a" })) });
  assert.equal(pendingFor(s, "a").plan, "pr1");
  assert.equal(pendingFor(s, "a").planText, "step one\nstep two");

  s = reduce(s, { t: "openPlan", sessionId: "a", requestId: "pr1", text: "step one\nstep two" });
  assert.equal(s.mode, "plan");
  assert.equal(s.plan?.requestId, "pr1");

  // the session moving on closes the overlay and clears pending
  s = reduce(s, {
    t: "push",
    frame: { kind: "push", seq: 2, type: "session_updated", session: snap({ id: "a", status: "running" }), version: 3 },
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
  // every selected session also gets mode + model + title + budget, plus globals
  const S = ["mode", "model", "title", "budget", "find", "help", "new", "quit"];

  assert.deepEqual(
    [...acts({ status: "awaiting_input", awaitReason: "permission" })].sort(),
    ["approve", "deny", "interrupt", ...S].sort(),
  );
  assert.deepEqual(
    [...acts({ status: "awaiting_input", awaitReason: "question" })].sort(),
    ["answer", "interrupt", ...S].sort(),
  );
  assert.deepEqual(
    [...acts({ status: "awaiting_input", awaitReason: "plan_review" })].sort(),
    ["planreview", "interrupt", ...S].sort(),
  );
  assert.deepEqual([...acts({ status: "running" })].sort(), ["interrupt", "send", ...S].sort());
  assert.deepEqual([...acts({ status: "idle" })].sort(), ["send", "done", ...S].sort());
  assert.deepEqual([...acts({ status: "interrupted" })].sort(), ["resume", "done", ...S].sort());
  assert.deepEqual([...acts({ status: "error" })].sort(), ["resume", "done", ...S].sort());
  assert.deepEqual([...allowedActs(null)].sort(), ["find", "help", "new", "quit"].sort());
});

test("actionsFor keeps the salient action first", () => {
  const first = actionsFor(snap({ status: "awaiting_input", awaitReason: "permission" }))[0];
  assert.equal(first?.act, "approve");
});

test("cacheStatus: unknown without a pinned TTL or a turn", () => {
  assert.equal(cacheStatus(null, 1000).state, "unknown");
  assert.equal(cacheStatus(snap({ cache: { ttlMinutes: 0, lastTurnAt: 5000, lastRead: 9, lastWrite: 0 } }), 6000).state, "unknown");
  assert.equal(cacheStatus(snap({ cache: { ttlMinutes: 60, lastTurnAt: 0, lastRead: 0, lastWrite: 0 } }), 6000).state, "unknown");
});

test("cacheStatus: warm counts down from lastTurnAt + ttl, then goes cold", () => {
  const c = snap({ cache: { ttlMinutes: 5, lastTurnAt: 1_000_000, lastRead: 8000, lastWrite: 300 } });
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
    cacheStatus(snap({ cache: { ttlMinutes: 60, lastTurnAt: 1000, lastRead, lastWrite } }), 2000).lastHit;
  assert.equal(mk(9000, 200), "hit"); // big read → continuation
  assert.equal(mk(0, 9000), "rewrote"); // all write → prefix was cold
  assert.equal(mk(0, 0), null);
});

test("cacheHeat bands the remaining fraction; null when not warm", () => {
  const T0 = 1_000_000;
  // ttl 60m; sample at minute offsets from the last turn
  const at = (min: number) =>
    cacheHeat(
      cacheStatus(snap({ cache: { ttlMinutes: 60, lastTurnAt: T0, lastRead: 9, lastWrite: 1 } }), T0 + min * 60_000),
    );
  assert.equal(at(0), "fresh"); // 100% left
  assert.equal(at(30), "fresh"); // 50% left (> 33%)
  assert.equal(at(45), "fading"); // 25% left
  assert.equal(at(58), "expiring"); // ~3% left
  assert.equal(at(61), null); // cold
  assert.equal(
    cacheHeat(cacheStatus(snap({ cache: { ttlMinutes: 0, lastTurnAt: T0, lastRead: 0, lastWrite: 0 } }), T0)),
    null, // unknown (no pinned TTL)
  );
});

test("compact only appears once the context meter passes half", () => {
  assert.ok(!allowedActs(snap({ status: "idle", contextUsed: 40, contextLimit: 100 })).has("compact"));
  assert.ok(allowedActs(snap({ status: "idle", contextUsed: 60, contextLimit: 100 })).has("compact"));
  assert.ok(allowedActs(snap({ status: "running", contextUsed: 90, contextLimit: 100 })).has("compact"));
  // not offered for a session with no live adapter
  assert.ok(!allowedActs(snap({ status: "interrupted", contextUsed: 90, contextLimit: 100 })).has("compact"));
});

test("groupsOf only emits non-empty groups, in fleet-view order", () => {
  const g = groupsOf([snap({ status: "idle" }), snap({ status: "awaiting_input" }), snap({ status: "idle" })]);
  assert.deepEqual(g.map((x) => x.status), ["awaiting_input", "idle"]);
  assert.deepEqual(g.map((x) => x.sessions.length), [1, 2]);
});

// ---------------------------------------------------------------------------
// event formatting
// ---------------------------------------------------------------------------

test("formatEvent renders each event kind to a glyph + one-liner + tone", () => {
  assert.deepEqual(formatEvent(ev({ type: "tool_call", id: "1", name: "Bash", input: { command: "npm test" } })), {
    glyph: "⚙",
    text: "Bash  npm test",
    tone: "warn",
  });
  const okr = formatEvent(ev({ type: "tool_result", id: "1", ok: true, output: {} }));
  assert.equal(okr.tone, "good");
  assert.equal(okr.text, "ok");
  const badr = formatEvent(ev({ type: "tool_result", id: "1", ok: false, output: { text: "nope" } }));
  assert.equal(badr.tone, "bad");
  assert.match(formatEvent(ev({ type: "question", id: "q1", question: "which one?" })).text, /req q1/);
  assert.match(
    formatEvent(ev({ type: "usage", tokens: { input: 1200, output: 30, cacheRead: 0, cacheWrite: 0 }, contextUsed: 1200, contextLimit: 200000 })).text,
    /ctx 1\.2k\/200\.0k/,
  );
  assert.match(formatEvent(ev({ type: "plan_review", id: "pr9", plan: "x" })).text, /plan ready.*req pr9/);
  const comp = formatEvent(ev({ type: "compact", trigger: "manual", before: 120000, after: 24000 }));
  assert.equal(comp.glyph, "⇊");
  assert.match(comp.text, /120\.0k → 24\.0k/);
  // `after` unknown until the next turn — no arrow
  assert.doesNotMatch(formatEvent(ev({ type: "compact", trigger: "auto", before: 120000, after: 0 })).text, /→/);
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

test("promptCycleMode only cycles for a `new` prompt", () => {
  let s = reduce(initialState(), {
    t: "openPrompt",
    prompt: makePrompt({ kind: "new", sessionId: null, label: "new" }),
  });
  assert.equal(s.prompt?.mode, undefined, "a fresh new-prompt carries no mode — it just uses the default");
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

  s = reduce(s, { t: "openPrompt", prompt: makePrompt({ kind: "send", sessionId: "a", label: "send", text: "live" }) });
  s = reduce(s, { t: "promptHistoryNav", dir: -1 });
  assert.equal(s.prompt?.buffer.text, "three");
  s = reduce(s, { t: "promptHistoryNav", dir: -1 });
  assert.equal(s.prompt?.buffer.text, "one");
  s = reduce(s, { t: "promptHistoryNav", dir: 1 });
  s = reduce(s, { t: "promptHistoryNav", dir: 1 });
  assert.equal(s.prompt?.buffer.text, "live", "returns to the stashed live draft at index 0");
});

test("echo appends a local log line that respects the cap", () => {
  let s = initialState(2);
  s = reduce(s, { t: "echo", line: { seq: -1, sessionId: "a", glyph: "›", text: "hi", tone: "accent", ts: 1 } });
  s = reduce(s, { t: "echo", line: { seq: -2, sessionId: "a", glyph: "›", text: "there", tone: "accent", ts: 2 } });
  s = reduce(s, { t: "echo", line: { seq: -3, sessionId: "a", glyph: "›", text: "again", tone: "accent", ts: 3 } });
  assert.deepEqual(s.log.map((l) => l.text), ["there", "again"]);
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

test("openSendChoice replaces the prompt; closeSendChoice returns to browse", () => {
  let s = reduce(initialState(), {
    t: "openPrompt",
    prompt: makePrompt({ kind: "send", sessionId: "a", label: "send", text: "hi" }),
  });
  s = reduce(s, { t: "openSendChoice", sessionId: "a", text: "hi" });
  assert.equal(s.mode, "sendChoice");
  assert.equal(s.prompt, null);
  assert.deepEqual(s.sendChoice, { sessionId: "a", text: "hi" });
  s = reduce(s, { t: "closeSendChoice" });
  assert.equal(s.mode, "browse");
  assert.equal(s.sendChoice, null);
});

test("a permission_request stashes the tool + input; answer/leaving clears it", () => {
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [snap({ id: "a", status: "awaiting_input" })] });
  s = reduce(s, {
    t: "push",
    frame: push(1, ev({ type: "permission_request", id: "p1", tool: "Bash", input: { command: "rm -rf x" }, sessionId: "a" })),
  });
  const pf = pendingFor(s, "a");
  assert.equal(pf.permission, "p1");
  assert.equal(pf.permTool, "Bash");
  assert.deepEqual(pf.permInput, { command: "rm -rf x" });
  s = reduce(s, {
    t: "push",
    frame: { kind: "push", seq: 2, type: "session_updated", session: snap({ id: "a", status: "running" }), version: 2 },
  });
  assert.deepEqual(pendingFor(s, "a"), {});
});

test("queue entries are pruned when their session disappears", () => {
  let s = reduce(initialState(), { t: "hello", daemon, sessions: [snap({ id: "a", status: "running" })] });
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

test("status_changed events stay out of the log; result is a terse marker", () => {
  let s = initialState();
  s = reduce(s, { t: "push", frame: push(1, ev({ type: "assistant_text", text: "here is the answer" })) });
  s = reduce(s, { t: "push", frame: push(2, ev({ type: "status_changed", status: "idle", reason: "result" })) });
  s = reduce(s, { t: "push", frame: push(3, ev({ type: "result", ok: true, summary: "here is the answer" })) });
  assert.deepEqual(
    s.log.map((l) => l.glyph),
    ["▪", "■"],
    "no ◈ status line; result kept but terse",
  );
  assert.equal(s.log.at(-1)?.text, "turn complete");
});

test("selectedSession returns the highlighted row or null", () => {
  assert.equal(selectedSession(initialState()), null);
  const s = reduce(initialState(), { t: "hello", daemon, sessions: [snap({ id: "z", status: "running" })] });
  assert.equal(selectedSession(s)?.id, "z");
});

// ---------------------------------------------------------------------------
// picker: provider / model / find
// ---------------------------------------------------------------------------

const PROVIDERS = [
  { id: "claude", models: [], tag: "claude", color: "", isDefault: true },
  { id: "openai", models: ["gpt-5", "gpt-5-mini", "o4"], tag: "oai", color: "cyan", isDefault: false },
  { id: "deepseek", models: ["deepseek-chat", "deepseek-reasoner"], tag: "ds", color: "magenta", isDefault: false },
];

function withProviders(): TuiState {
  return reduce(initialState(), { t: "providers", list: PROVIDERS });
}

test("providers action populates state and the derived helpers", () => {
  const s = withProviders();
  assert.equal(defaultProviderId(s), "claude");
  assert.equal(providerColorOf(s, "openai"), "cyan");
  assert.equal(providerColorOf(s, "claude"), "");
  assert.deepEqual(modelPickItems(s, "deepseek").map((i) => i.id), ["deepseek-chat", "deepseek-reasoner"]);
  assert.equal(providerPickItems(s).length, 3);
});

test("picker: open, filter narrows the list, move clamps to the filtered set", () => {
  let s = reduce(withProviders(), {
    t: "openPicker",
    picker: makePicker({ kind: "model", title: "model", items: modelPickItems(withProviders(), "openai") }),
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
    frame: { type: "event", seq: 1, event: { type: "assistant_text", sessionId: "bbb", ts: 1, text: "refactor the parser module" } },
  } as never);

  const items = findPickItems(s);
  const bbb = items.find((i) => i.id === "bbb")!;
  assert.match(bbb.blob ?? "", /refactor the parser/);

  const picker = makePicker({ kind: "find", title: "find", items });
  const filtered = pickerVisible({ ...picker, filter: "parser" });
  assert.deepEqual(filtered.map((i) => i.id), ["bbb"]);
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
  s = reduce(s, { t: "push", frame: { type: "session_removed", seq: 2, sessionId: "live" } } as never);
  assert.equal(s.picker, null);
  assert.equal(s.mode, "browse");
});

test("makePrompt carries provider + model for the N flow", () => {
  const p = makePrompt({ kind: "new", sessionId: null, label: "new", provider: "openai", model: "o4" });
  assert.equal(p.provider, "openai");
  assert.equal(p.model, "o4");
});

// keep a reference to TuiState so the import is load-bearing for type checks
const _typecheck: TuiState = initialState();
void _typecheck;
