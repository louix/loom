// test-run: own-process — prepends a fake git to PATH and sets the shared-git-dir switch.
// A `git` killed while it holds `index.lock` leaves the worktree locked for every
// later write until someone deletes the file. Loom's commit tool clears such a
// lock when it is old and no live process is using the worktree.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GIT_DIR_SHARED_ENV, clearStaleIndexLock } from "@loom/core/git-lock";
import { commitInWorktree } from "@loom/core/commit";

const OLD_s = Date.now() / 1000 - 600;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "loom-index-lock-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const lock = join(root, ".git", "index.lock");
  return { root, lock, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

/** `git commit -a` holds index.lock while its pre-commit hook runs: a slow hook is a git mid-write. */
const commitInHook = async (root: string, lock: string): Promise<ChildProcess> => {
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nsleep 30\n");
  chmodSync(hook, 0o755);
  writeFileSync(join(root, "a.txt"), "changed\n");
  const child = spawn("git", ["-C", root, "commit", "-q", "-a", "-m", "work"], {
    detached: true,
    stdio: "ignore",
  });
  for (let i = 0; i < 500 && !existsSync(lock); i++) await delay(10);
  assert.ok(existsSync(lock), "git holds index.lock while its hook runs");
  return child;
};

const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) =>
    child.exitCode !== null || child.signalCode !== null
      ? resolve()
      : child.once("exit", () => resolve()),
  );

test("a stale index.lock is removed only when old and unused, and the commit tool recovers", async () => {
  const { root, lock, cleanup } = repo();
  try {
    // A leftover from a killed git.
    const a = await commitInHook(root, lock);
    Deno.kill(-a.pid!, "SIGKILL");
    await exited(a);
    assert.ok(existsSync(lock));

    // Too recent: another git may still be about to finish.
    assert.equal(clearStaleIndexLock(root).kind, "recent");
    assert.ok(existsSync(lock));

    // Old, but a live git is working in this worktree: never removed.
    writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
    const holder = spawn("git", ["-C", root, "hash-object", "--stdin"], {
      cwd: root,
      stdio: ["pipe", "ignore", "ignore"],
    });
    try {
      await delay(100);
      utimesSync(lock, OLD_s, OLD_s);
      const held = clearStaleIndexLock(root);
      assert.equal(held.kind, "held");
      assert.ok(held.kind === "held" && held.pids.includes(holder.pid!));
      assert.ok(existsSync(lock));
    } finally {
      holder.stdin?.end();
      await exited(holder);
    }

    // Old and unused: the commit tool removes it, says so, and commits.
    utimesSync(lock, OLD_s, OLD_s);
    const result = commitInWorktree(root, "after a killed git", { stageAll: true });
    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /removed a stale .*index\.lock \(10 min old/);
    assert.ok(!existsSync(lock));
    assert.equal(git(root, "log", "-1", "--format=%s"), "after a killed git");
  } finally {
    cleanup();
  }
});

/** Run `body` with environment variables set, restoring them afterwards. */
const withEnv = <T>(vars: Record<string, string>, body: () => T): T => {
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(vars)) Deno.env.set(key, value);
  try {
    return body();
  } finally {
    for (const [key, value] of Object.entries(before))
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
  }
};

test("the commit tool retries when the lock's holder finished before the check", () => {
  const { root, lock, cleanup } = repo();
  const bin = mkdtempSync(join(tmpdir(), "loom-git-shim-"));
  try {
    // A git that fails on the lock, whose holder then drops it: the check finds nothing.
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\n'${realGit}' "$@"; s=$?\n[ $s -ne 0 ] && rm -f '${lock}'\nexit $s\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    writeFileSync(lock, "");
    writeFileSync(join(root, "b.txt"), "b\n");
    const result = withEnv({ PATH: `${bin}:${Deno.env.get("PATH") ?? ""}` }, () =>
      commitInWorktree(root, "after the holder finished", { stageAll: true }),
    );
    assert.equal(result.ok, true, result.text);
    assert.equal(git(root, "log", "-1", "--format=%s"), "after the holder finished");
  } finally {
    rmSync(bin, { recursive: true, force: true });
    cleanup();
  }
});

test("an old lock in a worktree shared with the host is reported, not removed", () => {
  const { root, lock, cleanup } = repo();
  try {
    writeFileSync(lock, "");
    utimesSync(lock, OLD_s, OLD_s);
    assert.equal(clearStaleIndexLock(root, { shared: true }).kind, "shared");
    assert.ok(existsSync(lock), "a host git may hold it");

    // A mount-mode VM worker: the commit tool says how to remove it, and leaves it.
    writeFileSync(join(root, "b.txt"), "b\n");
    const shared = withEnv({ [GIT_DIR_SHARED_ENV]: "1" }, () =>
      commitInWorktree(root, "blocked by the host", { stageAll: true }),
    );
    assert.equal(shared.ok, false);
    assert.match(shared.text, /10 min old .*shared with the host/);
    assert.ok(shared.text.includes(`rm '${lock}'`), shared.text);
    assert.ok(existsSync(lock));

    // A local (or private-clone) worker sees every holder: the same lock is removed.
    const local = withEnv({ [GIT_DIR_SHARED_ENV]: "0" }, () =>
      commitInWorktree(root, "local recovery", { stageAll: true }),
    );
    assert.equal(local.ok, true, local.text);
    assert.match(local.text, /removed a stale .*index\.lock/);
    assert.ok(!existsSync(lock));
  } finally {
    cleanup();
  }
});

test("the commit tool leaves a recent lock alone and says why", async () => {
  const { root, lock, cleanup } = repo();
  try {
    writeFileSync(lock, "");
    writeFileSync(join(root, "b.txt"), "b\n");
    const result = commitInWorktree(root, "blocked", { stageAll: true });
    assert.equal(result.ok, false);
    assert.match(result.text, /git add failed: .*index\.lock': File exists/);
    assert.match(result.text, /another git command is probably still running here/);
    assert.ok(existsSync(lock), "a fresh lock is left alone");
  } finally {
    cleanup();
  }
});
