import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import type { PushFrame, SessionSnapshot } from "@loom/core/wire";
import type { FakeProvider, FakeSession } from "@loom/connector-mock";
import { makeHarness, type Harness } from "@loom/harness";

let h: Harness;

before(async () => {
  h = await makeHarness();
});
after(async () => {
  await h.cleanup();
});

const client = (): Promise<LoomClient> => {
  return LoomClient.connect({ repoRoot: h.repoRoot, sockPath: h.sockPath, autospawn: false });
};

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 1500): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start >= ms) throw new Error("condition not met in time");
    await delay(5);
  }
};

/** Create a worktree-backed `fake` session, run `turns` completed turns, and
 *  (optionally) commit `commitOnTurn`'s file into the worktree before that
 *  turn's `result` so its checkpoint captures a distinct HEAD. */
const setupDrift = async (
  c: LoomClient,
): Promise<{ id: string; wt: string; fs: FakeSession; shaAtTurn1: string }> => {
  const fake = (await h.daemon.providers.get("fake")) as unknown as FakeProvider;
  const s = await c.request<SessionSnapshot>("session.create", {
    prompt: "do work",
    provider: "fake",
  });
  const wt = s.worktree as string;
  await waitFor(() => fake.session(s.id) !== undefined);
  const fs = fake.session(s.id) as FakeSession;

  fs.finishTurn();
  await waitFor(
    async () => (await c.request<SessionSnapshot>("session.get", { id: s.id })).turns === 1,
  );
  const shaAtTurn1 = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  // The agent commits something in its worktree, then turn 2 lands.
  writeFileSync(join(wt, "feature.txt"), "turn-2 work\n");
  execFileSync("git", ["-C", wt, "add", "-A"]);
  execFileSync("git", ["-C", wt, "commit", "-q", "-m", "turn 2 work"]);
  fs.finishTurn();
  await waitFor(
    async () => (await c.request<SessionSnapshot>("session.get", { id: s.id })).turns === 2,
  );

  return { id: s.id, wt, fs, shaAtTurn1 };
};

interface RewindResult extends SessionSnapshot {
  worktreeDrift?: {
    checkpointSha: string;
    currentSha: string;
    dirty: boolean;
    laterCommits: string[];
    restored: boolean;
  };
}

test("session.create gives the session its own worktree + branch off base", async () => {
  const c = await client();
  const s = await c.request<SessionSnapshot>("session.create", {
    prompt: "wire up the metrics endpoint",
    provider: "fake",
  });
  // Both the worktree dir and the branch are named after the session id.
  assert.ok(s.worktree && s.worktree.includes(`/.loom/trees/${s.id.slice(0, 8)}`));
  assert.equal(s.branch, `loom/${s.id.slice(0, 8)}`);
  assert.equal(s.baseBranch, "main");
  assert.ok(existsSync(s.worktree as string));

  const got = await c.request<SessionSnapshot>("session.get", { id: s.id });
  assert.ok(got.git, "git facts should be enriched onto the snapshot");
  assert.equal(got.git?.branch, `loom/${s.id.slice(0, 8)}`);
  assert.equal(got.git?.dirty, false);
  assert.equal(got.git?.aheadOfBase, 0);
  await c.close();
});

test("two sessions from identical prompts get distinct worktrees", async () => {
  const c = await client();
  const a = await c.request<SessionSnapshot>("session.create", {
    prompt: "fix the bug",
    provider: "fake",
  });
  const b = await c.request<SessionSnapshot>("session.create", {
    prompt: "fix the bug",
    provider: "fake",
  });
  assert.notEqual(a.worktree, b.worktree);
  assert.notEqual(a.branch, b.branch);
  await c.close();
});

test("markDone then gc removes the worktree but keeps the row and branch", async () => {
  const c = await client();
  const s = await c.request<SessionSnapshot>("session.create", {
    prompt: "cleanup target",
    provider: "fake",
  });
  const tree = s.worktree as string;

  // gc ignores sessions that aren't done
  let gc = await c.request<{ removed: string[] }>("session.gc");
  assert.ok(!gc.removed.includes(s.id));

  const done = await c.request<SessionSnapshot>("session.markDone", { id: s.id });
  assert.equal(done.status.kind, "done");

  gc = await c.request<{ removed: string[]; failed: unknown[] }>("session.gc", { force: true });
  assert.ok(gc.removed.includes(s.id));
  assert.ok(!existsSync(tree));

  const after = await c.request<SessionSnapshot>("session.get", { id: s.id });
  assert.equal(after.status.kind, "done");
  assert.equal(after.worktree, null);
  assert.equal(after.branch, `loom/${s.id.slice(0, 8)}`); // branch retained
  await c.close();
});

test("session.remove deletes the row + worktree, keeps the branch, pushes session_removed", async () => {
  const c = await client();
  const s = await c.request<SessionSnapshot>("session.create", {
    prompt: "throwaway spike",
    provider: "fake",
  });
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
  const branch = `loom/${s.id.slice(0, 8)}`;
  const branches = execFileSync("git", ["-C", h.repoRoot, "branch", "--list", branch], {
    encoding: "utf8",
  });
  assert.equal(branches.trim(), branch);
  await c.close();
});

