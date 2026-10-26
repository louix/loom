import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeCells } from "../connectors/chatgpt/src/code-cells.ts";
import { RolloutTail } from "../connectors/chatgpt/src/rollout-tail.ts";
import type { HarnessEvent } from "@loom/core/events";
import { harnessEventSchema } from "@loom/core/events";
import { deriveStatus } from "@loom/daemon/daemon/status-machine";
import { stateRunning } from "@loom/core/session-state";
import { childrenOf } from "@loom/tui/model";
import { filterLog, toLogLine, transcriptText, formatEvent } from "@loom/tui/transcript";
import { snap } from "./tui-fixtures.ts";

const code = "await new Promise(resolve => setTimeout(resolve, 6000000));";
const exec = (id = "exec-1") => ({
  type: "custom_tool_call",
  call_id: id,
  name: "exec",
  input: code,
});
const wait = (cell = "577", id = "wait-1") => ({
  type: "function_call",
  call_id: id,
  name: "wait",
  arguments: JSON.stringify({ cell_id: cell, yield_time_ms: 1000 }),
});
const output = (text: string, id = "exec-1") => ({
  type: "custom_tool_call_output",
  call_id: id,
  output: [
    { type: "input_text", text },
    { type: "input_text", text: "script output" },
  ],
});
const running = "Script running with cell ID 577\nWall time 1.0 seconds\nOutput:\n";
const latestTasks = (events: HarnessEvent[]) =>
  events.filter((e) => e.type === "background_tasks").at(-1)?.tasks ?? [];

test("yielded Code Mode cells survive the reply and appear in nested rows and full history", () => {
  const events: HarnessEvent[] = [];
  const cells = new CodeCells("s", (e) => events.push(harnessEventSchema.parse(e)));
  cells.accept(exec(), 1000);
  cells.accept(output(running), 2000);
  const tasks = latestTasks(events);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.id, "codex-cell:577");
  assert.equal(tasks[0]?.outputSource, "events");
  const settled = deriveStatus(
    stateRunning,
    { type: "result", kind: "ok", sessionId: "s", ts: 3000 },
    { backgroundTasks: tasks.length },
  );
  assert.equal(settled.kind, "working_background");
  const children = childrenOf(snap({ backgroundTasks: tasks, status: settled }));
  assert.match(children[0]!.label, /577.*last reported running/);
  assert.equal(children[0]?.outputSource, "events");
  const lines = events.map((e) => toLogLine(null, e, "exec"));
  const parent = transcriptText(filterLog(lines, "everything", null));
  assert.match(parent, /tool call: exec/);
  assert.ok(parent.includes(code));
  assert.match(parent, /Script running with cell ID 577/);
  const child = transcriptText(filterLog(lines, "everything", children[0]!.id));
  assert.ok(child.includes(code));
  assert.match(child, /script output/);
  const result = events.find((e) => e.type === "tool_result")!;
  assert.equal(formatEvent(result, "exec").text, "running · cell 577");
  assert.equal(formatEvent(result, "unrelated_tool").text, "ok");

  cells.accept(wait(), 4000);
  cells.accept(output("Script completed\nWall time 0.0 seconds\nOutput:\n", "wait-1"), 5000);
  assert.deepEqual(latestTasks(events), []);
  assert.equal(events.find((e) => e.type === "background_task_ended")?.status, "completed");
  assert.equal(deriveStatus(settled, events.at(-1)!).kind, "idle");
});

