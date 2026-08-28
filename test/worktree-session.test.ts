import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { LoomClient } from "../src/client/client.ts";
import type { SessionSnapshot } from "../src/protocol/wire.ts";
import { makeHarness, type Harness } from "./helpers.ts";

let h: Harness;

before(async () => {
  h = await makeHarness();
});
after(async () => {
  await h.cleanup();
});

function client(): Promise<LoomClient> {
  return LoomClient.connect({ repoRoot: h.repoRoot, sockPath: h.sockPath, autospawn: false });
}

test("session.create gives the session its own worktree + branch off base", async () => {
  const c = await client();
  const s = await c.request<SessionSnapshot>("session.create", {
    prompt: "wire up the metrics endpoint",
    provider: "fake",
  });
  assert.ok(s.worktree && s.worktree.includes("/.loom/trees/"));
  assert.equal(s.branch, "loom/wire-up-the-metrics-endpoint");
  assert.equal(s.baseBranch, "main");
  assert.ok(existsSync(s.worktree as string));

  const got = await c.request<SessionSnapshot>("session.get", { id: s.id });
  assert.ok(got.git, "git facts should be enriched onto the snapshot");
  assert.equal(got.git?.branch, "loom/wire-up-the-metrics-endpoint");
  assert.equal(got.git?.dirty, false);
  assert.equal(got.git?.aheadOfBase, 0);
  await c.close();
});

test("two sessions from similar prompts get distinct worktrees", async () => {
  const c = await client();
  const a = await c.request<SessionSnapshot>("session.create", { prompt: "fix the bug", provider: "fake" });
  const b = await c.request<SessionSnapshot>("session.create", { prompt: "fix the bug", provider: "fake" });
  assert.notEqual(a.worktree, b.worktree);
  assert.notEqual(a.branch, b.branch);
  await c.close();
});

test("markDone then gc removes the worktree but keeps the row and branch", async () => {
  const c = await client();
  const s = await c.request<SessionSnapshot>("session.create", { prompt: "cleanup target", provider: "fake" });
  const tree = s.worktree as string;

  // gc ignores sessions that aren't done
  let gc = await c.request<{ removed: string[] }>("session.gc");
  assert.ok(!gc.removed.includes(s.id));

  const done = await c.request<SessionSnapshot>("session.markDone", { id: s.id });
  assert.equal(done.status, "done");

  gc = await c.request<{ removed: string[]; failed: unknown[] }>("session.gc", { force: true });
  assert.ok(gc.removed.includes(s.id));
  assert.ok(!existsSync(tree));

  const after = await c.request<SessionSnapshot>("session.get", { id: s.id });
  assert.equal(after.status, "done");
  assert.equal(after.worktree, null);
  assert.equal(after.branch, "loom/cleanup-target"); // branch retained
  await c.close();
});
