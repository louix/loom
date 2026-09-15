import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoRoot } from "@loom/core/paths";

test("repository discovery handles checkouts, linked worktrees, and bare repositories", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loom-paths-")));
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  try {
    const checkout = join(root, "checkout");
    git("init", "-q", "-b", "main", checkout);
    git(
      "-C",
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "base",
    );
    const linked = join(root, "linked");
    git("-C", checkout, "worktree", "add", "--detach", linked);
    const bare = join(root, "bare.git");
    git("clone", "--bare", checkout, bare);
    const bareLinked = join(root, "bare-linked");
    git("-C", bare, "worktree", "add", "--detach", bareLinked);
    for (const repo of [checkout, linked, bare, bareLinked]) {
      assert.equal(findRepoRoot(repo), repo);
      const nested = join(repo, "nested", "directory");
      mkdirSync(nested, { recursive: true });
      assert.equal(findRepoRoot(nested), repo);
    }
    assert.throws(() => findRepoRoot(root), /not inside a git repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