test("RPC and rollout duplicates do not duplicate tools or cells; independent cells drain separately", () => {
  const events: HarnessEvent[] = [];
  const cells = new CodeCells("s", (e) => events.push(e));
  for (let i = 0; i < 2; i++) {
    cells.accept(exec(), 1);
    cells.accept(output(running), 2);
  }
  assert.equal(events.filter((e) => e.type === "tool_call").length, 1);
  assert.equal(events.filter((e) => e.type === "tool_result").length, 1);
  cells.accept(exec("exec-2"), 3);
  cells.accept(output(running.replace("577", "578"), "exec-2"), 4);
  cells.accept(wait(), 5);
  cells.accept(output(running, "wait-1"), 6);
  assert.equal(latestTasks(events).length, 2);
  cells.accept(wait("577", "wait-2"), 7);
  cells.accept(output("Script terminated\n", "wait-2"), 8);
  assert.deepEqual(
    latestTasks(events).map((t) => t.id),
    ["codex-cell:578"],
  );
  assert.equal(events.find((e) => e.type === "background_task_ended")?.status, "stopped");
  cells.close(9);
  assert.deepEqual(latestTasks(events), []);
  assert.equal(events.filter((e) => e.type === "background_task_ended").length, 1);
  assert.ok(events.some((e) => e.type === "notice" && /no longer available/.test(e.message)));
});

test("unrelated tools, malformed waits, and text printed by scripts cannot invent or end cells", () => {
  const events: HarnessEvent[] = [];
  const cells = new CodeCells("s", (e) => events.push(e));
  cells.accept({ ...exec(), name: "apply_patch" }, 1);
  cells.accept(output(running), 2);
  cells.accept({ ...exec(), namespace: "unrelated" }, 3);
  cells.accept(null, 4);
  assert.equal(events.length, 0);
  cells.accept(exec(), 5);
  cells.accept(output("Script completed\nOutput:\n" + running), 6);
  assert.deepEqual(latestTasks(events), []);
  cells.accept(exec("live"), 7);
  cells.accept(output(running, "live"), 8);
  cells.accept({ ...wait(), arguments: "bad json" }, 9);
  cells.accept(output("Script completed\n", "wait-1"), 10);
  assert.equal(latestTasks(events).length, 1);
  cells.accept(wait("577", "failed-wait"), 11);
  cells.accept(output("Error: temporary failure\n", "failed-wait"), 12);
  assert.equal(latestTasks(events).length, 1);
  cells.accept(wait("577", "final-wait"), 13);
  cells.accept(output("Script failed\n", "final-wait"), 14);
  assert.deepEqual(latestTasks(events), []);
  assert.equal(events.find((e) => e.type === "background_task_ended")?.status, "failed");
});

test("rollout fallback reads appended complete UTF-8 records, skips old history, and closes cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-cell-tail-"));
  const path = join(dir, "rollout.jsonl");
  const row = (payload: unknown) =>
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-10-26T23:22:57.474Z",
      payload,
    }) + "\n";
  writeFileSync(path, row(exec("old")) + row(output(running, "old")));
  const seen: unknown[] = [];
  const errors: unknown[] = [];
  const tail = new RolloutTail(
    path,
    (item) => seen.push(item),
    (error) => errors.push(error),
  );
  try {
    tail.flush();
    assert.deepEqual(seen, []);
    const item = { ...exec(), input: 'text("✓")' };
    const bytes = Buffer.from(row(item));
    const split = bytes.indexOf(Buffer.from("✓")) + 1;
    appendFileSync(path, bytes.subarray(0, split));
    tail.flush();
    assert.deepEqual(seen, []);
    appendFileSync(path, bytes.subarray(split));
    appendFileSync(path, "bad json\n" + row(output(running)));
    tail.flush();
    assert.deepEqual(seen, [item, output(running)]);
    tail.flush();
    assert.equal(seen.length, 2);
    // A rewind must not resurrect retained historical calls.
    writeFileSync(path, row(exec("old")));
    tail.flush();
    assert.equal(seen.length, 2);
    appendFileSync(path, row(exec("new")));
    tail.flush();
    assert.equal(seen.length, 3);
    tail.close();
    appendFileSync(path, row(exec("closed")));
    tail.flush();
    assert.equal(seen.length, 3);
    assert.deepEqual(errors, []);
  } finally {
    tail.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
