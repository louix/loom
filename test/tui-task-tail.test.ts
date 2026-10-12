import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { TaskOutput } from "@loom/core/types";
import { mkTaskTail, type TaskTailTarget, type TaskTailView } from "@loom/tui/task-tail";
import { taskTailLines } from "@loom/tui/transcript";

/** A read the test answers by hand. */
interface Read {
  readonly target: TaskTailTarget;
  readonly resolve: (r: TaskOutput) => void;
  readonly reject: (e: Error) => void;
}

const mkReads = () => {
  const reads: Read[] = [];
  const read = (target: TaskTailTarget): Promise<TaskOutput> =>
    new Promise((resolve, reject) => reads.push({ target, resolve, reject }));
  return { reads, read };
};

const output = (text: string): TaskOutput => ({
  t: "output",
  output: text,
  totalBytes: text.length,
  truncated: false,
});
const shell = { sessionId: "a", taskId: "bash-1" };

test("a wanted task is read at once, then again after each answer, and not after it is let go", async () => {
  const { reads, read } = mkReads();
  const tail = mkTaskTail({ read, pollMs: 5, now: () => 42 });
  tail.want(shell);
  assert.equal(reads.length, 1, "read at once");
  assert.deepEqual(tail.get()?.tail, { t: "loading" });
  tail.want({ ...shell });
  assert.equal(reads.length, 1, "the same task keeps its poll");
  await delay(20);
  assert.equal(reads.length, 1, "one read at a time: nothing while the first is out");
  reads[0]!.resolve(output("tick 1\n"));
  await delay(0);
  assert.deepEqual(tail.get()?.tail, {
    t: "shown",
    output: "tick 1\n",
    totalBytes: 7,
    truncated: false,
    at: 42,
  });
  await delay(20);
  assert.equal(reads.length, 2, "polled again after the answer");
  // A failed read is shown, and the poll goes on.
  reads[1]!.reject(new Error("timed out reading the task output"));
  await delay(20);
  assert.equal(tail.get()?.tail.t, "failed");
  assert.equal(reads.length, 3);
  tail.want(null);
  assert.equal(tail.get(), null);
  reads[2]!.resolve(output("tick 3\n"));
  await delay(20);
  assert.equal(tail.get(), null, "an answer after letting go is dropped");
  assert.equal(reads.length, 3, "and nothing is read again");
});

test("another task replaces the poll; a task with no output is read once", async () => {
  const { reads, read } = mkReads();
  const tail = mkTaskTail({ read, pollMs: 5 });
  tail.want(shell);
  const agent = { sessionId: "a", taskId: "agent-1" };
  tail.want(agent);
  assert.deepEqual(
    reads.map((r) => r.target.taskId),
    ["bash-1", "agent-1"],
  );
  reads[0]!.resolve(output("stale"));
  await delay(0);
  assert.deepEqual(tail.get(), { target: agent, tail: { t: "loading" } }, "stale answer dropped");
  reads[1]!.resolve({ t: "unreadable" });
  await delay(20);
  assert.deepEqual(tail.get()?.tail, { t: "unreadable" });
  assert.equal(reads.length, 2, "unreadable is not read again");
  tail.want({ sessionId: "b", taskId: "t" });
  reads[2]!.resolve({ t: "unsupported" });
  await delay(20);
  assert.deepEqual(tail.get()?.tail, { t: "unsupported" });
  assert.equal(reads.length, 3);
  tail.dispose();
});

test("the tail draws as plain lines after a header, and says why when there is none", () => {
  const at = new Date(2026, 9, 12, 9, 30).getTime();
  const view = (tail: TaskTailView["tail"]): TaskTailView => ({ target: shell, tail });
  const shown = taskTailLines(
    "a",
    view({ t: "shown", output: "tick 1\ntick 2\n\n", totalBytes: 20_480, truncated: true, at }),
  );
  assert.deepEqual(
    shown.map((l) => [l.kind, l.text, l.tone]),
    [
      ["task_output", "output · last 15 B of 20.0 KiB", "dim"],
      ["task_output", "tick 1\ntick 2", "plain"],
    ],
  );
  assert.equal(taskTailLines("other", view({ t: "loading" })).length, 0);
  const one = (tail: TaskTailView["tail"]) => taskTailLines("a", view(tail)).map((l) => l.text);
  assert.deepEqual(one({ t: "loading" }), ["reading output…"]);
  assert.deepEqual(one({ t: "shown", output: "  \n", totalBytes: 3, truncated: false, at }), [
    "no output yet",
  ]);
  assert.match(one({ t: "unreadable" })[0]!, /no output to show for this task/);
  assert.match(one({ t: "unsupported" })[0]!, /provider cannot show/);
  assert.match(one({ t: "failed", message: "boom", at })[0]!, /could not read the output: boom/);
  assert.deepEqual(taskTailLines("a", null), []);
});
