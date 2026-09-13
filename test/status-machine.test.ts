import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveStatus } from "@loom/daemon/daemon/status-machine";
import type { HarnessEvent } from "@loom/core/events";
import {
  type SessionState,
  stateAwaitingInput,
  stateError,
  stateIdle,
  stateInterrupted,
  stateRunning,
  stateStarting,
  stateWorkingBackground,
} from "@loom/core/session-state";

// Distribute over the event union so each kind still requires its own payload.
type EventPayload<E = HarnessEvent> = E extends HarnessEvent ? Omit<E, "sessionId" | "ts"> : never;
const ev = (e: EventPayload): HarnessEvent => ({ sessionId: "s", ts: 0, ...e });

/** `deriveStatus` is total: it returns the same `SessionState` when nothing changes. */
const unchanged = (from: SessionState, e: HarnessEvent) =>
  assert.deepEqual(deriveStatus(from, e), from);

test("first model output moves starting → running", () => {
  for (const e of [
    ev({ type: "assistant_text", text: "hi" }),
    ev({ type: "thinking", text: "…" }),
    ev({ type: "tool_call", id: "1", name: "x", input: {} }),
    ev({ type: "answer", id: "q1", text: "x" }),
    ev({ type: "tool_result", id: "1", ok: true, output: null }),
  ]) {
    assert.deepEqual(deriveStatus(stateStarting, e), stateRunning);
  }
});

test("model activity does NOT clear awaiting_input — the daemon owns that", () => {
  // A provider that flushes assistant text / a tool call after the
  // permission_request must not unblock the UI while the gate is still parked.
  const blocked = stateAwaitingInput("permission");
  unchanged(blocked, ev({ type: "tool_call", id: "1", name: "x", input: {} }));
  unchanged(blocked, ev({ type: "assistant_text", text: "…" }));
  unchanged(blocked, ev({ type: "thinking", text: "…" }));
  unchanged(blocked, ev({ type: "tool_result", id: "1", ok: true, output: null }));
});

test("model activity while already running is a no-op", () => {
  unchanged(stateRunning, ev({ type: "thinking", text: "" }));
  unchanged(stateRunning, ev({ type: "tool_result", id: "1", ok: true, output: null }));
  unchanged(stateRunning, ev({ type: "assistant_text", text: "x" }));
});

test("a killed turn's own trailing output / result does not revive interrupted or error", () => {
  for (const s of [stateInterrupted("user"), stateError("boom")]) {
    unchanged(s, ev({ type: "assistant_text", text: "…" }));
    unchanged(s, ev({ type: "thinking", text: "…" }));
    unchanged(s, ev({ type: "tool_call", id: "1", name: "x", input: {} }));
    unchanged(s, ev({ type: "tool_result", id: "1", ok: true, output: null }));
    unchanged(s, ev({ type: "result", kind: "ok" }));
    unchanged(s, ev({ type: "result", kind: "error", error: "x" }));
    // …but a fatal error still wins.
    assert.deepEqual(
      deriveStatus(s, ev({ type: "error", message: "dead", fatal: true })),
      stateError("dead"),
    );
  }
});

test("a new turn's blocking request re-engages an interrupted / errored session", () => {
  // After the killed turn has drained, the next turn's permission / plan / ask
  // is real input and must surface — the old transient-guard behaviour.
  for (const s of [stateInterrupted("user"), stateError("boom")]) {
    assert.deepEqual(
      deriveStatus(s, ev({ type: "permission_request", id: "p", tool: "Bash", input: {} })),
      stateAwaitingInput("permission"),
    );
    assert.deepEqual(
      deriveStatus(s, ev({ type: "plan_review", id: "pr", plan: "…" })),
      stateAwaitingInput("plan_review"),
    );
    assert.deepEqual(
      deriveStatus(s, ev({ type: "question", id: "q", question: "?" })),
      stateAwaitingInput("question"),
    );
  }
});

test("fresh model output heals a session wrongly parked at idle", () => {
  // A connector can emit an interim `result` (Claude: denied ExitPlanMode,
  // `/compact`, a background Task re-driving the loop) and then keep streaming
  // the same engagement. Those events never pass through the daemon's send()
  // path, so the state machine has to pull the session back to `running`.
  for (const e of [
    ev({ type: "assistant_text", text: "back to work" }),
    ev({ type: "thinking", text: "…" }),
    ev({ type: "tool_call", id: "1", name: "x", input: {} }),
  ]) {
    assert.deepEqual(deriveStatus(stateIdle, e), stateRunning);
  }
  // Plumbing events are not enough on their own to revive a settled turn.
  unchanged(stateIdle, ev({ type: "tool_result", id: "1", ok: true, output: null }));
  unchanged(stateIdle, ev({ type: "answer", id: "q1", text: "x" }));
});

test("permission_request → awaiting_input/permission (payload returned even when already blocked)", () => {
  assert.deepEqual(
    deriveStatus(
      stateRunning,
      ev({ type: "permission_request", id: "p1", tool: "Bash", input: {} }),
    ),
    stateAwaitingInput("permission"),
  );
  // deriveStatus reports the state; the manager de-dupes an unchanged kind+payload.
  assert.deepEqual(
    deriveStatus(
      stateAwaitingInput("permission"),
      ev({ type: "permission_request", id: "p2", tool: "Bash", input: {} }),
    ),
    stateAwaitingInput("permission"),
  );
});

