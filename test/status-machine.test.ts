import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveStatus } from "@loom/daemon/daemon/status-machine";
import type { HarnessEvent } from "@loom/core/events";

const ev = (e: Partial<HarnessEvent> & { type: HarnessEvent["type"] }): HarnessEvent =>
  ({ sessionId: "s", ts: 0, ...e }) as HarnessEvent;

test("first model output moves starting → running", () => {
  assert.deepEqual(deriveStatus("starting", ev({ type: "assistant_text", text: "hi" })), {
    status: "running",
    reason: null,
  });
});

test("model activity does NOT clear awaiting_input — the daemon owns that", () => {
  // A provider that flushes assistant text / a tool call after the
  // permission_request must not unblock the UI while the gate is still parked.
  assert.equal(
    deriveStatus("awaiting_input", ev({ type: "tool_call", id: "1", name: "x", input: {} })),
    null,
  );
  assert.equal(deriveStatus("awaiting_input", ev({ type: "assistant_text", text: "…" })), null);
  assert.equal(deriveStatus("awaiting_input", ev({ type: "thinking", text: "…" })), null);
  assert.equal(
    deriveStatus("awaiting_input", ev({ type: "tool_result", id: "1", ok: true, output: null })),
    null,
  );
});

test("model activity while already running / interrupted / idle is a no-op", () => {
  assert.equal(deriveStatus("running", ev({ type: "thinking", text: "" })), null);
  assert.equal(
    deriveStatus("running", ev({ type: "tool_result", id: "1", ok: true, output: null })),
    null,
  );
  assert.equal(
    deriveStatus("interrupted", ev({ type: "tool_result", id: "1", ok: true, output: null })),
    null,
  );
  assert.equal(
    deriveStatus("idle", ev({ type: "tool_call", id: "1", name: "x", input: {} })),
    null,
  );
});

test("permission_request → awaiting_input/permission (reason returned even when already awaiting)", () => {
  assert.deepEqual(
    deriveStatus("running", ev({ type: "permission_request", id: "p1", tool: "Bash", input: {} })),
    { status: "awaiting_input", reason: "permission" },
  );
  // deriveStatus reports the reason; #set dedupes an unchanged status+reason.
  assert.deepEqual(
    deriveStatus(
      "awaiting_input",
      ev({ type: "permission_request", id: "p2", tool: "Bash", input: {} }),
    ),
    { status: "awaiting_input", reason: "permission" },
  );
});

test("plan_review → awaiting_input/plan_review", () => {
  assert.deepEqual(
    deriveStatus("running", ev({ type: "plan_review", id: "pr1", plan: "do X then Y" })),
    { status: "awaiting_input", reason: "plan_review" },
  );
  assert.deepEqual(
    deriveStatus("awaiting_input", ev({ type: "plan_review", id: "pr2", plan: "…" })),
    { status: "awaiting_input", reason: "plan_review" },
  );
});

test("question → awaiting_input/question; a permission→question reason change is surfaced", () => {
  assert.deepEqual(
    deriveStatus("running", ev({ type: "question", id: "q1", question: "which?" })),
    { status: "awaiting_input", reason: "question" },
  );
  // was permission, now question — the client needs the new blocked-reason
  assert.deepEqual(
    deriveStatus("awaiting_input", ev({ type: "question", id: "q2", question: "which?" })),
    { status: "awaiting_input", reason: "question" },
  );
});

test("answer alone does not move status — #resumeAfterAnswer sets running", () => {
  // The daemon's answer/approve RPC path sets `running` explicitly; the trailing
  // `answer` event (processed later by the pump) is then a no-op.
  assert.equal(
    deriveStatus("awaiting_input", ev({ type: "answer", id: "q1", text: "this one" })),
    null,
  );
  assert.equal(deriveStatus("running", ev({ type: "answer", id: "q1", text: "this one" })), null);
});

test("result maps to idle on success, error on failure", () => {
  assert.deepEqual(deriveStatus("running", ev({ type: "result", ok: true })), {
    status: "idle",
    reason: "result",
  });
  assert.deepEqual(deriveStatus("running", ev({ type: "result", ok: false })), {
    status: "error",
    reason: "run_error",
  });
});

test("only fatal errors change status", () => {
  assert.equal(deriveStatus("running", ev({ type: "error", message: "blip", fatal: false })), null);
  assert.deepEqual(deriveStatus("running", ev({ type: "error", message: "dead", fatal: true })), {
    status: "error",
    reason: "dead",
  });
});

test("usage and subagent events never move status", () => {
  assert.equal(
    deriveStatus(
      "running",
      ev({
        type: "usage",
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextUsed: 0,
        contextLimit: 0,
      }),
    ),
    null,
  );
  assert.equal(
    deriveStatus("idle", ev({ type: "subagent_started", subagentId: "a", name: "n" })),
    null,
  );
});
