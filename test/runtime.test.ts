import assert from "node:assert/strict";
import { test } from "node:test";
import { PendingInteractions } from "@loom/runtime/pending";
import { toolSteer } from "@loom/runtime/instructions";

test("PendingInteractions parks a request until resolved, then forgets it", async () => {
  const p = new PendingInteractions<{ allow: boolean }, string>();
  const promise = p.requestPermission("a");
  assert.equal(p.resolvePermission("a", { allow: true }), true);
  assert.deepEqual(await promise, { allow: true });
  // First writer wins: a second resolve on the same (now-forgotten) id is a no-op.
  assert.equal(p.resolvePermission("a", { allow: false }), false);
});

test("PendingInteractions.resolve* return false for an unknown id", () => {
  const p = new PendingInteractions<{ allow: boolean }, string>();
  assert.equal(p.resolvePermission("missing", { allow: true }), false);
  assert.equal(p.resolveQuestion("missing", "answer"), false);
  assert.equal(p.resolvePlan("missing", "plan"), false);
});

test("PendingInteractions.hasPlan reflects whether a plan is still parked", () => {
  const p = new PendingInteractions<{ allow: boolean }, string>();
  void p.requestPlan("p1");
  assert.equal(p.hasPlan("p1"), true);
  assert.equal(p.hasPlan("p2"), false);
  p.resolvePlan("p1", "done");
  assert.equal(p.hasPlan("p1"), false);
});

test("PendingInteractions.failAll drains every parked interaction with the given values", async () => {
  const p = new PendingInteractions<{ allow: boolean; message?: string }, { action: string }>();
  const perm = p.requestPermission("perm-1");
  const question = p.requestQuestion("q-1");
  const plan = p.requestPlan("plan-1");

  p.failAll({ allow: false, message: "closed" }, "(closed)", { action: "discuss" });

  assert.deepEqual(await perm, { allow: false, message: "closed" });
  assert.equal(await question, "(closed)");
  assert.deepEqual(await plan, { action: "discuss" });
  // Everything was cleared — a late resolve is a no-op, not a crash.
  assert.equal(p.resolvePermission("perm-1", { allow: true }), false);
});

test("toolSteer only mentions loom tools that are actually mounted", () => {
  const full = toolSteer("/tmp/work", { askUser: true, commit: true, status: true });
  assert.match(full, /`status` tool reprints this root/);
  assert.match(full, /call the `commit` tool/);
  assert.match(full, /call `ask_user`/);

  const commitOnly = toolSteer("/tmp/work", { askUser: false, commit: true, status: false });
  assert.doesNotMatch(commitOnly, /`status` tool reprints this root/);
  assert.match(commitOnly, /call the `commit` tool/);
  assert.doesNotMatch(commitOnly, /call `ask_user`/);
});
