import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoRoot, loomPaths } from "@loom/core/paths";
import { WorktreeManager } from "@loom/daemon/daemon/worktrees";
import { makeLogger } from "@loom/core/logger";
import { loadConfig } from "@loom/daemon/config/config";

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
    const bare = join(root, ".bare");
    git("clone", "--bare", checkout, bare);
    const bareLinked = join(root, "bare-linked");
    git("-C", bare, "worktree", "add", "--detach", bareLinked);
    const alias = join(root, "alias");
    symlinkSync(bareLinked, alias);
    for (const repo of [checkout, linked, bare, bareLinked, alias]) {
      const expected = [bare, bareLinked, alias].includes(repo) ? bare : repo;
      assert.equal(findRepoRoot(repo), expected);
      const nested = join(repo, "nested", "directory");
      mkdirSync(nested, { recursive: true });
      assert.equal(findRepoRoot(nested), expected);
      assert.deepEqual(loomPaths(findRepoRoot(nested)), loomPaths(expected));
    }
    // Independent nested repositories retain their own identity.
    const independent = join(bareLinked, "independent");
    git("init", "-q", independent);
    assert.equal(findRepoRoot(independent), independent);

    const config = join(root, "config.jsonc");
    for (const configured of [bare, bareLinked, alias, join(bareLinked, "nested")]) {
      writeFileSync(
        config,
        `{
  "repos": [
    {
      "path": ${JSON.stringify(configured)},
      "base_branch": "shared"
    }
  ]
}`,
      );
      for (const launch of [bare, bareLinked, alias])
        assert.equal(loadConfig(launch, config).baseBranch, "shared");
      assert.equal(loadConfig(independent, config).baseBranch, "main");
    }
    writeFileSync(
      config,
      `{
  "repos": [
    {
      "path": ${JSON.stringify(bare)}
    },
    {
      "path": ${JSON.stringify(bareLinked)}
    }
  ]
}`,
    );
    assert.throws(() => loadConfig(bare, config), /Duplicate repos.path/);

    // Migration moves core.bare into config.worktree. Identity must survive it,
    // including discovery from Loom's own generated worktrees.
    const paths = loomPaths(bare);
    const manager = new WorktreeManager({
      repoRoot: bare,
      treesDir: paths.trees,
      hooksDir: join(paths.dir, "hooks"),
      baseBranch: "main",
      log: makeLogger("test"),
    });
    const session = manager.create("identity");
    for (const launch of [bare, bareLinked, alias, session.path])
      assert.equal(findRepoRoot(launch), bare);
    assert.throws(() => findRepoRoot(root), /not inside a git repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
