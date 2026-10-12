/**
 * `loom repo move`: after a checkout moves, its per-user state follows it to
 * the new path's keys, and what recorded the old paths is fixed — session rows,
 * Git's worktree links and the worktrees' hooks.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import {
  ensureLoomDirectories,
  loomPaths,
  readRepoRecord,
  worktreeDirectory,
} from "@loom/core/paths";
import { makeLogger } from "@loom/core/logger";
import { openDb } from "@loom/daemon/store/db";
import { WorktreeManager } from "@loom/daemon/daemon/worktrees";
import { sessionCloneRoot } from "../backend/daemon/src/daemon/session-vm-state.ts";
import { repoBaseDirectory } from "../runtime/src/session-vm/repo-base.ts";
import { lockRepository } from "@loom/daemon/daemon/lifecycle";
import { moveRepository } from "../cli/src/repo-move.ts";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const mkRoot = (): string =>
  realpathSync(
    execFileSync("mktemp", ["-d", "/tmp/loom-move-XXXXXX"], { encoding: "utf8" }).trim(),
  );

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

test("loom repo move carries state, session paths, worktree links and hooks to the new path", async () => {
  const root = mkRoot();
  const from = join(root, "old");
  const to = join(root, "new");
  const cleanup: string[] = [root];
  try {
    execFileSync("git", ["init", "-q", "-b", "main", from]);
    git(from, "commit", "-q", "--allow-empty", "-m", "base");
    const old = loomPaths(from);
    ensureLoomDirectories(old);
    const trees = worktreeDirectory(from);
    cleanup.push(trees);
    const tree = new WorktreeManager({
      repoRoot: from,
      treesDir: trees,
      hooksDir: old.hooks,
      baseBranch: "main",
      log: makeLogger("test"),
    }).create("moved");
    const clone = join(sessionCloneRoot(from), "clone-1", "checkout");
    mkdirSync(clone, { recursive: true });
    write(join(old.packageCache, "deno", "marker"), "cached\n");
    write(join(repoBaseDirectory(from), "current.json"), "{}");
    const db = openDb(old.db);
    const insert = db.prepare(
      "INSERT INTO sessions (id, provider, worktree, created_at, updated_at) VALUES (?, 'fake', ?, 0, 0)",
    );
    insert.run("worktree-1", tree.path);
    insert.run("clone-1", clone);
    insert.run("in-place-1", null);
    db.close();

    renameSync(from, to);
    const report = await moveRepository(from, to);
    const moved = loomPaths(to);
    cleanup.push(moved.runtime, moved.state, dirname(moved.packageCache), sessionCloneRoot(to));
    cleanup.push(repoBaseDirectory(to));

    assert.equal(report.from, from);
    assert.equal(report.to, to);
    assert.equal(report.sessionsUpdated, 1);
    assert.equal(report.worktreesRepaired, 1);
    assert.equal(readRepoRecord(moved.record), to);
    for (const gone of [
      old.state,
      dirname(old.packageCache),
      sessionCloneRoot(from),
      repoBaseDirectory(from),
    ])
      assert.equal(existsSync(gone), false, gone);
    assert.equal(readFileSync(join(moved.packageCache, "deno", "marker"), "utf8"), "cached\n");
    assert.ok(existsSync(join(repoBaseDirectory(to), "current.json")));

    const rows = new DatabaseSync(moved.db, { readOnly: true });
    try {
      const worktreeOf = (id: string) =>
        (
          rows.prepare("SELECT worktree FROM sessions WHERE id = ?").get(id) as {
            worktree: string | null;
          }
        ).worktree;
      // Session worktrees stay put; a clone lives in the re-keyed VM state.
      assert.equal(worktreeOf("worktree-1"), tree.path);
      assert.equal(worktreeOf("clone-1"), join(sessionCloneRoot(to), "clone-1", "checkout"));
      assert.equal(worktreeOf("in-place-1"), null);
    } finally {
      rows.close();
    }
    // Git's links both ways, and the push block, follow the repository.
    assert.equal(git(tree.path, "rev-parse", "--git-common-dir"), join(to, ".git"));
    assert.match(git(to, "worktree", "list"), new RegExp(tree.path));
    assert.equal(git(tree.path, "config", "core.hooksPath"), moved.hooks);
    assert.ok(existsSync(join(moved.hooks, "pre-push")));
    assert.ok(report.notes.some((note) => /key their history by working directory/.test(note)));
  } finally {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  }
});

test("loom repo move refuses while a daemon runs for either path", async () => {
  const root = mkRoot();
  const from = join(root, "old");
  const to = join(root, "new");
  try {
    execFileSync("git", ["init", "-q", from]);
    ensureLoomDirectories(loomPaths(from));
    execFileSync("git", ["init", "-q", to]);
    const target = loomPaths(to);
    ensureLoomDirectories(target);
    const held = await lockRepository(target.lock, "live");
    await assert.rejects(moveRepository(from, to), /a Loom daemon \(pid \d+\) is running for/);
    held.release();
    const source = await lockRepository(loomPaths(from).lock, "live");
    await assert.rejects(moveRepository(from, to), /is running for/);
    source.release();
    // Nothing moved.
    assert.ok(existsSync(loomPaths(from).state));
  } finally {
    for (const repo of [from, to]) {
      const paths = loomPaths(repo);
      rmSync(paths.runtime, { recursive: true, force: true });
      rmSync(paths.state, { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("loom repo move refuses a path with no recorded state", async () => {
  const root = mkRoot();
  try {
    execFileSync("git", ["init", "-q", join(root, "new")]);
    await assert.rejects(
      moveRepository(join(root, "never-used"), join(root, "new")),
      /no Loom state is recorded/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loom repo move finds the old state when the old path now leads into the new checkout", async () => {
  // given: a checkout's state, then its parent moved and a symlink left in its place
  const root = mkRoot();
  const from = join(root, "a", "repo");
  const to = join(root, "b", "repo");
  const old = loomPaths(from);
  const cleanup = [root, old.state, old.runtime];
  try {
    execFileSync("git", ["init", "-q", "-b", "main", from]);
    ensureLoomDirectories(old);
    const db = openDb(old.db);
    db.prepare(
      "INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('s1', 'fake', 0, 0)",
    ).run();
    db.close();
    renameSync(join(root, "a"), join(root, "b"));
    symlinkSync(join(root, "b"), join(root, "a"));
    const moved = loomPaths(to);
    cleanup.push(moved.state, moved.runtime);
    assert.notEqual(loomPaths(from).state, old.state, "the old path's key changed");

    // when
    const report = await moveRepository(from, to);

    // then
    assert.equal(report.from, from);
    assert.ok(report.moved.includes(`${old.state} -> ${moved.state}`));
    assert.equal(existsSync(old.state), false);
    assert.equal(readRepoRecord(moved.record), to);
    const rows = new DatabaseSync(moved.db, { readOnly: true });
    try {
      assert.deepEqual(
        rows
          .prepare("SELECT id FROM sessions")
          .all()
          .map((row) => row["id"]),
        ["s1"],
      );
    } finally {
      rows.close();
    }
  } finally {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  }
});

test("loom repo move skips the new checkout's own state that a symlinked old path keys", async () => {
  // given: the moved checkout was opened at its new path before `loom repo move`
  const root = mkRoot();
  const from = join(root, "a", "repo");
  const to = join(root, "b", "repo");
  const old = loomPaths(from);
  const cleanup = [root, old.state, old.runtime];
  try {
    execFileSync("git", ["init", "-q", "-b", "main", from]);
    ensureLoomDirectories(old);
    renameSync(join(root, "a"), join(root, "b"));
    symlinkSync(join(root, "b"), join(root, "a"));
    const moved = loomPaths(to);
    cleanup.push(moved.state, moved.runtime);
    ensureLoomDirectories(moved);
    assert.equal(loomPaths(from).state, moved.state, "the old path keys the new state");

    // when
    const report = await moveRepository(from, to);

    // then
    assert.equal(report.from, from);
    assert.ok(report.moved.includes(`${old.state} -> ${moved.state}`));
    assert.equal(existsSync(old.state), false);
    assert.equal(readRepoRecord(moved.record), to);
  } finally {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  }
});

test("loom repo move finds the old state through a symlink in the old path", async () => {
  // given: a checkout recorded at its real path, moved, and named through a symlinked parent
  const root = mkRoot();
  const from = join(root, "real", "repo");
  const to = join(root, "new", "repo");
  const old = loomPaths(from);
  const cleanup = [root, old.state, old.runtime];
  try {
    execFileSync("git", ["init", "-q", "-b", "main", from]);
    ensureLoomDirectories(old);
    symlinkSync(join(root, "real"), join(root, "link"));
    mkdirSync(join(root, "new"));
    renameSync(from, to);
    const moved = loomPaths(to);
    cleanup.push(moved.state, moved.runtime);

    // when
    const report = await moveRepository(join(root, "link", "repo"), to);

    // then
    assert.equal(report.from, from);
    assert.ok(report.moved.includes(`${old.state} -> ${moved.state}`));
    assert.equal(readRepoRecord(moved.record), to);
  } finally {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  }
});

test("loom repo move refuses a new path that already has sessions", async () => {
  const root = mkRoot();
  const from = join(root, "old");
  const to = join(root, "new");
  const [source, target] = [loomPaths(from), loomPaths(to)];
  try {
    for (const repo of [from, to]) execFileSync("git", ["init", "-q", repo]);
    ensureLoomDirectories(source);
    ensureLoomDirectories(target);
    const db = openDb(target.db);
    db.prepare(
      "INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('s1', 'fake', 0, 0)",
    ).run();
    db.close();
    await assert.rejects(moveRepository(from, to), /already has Loom sessions/);
    assert.ok(existsSync(source.state));
  } finally {
    for (const paths of [source, target]) {
      rmSync(paths.runtime, { recursive: true, force: true });
      rmSync(paths.state, { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
});