test("session.remove --delete-branch also drops the branch", async () => {
  const c = await client();
  const s = await c.request<SessionSnapshot>("session.create", {
    prompt: "branch goes too",
    provider: "fake",
  });
  const tree = s.worktree as string;
  assert.ok(existsSync(tree));

  const r = await c.request<{ removed: string; branchDeleted: boolean }>("session.remove", {
    id: s.id,
    deleteBranch: true,
  });
  assert.equal(r.removed, s.id);
  assert.equal(r.branchDeleted, true);
  assert.ok(!existsSync(tree));

  const branches = execFileSync(
    "git",
    ["-C", h.repoRoot, "branch", "--list", `loom/${s.id.slice(0, 8)}`],
    {
      encoding: "utf8",
    },
  );
  assert.equal(branches.trim(), "", "branch is gone");
  await c.close();
});

test("session.remove on an unknown id is a not_found", async () => {
  const c = await client();
  await assert.rejects(c.request("session.remove", { id: "nope" }), /no such session/);
  await c.close();
});

test("concurrent markDone + remove on one id don't corrupt each other (G13)", async () => {
  const c = await client();
  const s = await c.request<SessionSnapshot>("session.create", {
    prompt: "race target",
    provider: "fake",
  });
  const wt = s.worktree as string;

  // Fire both without awaiting — the lifecycle gate serialises them.
  const done = c.request("session.markDone", { id: s.id }).catch((e: unknown) => e);
  const removed = c.request("session.remove", { id: s.id }).catch((e: unknown) => e);
  await Promise.all([done, removed]);

  // Exactly one outcome: the row is gone, or it's `done` — never a torn state,
  // never an unhandled throw that isn't a clean RpcError.
  const row = await c
    .request<SessionSnapshot | null>("session.get", { id: s.id })
    .catch(() => null);
  if (row) {
    assert.equal(row.status.kind, "done");
  } else {
    assert.ok(!existsSync(wt), "if the row went, so did the worktree");
  }
  await c.close();
});

test("session.remove refuses a dirty worktree unless force is passed (G8)", async () => {
  const c = await client();
  const s = await c.request<SessionSnapshot>("session.create", {
    prompt: "has uncommitted work",
    provider: "fake",
  });
  const wt = s.worktree as string;
  writeFileSync(join(wt, "unsaved.txt"), "work in progress\n");

  await assert.rejects(c.request("session.remove", { id: s.id }), /uncommitted changes/);
  assert.ok(existsSync(wt), "the worktree survives the refused remove");
  assert.ok(await c.request<SessionSnapshot>("session.get", { id: s.id }), "the row survives");

  const r = await c.request<{ removed: string }>("session.remove", { id: s.id, force: true });
  assert.equal(r.removed, s.id);
  assert.ok(!existsSync(wt));
  await c.close();
});

test("undo warns when the worktree has drifted past the rewound turn", async () => {
  const c = await client();
  const frames: PushFrame[] = [];
  c.onPush((f) => frames.push(f));
  const { id, wt } = await setupDrift(c);

  frames.length = 0;
  const r = await c.request<RewindResult>("session.rewind", { id, toTurn: 1 });

  assert.ok(r.worktreeDrift, "the response carries the drift record");
  assert.equal(r.worktreeDrift?.restored, false);
  assert.equal(r.worktreeDrift?.laterCommits.length, 1, "one commit now post-dates the context");
  assert.match(r.worktreeDrift?.laterCommits[0] ?? "", /turn 2 work/);
  assert.ok(
    frames.some(
      (f) => f.type === "notice" && f.tone === "warn" && /worktree is still at/.test(f.text),
    ),
    "a warn notice named the drift",
  );
  // Files are left exactly as they were — undo only moved the model's context.
  assert.ok(existsSync(join(wt, "feature.txt")));
  await c.close();
});

test("undo with restoreWorktree resets the tree to the rewound turn's HEAD", async () => {
  const c = await client();
  const frames: PushFrame[] = [];
  c.onPush((f) => frames.push(f));
  const { id, wt, shaAtTurn1 } = await setupDrift(c);

  frames.length = 0;
  const r = await c.request<RewindResult>("session.rewind", {
    id,
    toTurn: 1,
    restoreWorktree: true,
  });

  assert.equal(r.worktreeDrift?.restored, true);
  assert.equal(
    execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    shaAtTurn1,
    "HEAD is back at the checkpoint SHA",
  );
  assert.ok(!existsSync(join(wt, "feature.txt")), "the later turn's committed file is gone");
  assert.ok(
    frames.some((f) => f.type === "notice" && f.tone === "info" && /worktree reset/.test(f.text)),
  );
  await c.close();
});

test("undo with restoreWorktree refuses a dirty worktree", async () => {
  const c = await client();
  const { id, wt } = await setupDrift(c);
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");

  await assert.rejects(
    c.request("session.rewind", { id, toTurn: 1, restoreWorktree: true }),
    /uncommitted changes/,
  );
  // The undo was refused whole — turn count unchanged.
  assert.equal((await c.request<SessionSnapshot>("session.get", { id })).turns, 2);
  await c.close();
});
