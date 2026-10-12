import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  ensureLoomDirectories,
  findRepoRoot,
  loomPaths,
  readRepoRecord,
  worktreeDirectory,
} from "@loom/core/paths";
import { WorktreeManager } from "@loom/daemon/daemon/worktrees";
import { makeLogger } from "@loom/core/logger";
import { loadConfig } from "@loom/daemon/config/config";
import { removeLoomDirectories } from "../harness/src/loom-directories.ts";

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
      assert.equal(loadConfig(independent, config).baseBranch, undefined);
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
    const paths = loomPaths(bare, join(root, "trees"));
    const manager = new WorktreeManager({
      repoRoot: bare,
      treesDir: paths.trees,
      hooksDir: paths.hooks,
      baseBranch: "main",
      log: makeLogger("test"),
    });
    const session = manager.create("identity");
    for (const launch of [bare, bareLinked, alias, session.path])
      assert.equal(findRepoRoot(launch), bare);
    assert.throws(() => findRepoRoot(root), /not inside a git repository/);
  } finally {
    removeLoomDirectories(loomPaths(join(root, ".bare"), join(root, "trees")));
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree directories use persistent XDG storage with distinct canonical repository identities", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loom-tree-paths-")));
  try {
    const repo = join(root, "one", "project");
    const other = join(root, "two", "project");
    const alias = join(root, "alias");
    mkdirSync(repo, { recursive: true });
    mkdirSync(other, { recursive: true });
    symlinkSync(repo, alias);
    const env = { HOME: join(root, "home"), XDG_DATA_HOME: join(root, "data") };
    const path = worktreeDirectory(repo, "", env);
    assert.ok(path.startsWith(join(env.XDG_DATA_HOME, "loom", "worktrees", "project-")));
    assert.equal(worktreeDirectory(alias, "", env), path);
    assert.notEqual(worktreeDirectory(other, "", env), path);
    const fallback = worktreeDirectory(repo, "", { HOME: env.HOME });
    assert.ok(fallback.startsWith(join(env.HOME, ".local", "share", "loom", "worktrees") + "/"));
    assert.equal(
      worktreeDirectory(repo, "", { HOME: env.HOME, XDG_DATA_HOME: "relative" }),
      fallback,
    );
    assert.equal(worktreeDirectory(repo, "", { HOME: env.HOME, XDG_DATA_HOME: "" }), fallback);
    assert.equal(worktreeDirectory(repo, "/mnt/ssd/trees", env), "/mnt/ssd/trees");
    assert.equal(worktreeDirectory(repo, "~/trees", env), join(env.HOME, "trees"));
    assert.equal(worktreeDirectory(repo, ".loom/trees", env), join(repo, ".loom", "trees"));
    assert.equal(loomPaths(repo, "/mnt/ssd/trees").trees, "/mnt/ssd/trees");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loomPaths keys runtime, state and cache directories by repository", () => {
  const root = realpathSync(mkdtempSync("/tmp/loom-run-paths-"));
  try {
    const repo = join(root, "project");
    mkdirSync(repo);
    const key = basename(worktreeDirectory(repo, "", { HOME: root }));
    const xdg = loomPaths(repo, "", {
      HOME: root,
      XDG_RUNTIME_DIR: join(root, "run"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
    });
    assert.equal(xdg.runtime, join(root, "run", "loom", key));
    assert.equal(xdg.sock, join(xdg.runtime, "daemon.sock"));
    const state = join(root, "state", "loom", "repos", key);
    // Not in the runtime directory, which may be under /tmp (macOS clean-up).
    assert.equal(xdg.lock, join(state, "daemon.lock"));
    assert.deepEqual(
      [xdg.state, xdg.record, xdg.db, xdg.log, xdg.startupLog, xdg.tuiLog, xdg.tuiState, xdg.hooks],
      [
        state,
        join(state, "repo.json"),
        join(state, "loom.db"),
        join(state, "daemon.log"),
        join(state, "daemon-startup.log"),
        join(state, "tui.log"),
        join(state, "tui.json"),
        join(state, "hooks"),
      ],
    );
    assert.equal(xdg.packageCache, join(root, "cache", "loom", key, "package-cache"));
    assert.deepEqual(xdg.legacy, {
      dir: join(repo, ".loom"),
      sock: join(repo, ".loom", "daemon.sock"),
      pid: join(repo, ".loom", "daemon.pid"),
    });
    // Nothing of Loom's own is in the checkout any more.
    for (const path of Object.values(xdg))
      if (typeof path === "string" && path !== repo) assert.ok(!path.startsWith(repo + "/"), path);
    // macOS has no XDG_RUNTIME_DIR; a relative one is ignored like any XDG variable.
    for (const env of [{ HOME: root }, { HOME: root, XDG_RUNTIME_DIR: "run" }])
      assert.equal(loomPaths(repo, "", env).runtime, join(`/tmp/loom-${Deno.uid()}`, key));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loomPaths refuses a socket path over the sun_path limit", () => {
  const repo = join(tmpdir(), "project");
  const long = join("/tmp", "x".repeat(80));
  assert.throws(
    () => loomPaths(repo, "", { HOME: tmpdir(), XDG_RUNTIME_DIR: long }),
    /Unix socket limit\. Set XDG_RUNTIME_DIR to a shorter directory/,
  );
  // The repository's own path length never matters: its key is bounded.
  const deep = join(tmpdir(), "y".repeat(200), "z".repeat(200));
  assert.ok(loomPaths(deep, "", { HOME: tmpdir(), XDG_RUNTIME_DIR: "/run/user/1000" }).sock);
});

test("ensureLoomDirectories refuses a runtime base other users can enter", () => {
  const root = realpathSync(mkdtempSync("/tmp/loom-run-shared-"));
  try {
    const repo = join(root, "project");
    mkdirSync(repo);
    const paths = loomPaths(repo, "", { HOME: root, XDG_RUNTIME_DIR: root });
    mkdirSync(dirname(paths.runtime), { mode: 0o755 });
    chmodSync(dirname(paths.runtime), 0o755);
    assert.throws(
      () => ensureLoomDirectories(paths),
      /must be a directory owned by this user with mode 0700/,
    );
    chmodSync(dirname(paths.runtime), 0o700);
    ensureLoomDirectories(paths);
    assert.equal(statSync(paths.runtime).mode & 0o777, 0o700);
    assert.equal(statSync(paths.state).mode & 0o777, 0o700);
    // The state directory records its repository, for `loom repo move`.
    assert.equal(readRepoRecord(paths.record), repo);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