test("permission_request for AskUserQuestion → awaiting_input/user_question", () => {
  assert.deepEqual(
    deriveStatus(
      stateRunning,
      ev({ type: "permission_request", id: "p1", tool: "AskUserQuestion", input: {} }),
    ),
    stateAwaitingInput("user_question"),
  );
});

test("plan_review → awaiting_input/plan_review", () => {
  assert.deepEqual(
    deriveStatus(stateRunning, ev({ type: "plan_review", id: "pr1", plan: "do X then Y" })),
    stateAwaitingInput("plan_review"),
  );
});

test("question → awaiting_input/question; a permission→question payload change transitions", () => {
  assert.deepEqual(
    deriveStatus(stateRunning, ev({ type: "question", id: "q1", question: "which?" })),
    stateAwaitingInput("question"),
  );
  // was permission, now question — the client needs the new blocked reason
  assert.deepEqual(
    deriveStatus(
      stateAwaitingInput("permission"),
      ev({ type: "question", id: "q2", question: "?" }),
    ),
    stateAwaitingInput("question"),
  );
});

test("answer alone does not move status — #resumeAfterAnswer sets running", () => {
  // The daemon's answer/approve RPC path sets `running` explicitly; the trailing
  // `answer` event (processed later by the pump) is then a no-op.
  unchanged(stateAwaitingInput("question"), ev({ type: "answer", id: "q1", text: "this one" }));
  unchanged(stateRunning, ev({ type: "answer", id: "q1", text: "this one" }));
});

test("result maps to idle on success, error (with the real message) on failure", () => {
  assert.deepEqual(deriveStatus(stateRunning, ev({ type: "result", kind: "ok" })), stateIdle);
  assert.deepEqual(
    deriveStatus(stateRunning, ev({ type: "result", kind: "error", error: "the model 500'd" })),
    stateError("the model 500'd"),
  );
});

test("only fatal errors change status", () => {
  unchanged(stateRunning, ev({ type: "error", message: "blip", fatal: false }));
  assert.deepEqual(
    deriveStatus(stateRunning, ev({ type: "error", message: "dead", fatal: true })),
    stateError("dead"),
  );
});

const bgEv = (n: number) =>
  ev({
    type: "background_tasks",
    tasks: Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      kind: "subagent" as const,
      title: `task ${i}`,
    })),
  });

test("a clean result with background work outstanding settles to working_background", () => {
  assert.deepEqual(
    deriveStatus(stateRunning, ev({ type: "result", kind: "ok" }), { backgroundTasks: 2 }),
    stateWorkingBackground,
  );
  // A failed result still errors regardless of background work.
  assert.deepEqual(
    deriveStatus(stateRunning, ev({ type: "result", kind: "error", error: "boom" }), {
      backgroundTasks: 3,
    }),
    stateError("boom"),
  );
});

test("background_tasks holds/releases a settled turn, and never disturbs a live or terminal one", () => {
  // idle ⇄ working_background at the set's edges
  assert.deepEqual(deriveStatus(stateIdle, bgEv(1)), stateWorkingBackground);
  assert.deepEqual(deriveStatus(stateWorkingBackground, bgEv(0)), stateIdle);
  // no-ops: non-empty while already parked, empty while already idle
  unchanged(stateWorkingBackground, bgEv(2));
  unchanged(stateIdle, bgEv(0));
  // a live turn owns its own transition — a background task spawned mid-turn
  // must not knock `running` sideways
  unchanged(stateRunning, bgEv(1));
  unchanged(stateStarting, bgEv(1));
  // blocked / terminal states are untouched
  unchanged(stateAwaitingInput("permission"), bgEv(1));
  unchanged(stateAwaitingInput("permission"), bgEv(0));
  unchanged(stateInterrupted("user"), bgEv(0));
  unchanged(stateError("x"), bgEv(0));
  unchanged({ kind: "done" }, bgEv(1));
});

test("fresh model output heals working_background → running (the re-drive)", () => {
  for (const e of [
    ev({ type: "assistant_text", text: "task finished, continuing" }),
    ev({ type: "thinking", text: "…" }),
    ev({ type: "tool_call", id: "1", name: "x", input: {} }),
  ]) {
    assert.deepEqual(deriveStatus(stateWorkingBackground, e), stateRunning);
  }
  // plumbing events alone don't
  unchanged(stateWorkingBackground, ev({ type: "tool_result", id: "1", ok: true, output: null }));
});

test("a background subagent's permission prompt still surfaces from working_background", () => {
  assert.deepEqual(
    deriveStatus(
      stateWorkingBackground,
      ev({ type: "permission_request", id: "p", tool: "Bash", input: {} }),
    ),
    stateAwaitingInput("permission"),
  );
});

test("usage and subagent events never move status", () => {
  unchanged(
    stateRunning,
    ev({
      type: "usage",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextUsed: 0,
      contextLimit: 0,
    }),
  );
  unchanged(stateIdle, ev({ type: "subagent_started", subagentId: "a", name: "n" }));
});
