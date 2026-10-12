// A git killed while it holds a session worktree's index.lock leaves the lock
// in the worktree's own gitdir (`.git` is a file there). Startup hygiene clears
// it in the worktree directory and in the legacy `<repo>/.loom/trees`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@loom/daemon/store/db";
import { ChildStore } from "@loom/daemon/store/sessions";
import { Registry } from "@loom/daemon/daemon/registry";
import { runStartupHygiene } from "@loom/daemon/daemon/hygiene";
import { loomPaths } from "@loom/core/paths";
import { makeLogger, setLogLevel } from "@loom/core/logger";

setLogLevel("error");

const OLD_s = Date.now() / 1000 - 600;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();

const lockOf = (tree: string): string =>
  git(tree, "rev-parse", "--path-format=absolute", "--git-path", "index.lock");

test("startup hygiene clears old index locks in current and legacy worktrees, not recent or VM-mounted ones", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-hygiene-locks-"));
  const repo = join(root, "repo");
  const env = { HOME: root, XDG_RUNTIME_DIR: "/nonexistent-run", XDG_STATE_HOME: join(root, "st") };
  const db = openDb(join(root, "loom.db"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git(
      repo,
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "base",
    );
    const paths = loomPaths(repo, join(root, "trees"), env);
    const current = join(paths.trees, "current");
    const legacy = join(paths.legacy.dir, "trees", "legacy");
    const recent = join(paths.trees, "recent");
    const mounted = join(paths.trees, "mounted");
    for (const [tree, branch] of [
      [current, "a"],
      [legacy, "b"],
      [recent, "c"],
      [mounted, "d"],
    ] as const)
      git(repo, "worktree", "add", "-q", "-b", branch, tree);
    const locks = {
      current: lockOf(current),
      legacy: lockOf(legacy),
      recent: lockOf(recent),
      mounted: lockOf(mounted),
    };
    assert.notEqual(
      locks.current,
      join(current, ".git", "index.lock"),
      "a linked worktree's lock is in its gitdir",
    );
    for (const lock of Object.values(locks)) writeFileSync(lock, "");
    utimesSync(locks.current, OLD_s, OLD_s);
    utimesSync(locks.legacy, OLD_s, OLD_s);
    utimesSync(locks.mounted, OLD_s, OLD_s);

    const report = runStartupHygiene({
      paths,
      registry: new Registry(db, makeLogger("test")),
      children: new ChildStore(db),
      epoch: "now",
      vmWorktrees: new Set([mounted]),
      log: makeLogger("test"),
    });

    assert.deepEqual(report.clearedLocks.toSorted(), [locks.current, locks.legacy].toSorted());
    assert.equal(existsSync(locks.current), false);
    assert.equal(existsSync(locks.legacy), false);
    assert.equal(existsSync(locks.recent), true, "a recent lock may belong to a running git");
    assert.equal(existsSync(locks.mounted), true, "a git in a still-running VM may hold it");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
