import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkerTranscript } from "../runtime/src/worker/transcript.ts";
import { decodeWorkerFrame, decodeWorkerRequest } from "../core/src/worker.ts";

test("worker transcript is scoped, copied, and publishes edits in order", () => {
  const writes: unknown[] = [];
  const store = new WorkerTranscript("mine", (from, messages) => writes.push({ from, messages }));
  store.seed([{ role: "user", content: "old" }]);
  assert.equal(writes.length, 0);
  store.append("mine", [{ role: "assistant", content: "answer" }]);
  store.replaceFrom("mine", 1, [{ role: "assistant", content: "replacement" }]);
  assert.deepEqual(writes, [
    { from: 1, messages: [{ role: "assistant", content: "answer" }] },
    { from: 1, messages: [{ role: "assistant", content: "replacement" }] },
  ]);
  store.load("mine").pop();
  assert.equal(store.count("mine"), 2);
  assert.throws(() => store.load("peer"));
  assert.throws(() => store.clear("peer"));
  assert.throws(() => store.copyTo("mine", "peer"));
  assert.throws(() => store.replaceFrom("mine", 10, []));
});

test("transcript transport rejects invalid offsets and malformed messages", () => {
  assert.throws(() => decodeWorkerFrame({ kind: "transcript", from: -1, messages: [] }));
  assert.throws(() => decodeWorkerFrame({ kind: "transcript", from: 0, messages: [{}] }));
  assert.throws(() =>
    decodeWorkerRequest({ kind: "request", id: 2, method: "seedTranscript", args: [[{}]] }),
  );
});
