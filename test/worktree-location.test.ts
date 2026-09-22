import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeHarness } from "@loom/harness";
import { LoomClient } from "@loom/client";
import type { SessionSnapshot } from "@loom/core/wire";

test("changing worktree_dir preserves existing sessions and uses the new directory after restart", async () => {
  const h = await makeHarness({
    config: '{"worktree_dir":".loom/trees","session":{"titles":{"enabled":false}}}',
  });
  let client = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  try {
    const old = await client.request<SessionSnapshot>("session.create", {
      prompt: "old",
      provider: "fake",
    });
    assert.ok(old.worktree?.startsWith(join(h.repoRoot, ".loom", "trees") + "/"));
    writeFileSync(join(old.worktree!, "unfinished.txt"), "keep this work");
    await client.close();
    writeFileSync(h.configPath, '{"session":{"titles":{"enabled":false}}}');
    await h.restart();
    client = await LoomClient.connect({
      repoRoot: h.repoRoot,
      sockPath: h.sockPath,
      autospawn: false,
    });
    const saved = await client.request<SessionSnapshot>("session.get", { id: old.id });
    assert.equal(saved.worktree, old.worktree);
    assert.ok(existsSync(join(saved.worktree!, "unfinished.txt")));
    const fresh = await client.request<SessionSnapshot>("session.create", {
      prompt: "new",
      provider: "fake",
    });
    assert.ok(fresh.worktree?.startsWith(h.daemon.paths.trees + "/"));
    assert.ok(!fresh.worktree!.startsWith(h.repoRoot + "/"));
    await client.request("session.remove", { id: old.id, force: true });
    await client.request("session.remove", { id: fresh.id, force: true });
    assert.ok(!existsSync(old.worktree!));
    assert.ok(!existsSync(fresh.worktree!));
  } finally {
    await client.close();
    await h.cleanup();
  }
});
