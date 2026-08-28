import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessEvent } from "../src/protocol/events.ts";
import type { SessionSnapshot } from "../src/protocol/wire.ts";
import type { EventPush } from "../src/protocol/wire.ts";
import {
  actionsFor,
  allowedActs,
  formatEvent,
  groupsOf,
  initialState,
  makePrompt,
  pendingFor,
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
    turns: 0,
    budget: { maxTokens: null, maxCostUsd: null, maxTurns: null },
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

// ---------------------------------------------------------------------------
// contextual actions
// ---------------------------------------------------------------------------

test("actionsFor offers the right verbs per session state, plus the globals", () => {
  const acts = (o: Partial<SessionSnapshot>) => allowedActs(snap(o));
  const G = ["filter", "help", "new", "quit"];

  assert.deepEqual(
    [...acts({ status: "awaiting_input", awaitReason: "permission" })].sort(),
    ["approve", "deny", "interrupt", "mode", ...G].sort(),
  );
  assert.deepEqual(
    [...acts({ status: "awaiting_input", awaitReason: "question" })].sort(),
    ["answer", "interrupt", "mode", ...G].sort(),
  );
  assert.deepEqual([...acts({ status: "running" })].sort(), ["interrupt", "send", "mode", ...G].sort());
  assert.deepEqual([...acts({ status: "idle" })].sort(), ["send", "done", "mode", ...G].sort());
  assert.deepEqual([...acts({ status: "interrupted" })].sort(), ["resume", "done", "mode", ...G].sort());
  assert.deepEqual([...acts({ status: "error" })].sort(), ["resume", "done", "mode", ...G].sort());
  assert.deepEqual([...allowedActs(null)].sort(), G.sort());
});

test("actionsFor keeps the salient action first", () => {
  const first = actionsFor(snap({ status: "awaiting_input", awaitReason: "permission" }))[0];
  assert.equal(first?.act, "approve");
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

// keep a reference to TuiState so the import is load-bearing for type checks
const _typecheck: TuiState = initialState();
void _typecheck;
