import assert from "node:assert/strict";
import { test } from "node:test";
import { dequeueHints, nextAction, type DispatchView } from "@loom/daemon/daemon/message-queue";
import { describeDequeue, type DequeueHint, type QueueEntry } from "@loom/core/message-queue";
import {
  stateAwaitingInput,
  stateError,
  stateIdle,
  stateInterrupted,
  stateRunning,
  stateStarting,
  stateWorkingBackground,
} from "@loom/core/session-state";

const entry = (
  id: string,
  delivery: QueueEntry["delivery"] = "next_boundary",
  state: QueueEntry["state"] = "queued",
): QueueEntry => ({
  id,
  text: id,
  author: "c1",
  delivery,
  state,
  uncertain: false,
  revision: 0,
  createdAt: 0,
});

const view = (over: Partial<DispatchView> = {}): DispatchView => ({
  attached: true,
  state: stateIdle,
  restructuring: false,
  cancelling: false,
  handingOver: false,
  rootTool: null,
  backoff: false,
  ...over,
});

const queue = [entry("b1"), entry("b2"), entry("e1", "end_of_turn"), entry("e2", "end_of_turn")];
const NONE = { t: "none" };

test("rule 1: nothing goes while held, cold, starting, awaiting input, restructuring, stopping or mid hand-over", () => {
  const running = { state: stateRunning, rootTool: "Bash" };
  assert.deepEqual(nextAction(queue, "interrupt", view(running)), NONE);
  assert.deepEqual(nextAction(queue, null, view({ attached: false })), NONE);
  assert.deepEqual(nextAction(queue, null, view({ state: stateStarting })), NONE);
  assert.deepEqual(
    nextAction(queue, null, view({ ...running, state: stateAwaitingInput("permission") })),
    NONE,
  );
  assert.deepEqual(nextAction(queue, null, view({ restructuring: true })), NONE);
  assert.deepEqual(nextAction(queue, null, view({ cancelling: true })), NONE);
  assert.deepEqual(nextAction(queue, null, view({ handingOver: true })), NONE);
  assert.deepEqual(nextAction(queue, null, view({ backoff: true })), NONE);
});

test("rule 2: a root tool in flight opens the boundary window for every next_boundary entry", () => {
  assert.deepEqual(nextAction(queue, null, view({ state: stateRunning, rootTool: "Bash" })), {
    t: "handover",
    ids: ["b1", "b2"],
    fresh: false,
  });
});

test("rule 3: while the model only writes, next_boundary entries wait in Loom", () => {
  assert.deepEqual(nextAction(queue, null, view({ state: stateRunning })), NONE);
});

test("rule 4: at turn end (a failed one too) the leftover next_boundary entries go as one fresh turn", () => {
  for (const state of [
    stateIdle,
    stateInterrupted("user"),
    stateWorkingBackground,
    stateError("turn failed"),
  ]) {
    assert.deepEqual(nextAction(queue, null, view({ state })), {
      t: "handover",
      ids: ["b1", "b2"],
      fresh: true,
    });
  }
});

test("rule 5: idle with no next_boundary left hands over one end_of_turn entry; background work waits", () => {
  const eot = [entry("e1", "end_of_turn"), entry("e2", "end_of_turn")];
  assert.deepEqual(nextAction(eot, null, view()), { t: "handover", ids: ["e1"], fresh: true });
  assert.deepEqual(nextAction(eot, null, view({ state: stateWorkingBackground })), NONE);
  assert.deepEqual(nextAction(eot, null, view({ state: stateRunning, rootTool: "Bash" })), NONE);
  // The head one is on its way: the next waits for the following idle, which
  // the turn it starts brings.
  const after = [entry("e1", "end_of_turn", "delivering"), entry("e2", "end_of_turn")];
  assert.deepEqual(nextAction(after, null, view()), { t: "handover", ids: ["e2"], fresh: true });
});

test("a forced entry goes alone and ignores the hold, into the live turn or as its own", () => {
  assert.deepEqual(nextAction(queue, "interrupt", view(), "e2"), {
    t: "handover",
    ids: ["e2"],
    fresh: true,
  });
  assert.deepEqual(nextAction(queue, "rejected", view({ state: stateRunning }), "b2"), {
    t: "handover",
    ids: ["b2"],
    fresh: false,
  });
  // It still waits for the request and the restructure like everything else.
  assert.deepEqual(
    nextAction(queue, null, view({ state: stateAwaitingInput("question") }), "b1"),
    NONE,
  );
  // An id that is no longer queued is ignored; the ordinary rules apply.
  assert.deepEqual(nextAction(queue, "interrupt", view(), "gone"), NONE);
});

test("hints say when each entry goes, and every one renders", () => {
  const hint = (v: DispatchView, hold: Parameters<typeof dequeueHints>[1] = null) => [
    ...dequeueHints([entry("d", "next_boundary", "delivering"), ...queue], hold, v).values(),
  ];
  assert.deepEqual(hint(view({ state: stateRunning, rootTool: "Bash" })), [
    { t: "handed_over" },
    { t: "tool_boundary", tool: "Bash" },
    { t: "tool_boundary", tool: "Bash" },
    { t: "turn_end", ahead: 0 },
    { t: "turn_end", ahead: 1 },
  ]);
  assert.deepEqual(hint(view({ state: stateRunning }))[1], { t: "next_tool_or_turn_end" });
  assert.deepEqual(hint(view(), "interrupt")[1], { t: "held", reason: "interrupt" });
  assert.deepEqual(hint(view({ attached: false }))[1], { t: "session_stopped" });
  assert.deepEqual(hint(view({ state: stateAwaitingInput("permission") }))[1], {
    t: "after_request",
  });
  assert.deepEqual(hint(view({ restructuring: true }))[1], { t: "after_compaction" });
  const all: DequeueHint[] = [
    { t: "tool_boundary", tool: "Bash" },
    { t: "next_tool_or_turn_end" },
    { t: "turn_end", ahead: 0 },
    { t: "turn_end", ahead: 1 },
    { t: "after_request" },
    { t: "after_compaction" },
    { t: "held", reason: "interrupt" },
    { t: "session_stopped" },
    { t: "handed_over" },
  ];
  assert.deepEqual(all.map(describeDequeue), [
    "lands when Bash finishes",
    "at the next tool boundary",
    "when the agent finishes",
    "when the agent finishes, 2nd in line",
    "after the pending request",
    "after the compaction",
    "held · r releases",
    "session stopped · sending revives it",
    "handed to the agent",
  ]);
});
