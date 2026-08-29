import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
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

test("session.remove deletes the row + worktree, keeps the branch, pushes session_removed", async () => {
  const c = await client();
  const s = await c.request<SessionSnapshot>("session.create", { prompt: "throwaway spike", provider: "fake" });
  const tree = s.worktree as string;
  assert.ok(existsSync(tree));

  const removed: string[] = [];
  c.onPush((f) => {
    if (f.type === "session_removed") removed.push(f.sessionId);
  });

  const r = await c.request<{ removed: string }>("session.remove", { id: s.id });
  assert.equal(r.removed, s.id);
  assert.ok(!existsSync(tree), "worktree is gone");

  await assert.rejects(c.request("session.get", { id: s.id }), /no such session/);
  const list = await c.request<SessionSnapshot[]>("session.list");
  assert.ok(!list.some((x) => x.id === s.id), "row is gone from the fleet");

  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(removed, [s.id], "clients got a session_removed frame");

  // branch survives the delete, like gc
  const branches = execFileSync("git", ["-C", h.repoRoot, "branch", "--list", "loom/throwaway-spike"], {
    encoding: "utf8",
  });
  assert.match(branches, /loom\/throwaway-spike/);
  await c.close();
});

test("session.remove on an unknown id is a not_found", async () => {
  const c = await client();
  await assert.rejects(c.request("session.remove", { id: "nope" }), /no such session/);
  await c.close();
});
