import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager, slugify } from "@loom/daemon/daemon/worktrees";
import { setLogLevel, makeLogger } from "@loom/core/logger";

setLogLevel("error");

const repo = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "loom-wt-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a]);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("commit", "-q", "--allow-empty", "-m", "base");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

const mgr = (root: string): WorktreeManager => {
  return new WorktreeManager({
    repoRoot: root,
    treesDir: join(root, ".loom", "trees"),
    hooksDir: join(root, ".loom", "hooks"),
    baseBranch: "main",
    log: makeLogger("test"),
  });
};

/** A stand-in session id whose first 8 chars are `short` — the branch a
 *  worktree gets is `loom/<first 8 chars of the id>`. */
const fakeId = (short: string): string => {
  assert.equal(short.length, 8, "fakeId prefix must be 8 chars");
  return `${short}-1111-2222-3333-444444444444`;
};

test("slugify keeps it short, kebab, and never empty", () => {
  assert.equal(slugify("Refactor the Auth Module!!!"), "refactor-the-auth-module");
  assert.equal(slugify("  a---b  "), "a-b");
  assert.equal(slugify("補完 123"), "123");
  assert.equal(slugify("!!!"), "session");
  assert.equal(slugify("one two three four five six seven").split("-").length, 5);
});

test("create makes a worktree + branch off base, with identity and a push block", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"), { model: "claude-sonnet-5" });
    assert.equal(wt.slug, "aaaaaaaa"); // dir is named after the session id
    assert.equal(wt.branch, "loom/aaaaaaaa"); // branch is named after the session id
    assert.equal(wt.baseRef, "main");
    assert.ok(existsSync(wt.path));

    const cfg = (path: string, k: string) =>
      execFileSync("git", ["-C", path, "config", "--worktree", k], { encoding: "utf8" }).trim();
    assert.equal(cfg(wt.path, "user.name"), "Loom (claude-sonnet-5)");
    assert.equal(cfg(wt.path, "user.email"), "loom+claude-sonnet-5@localhost");
    assert.equal(cfg(wt.path, "core.hooksPath"), join(root, ".loom", "hooks"));
    // no model → the bare fallback identity
    const bare = m.create(fakeId("bbbbbbbb"));
    assert.equal(cfg(bare.path, "user.name"), "Loom");
    assert.equal(cfg(bare.path, "user.email"), "loom@localhost");

    const hook = join(root, ".loom", "hooks", "pre-push");
    assert.ok(existsSync(hook));
    assert.doesNotThrow(() => accessSync(hook, constants.X_OK));

    // the branch exists in the repo
    execFileSync("git", ["-C", root, "rev-parse", "--verify", "loom/aaaaaaaa"]);
    cleanup();
  } finally {
    if (existsSync(root)) cleanup();
  }
});

test("setIdentity re-points the commit identity after a model switch", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"), { model: "claude-sonnet-5" });
    m.setIdentity(wt.path, "claude-haiku-4-5-20251001");
    const cfg = (k: string) =>
      execFileSync("git", ["-C", wt.path, "config", "--worktree", k], { encoding: "utf8" }).trim();
    assert.equal(cfg("user.name"), "Loom (claude-haiku-4-5-20251001)");
    assert.equal(cfg("user.email"), "loom+claude-haiku-4-5-20251001@localhost");
    // The name keeps the model id verbatim; the address is flattened for git.
    m.setIdentity(wt.path, "openai/gpt-5:free");
    assert.equal(cfg("user.name"), "Loom (openai/gpt-5:free)");
    assert.equal(cfg("user.email"), "loom+openai-gpt-5-free@localhost");
  } finally {
    if (existsSync(root)) cleanup();
  }
});

test("colliding id prefixes get distinct dirs", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const a = m.create(fakeId("aaaaaaaa"));
    const b = m.create(fakeId("aaaaaaaa"));
    assert.notEqual(a.slug, b.slug);
    assert.equal(a.slug, "aaaaaaaa");
    assert.match(b.slug, /^aaaaaaaa-[0-9a-z]+$/);
  } finally {
    cleanup();
  }
});

test("the pre-push hook rejects a push", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"));
    const bare = mkdtempSync(join(tmpdir(), "loom-bare-"));
    try {
      execFileSync("git", ["init", "-q", "--bare", bare]);
      execFileSync("git", ["-C", wt.path, "remote", "add", "origin", bare]);
      let blocked = false;
      try {
        execFileSync("git", ["-C", wt.path, "push", "origin", "HEAD"], { stdio: "pipe" });
      } catch (err) {
        blocked = true;
        assert.match(String((err as { stderr?: Buffer }).stderr ?? ""), /push is blocked/);
      }
      assert.ok(blocked, "push should have been rejected by the hook");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

test("facts report branch, commits, ahead/behind, dirty, last subject", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"));

    let f = m.facts(wt.path, "main");
    assert.ok(f);
    assert.equal(f.branch, "loom/aaaaaaaa");
    assert.equal(f.aheadOfBase, 0);
    assert.equal(f.dirty, false);

    writeFileSync(join(wt.path, "new.txt"), "hi");
    // dirty is cached briefly; a fresh manager avoids the TTL window
    f = mgr(root).facts(wt.path, "main");
    assert.equal(f?.dirty, true);

    execFileSync("git", ["-C", wt.path, "add", "-A"]);
    execFileSync("git", ["-C", wt.path, "commit", "-q", "-m", "add new.txt"]);
    f = mgr(root).facts(wt.path, "main");
    assert.equal(f?.aheadOfBase, 1);
    assert.equal(f?.behindBase, 0);
    assert.equal(f?.lastCommitSubject, "add new.txt");
    assert.equal(f?.dirty, false);
  } finally {
    cleanup();
  }
});

test("renameBranch rebrands loom/<id> from a title, keeping the tree dir", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"));
    assert.equal(wt.branch, "loom/aaaaaaaa");

    assert.equal(m.renameBranch('"Add OAuth login flow"', wt.branch), "loom/add-oauth-login-flow");

    // new ref exists, old is gone, the worktree's HEAD followed, dir unchanged
    execFileSync("git", ["-C", root, "rev-parse", "--verify", "loom/add-oauth-login-flow"]);
    assert.throws(() =>
      execFileSync("git", ["-C", root, "rev-parse", "--verify", "loom/aaaaaaaa"], {
        stdio: "pipe",
      }),
    );
    assert.equal(
      execFileSync("git", ["-C", wt.path, "symbolic-ref", "--short", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      "loom/add-oauth-login-flow",
    );
    assert.ok(existsSync(wt.path));
  } finally {
    cleanup();
  }
});

test("renameBranch suffixes on a name clash and no-ops when the slug already matches", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const a = m.create(fakeId("aaaaaaaa"));
    const b = m.create(fakeId("bbbbbbbb"));

    assert.equal(m.renameBranch("Same Title", a.branch), "loom/same-title");
    assert.match(m.renameBranch("Same Title", b.branch), /^loom\/same-title-[0-9a-f]{6}$/);
    // already `loom/<slug>` for this title → left alone
    assert.equal(m.renameBranch("same title", "loom/same-title"), "loom/same-title");
    execFileSync("git", ["-C", root, "rev-parse", "--verify", "loom/same-title"]);
  } finally {
    cleanup();
  }
});

// --- syncOntoBase --------------------------------------------------------

/** Advance `main` (checked out in `root`) with a commit touching `file`. */
const advanceMain = (root: string, file: string, body: string): void => {
  writeFileSync(join(root, file), body);
  execFileSync("git", ["-C", root, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", `main: ${file}`], { stdio: "pipe" });
};

test("syncOntoBase: no-base when the base ref is unknown, current when nothing to do", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"));
    assert.equal(m.syncOntoBase(wt.path, "nope/missing", "rebase").outcome, "no-base");
    assert.equal(m.syncOntoBase(wt.path, "main", "rebase").outcome, "current");
  } finally {
    cleanup();
  }
});

test("syncOntoBase: replays the branch onto an advanced base", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"));
    writeFileSync(join(wt.path, "branch.txt"), "mine");
    execFileSync("git", ["-C", wt.path, "add", "-A"]);
    execFileSync("git", ["-C", wt.path, "commit", "-q", "-m", "branch work"]);

    advanceMain(root, "base.txt", "theirs");

    const res = m.syncOntoBase(wt.path, "main", "rebase");
    assert.equal(res.outcome, "updated");
    assert.equal(res.outcome === "updated" && res.behind, 1);
    // the branch now carries both commits, linearly
    assert.ok(existsSync(join(wt.path, "base.txt")));
    assert.ok(existsSync(join(wt.path, "branch.txt")));
    assert.equal(mgr(root).facts(wt.path, "main")?.behindBase, 0);
  } finally {
    cleanup();
  }
});

test("syncOntoBase: leaves the tree untouched on a conflict", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"));
    writeFileSync(join(wt.path, "clash.txt"), "branch side");
    execFileSync("git", ["-C", wt.path, "add", "-A"]);
    execFileSync("git", ["-C", wt.path, "commit", "-q", "-m", "branch clash"]);
    const before = execFileSync("git", ["-C", wt.path, "rev-parse", "HEAD"], { encoding: "utf8" });

    advanceMain(root, "clash.txt", "base side");

    const res = m.syncOntoBase(wt.path, "main", "rebase");
    assert.equal(res.outcome, "conflict");
    // HEAD is back where it was, no rebase left in progress, tree clean
    assert.equal(
      execFileSync("git", ["-C", wt.path, "rev-parse", "HEAD"], { encoding: "utf8" }),
      before,
    );
    assert.equal(
      execFileSync("git", ["-C", wt.path, "status", "--porcelain"], { encoding: "utf8" }).trim(),
      "",
    );
    assert.ok(!existsSync(join(wt.path, ".git", "rebase-merge")));
  } finally {
    cleanup();
  }
});

test("syncOntoBase: skips a dirty worktree", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"));
    advanceMain(root, "base.txt", "theirs");
    writeFileSync(join(wt.path, "wip.txt"), "uncommitted");

    const res = m.syncOntoBase(wt.path, "main", "rebase");
    assert.equal(res.outcome, "dirty");
    assert.equal(res.outcome === "dirty" && res.behind, 1);
    assert.ok(!existsSync(join(wt.path, "base.txt"))); // untouched
  } finally {
    cleanup();
  }
});

test("syncOntoBase: mode 'merge' brings the base in as a merge commit", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"));
    writeFileSync(join(wt.path, "branch.txt"), "mine");
    execFileSync("git", ["-C", wt.path, "add", "-A"]);
    execFileSync("git", ["-C", wt.path, "commit", "-q", "-m", "branch work"]);

    advanceMain(root, "base.txt", "theirs");

    const res = m.syncOntoBase(wt.path, "main", "merge");
    assert.equal(res.outcome, "updated");
    assert.ok(existsSync(join(wt.path, "base.txt")));
    // a merge commit has two parents
    const parents = execFileSync(
      "git",
      ["-C", wt.path, "rev-list", "--parents", "-n", "1", "HEAD"],
      {
        encoding: "utf8",
      },
    )
      .trim()
      .split(/\s+/);
    assert.equal(parents.length, 3);
  } finally {
    cleanup();
  }
});

test("syncOntoBase: bails 'busy' when the agent has its own rebase in progress (G1)", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"));
    // The agent's own branch has a commit that will clash with an interactive
    // rebase it starts and then pauses at a conflict.
    writeFileSync(join(wt.path, "clash.txt"), "agent side\n");
    execFileSync("git", ["-C", wt.path, "add", "-A"]);
    execFileSync("git", ["-C", wt.path, "commit", "-q", "-m", "agent work"]);
    advanceMain(root, "clash.txt", "base side\n");
    // Start a rebase onto main that stops on the conflict → leaves rebase-merge/.
    try {
      execFileSync("git", ["-C", wt.path, "rebase", "main"], { stdio: "pipe" });
    } catch {
      // expected — the rebase halts with a conflict
    }
    // A linked worktree's rebase state lives under the main repo's gitdir.
    const rel = execFileSync("git", ["-C", wt.path, "rev-parse", "--git-path", "rebase-merge"], {
      encoding: "utf8",
    }).trim();
    const rebaseDir = rel.startsWith("/") ? rel : join(wt.path, rel);
    assert.ok(existsSync(rebaseDir), "a rebase is mid-flight");
    const beforeStatus = execFileSync("git", ["-C", wt.path, "status", "--porcelain"], {
      encoding: "utf8",
    });

    const res = m.syncOntoBase(wt.path, "main", "rebase");
    assert.equal(res.outcome, "busy");
    assert.equal(res.outcome === "busy" && res.op, "rebase-merge");
    // Loom didn't touch the agent's in-progress rebase.
    assert.ok(existsSync(rebaseDir));
    assert.equal(
      execFileSync("git", ["-C", wt.path, "status", "--porcelain"], { encoding: "utf8" }),
      beforeStatus,
    );
  } finally {
    cleanup();
  }
});

test("a worktree still runs the repo's own pre-commit hook (G12)", () => {
  const { root, cleanup } = repo();
  try {
    // The repo has its own pre-commit that stamps a marker.
    const marker = join(root, "pre-commit-ran");
    const hookPath = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(hookPath, 0o755);

    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"));

    writeFileSync(join(wt.path, "f.txt"), "x\n");
    execFileSync("git", ["-C", wt.path, "add", "-A"]);
    execFileSync("git", ["-C", wt.path, "commit", "-q", "-m", "in the worktree"]);

    assert.ok(existsSync(marker), "the repo's pre-commit fired inside the session worktree");
    // Loom's own push block is still in place.
    assert.ok(existsSync(join(root, ".loom", "hooks", "pre-push")));
  } finally {
    cleanup();
  }
});

test("remove drops the worktree", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"));
    assert.ok(m.list().some((w) => w.path === wt.path));
    m.remove(wt.path, { force: true });
    assert.ok(!m.list().some((w) => w.path === wt.path));
    assert.ok(!existsSync(wt.path));
    // branch is retained
    execFileSync("git", ["-C", root, "rev-parse", "--verify", "loom/aaaaaaaa"]);
  } finally {
    cleanup();
  }
});

test("fork copies staged, unstaged, binary, deleted and untracked files without changing parent", () => {
  const { root, cleanup } = repo();
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args]);
  try {
    const m = mgr(root);
    const parent = m.create("parent");
    writeFileSync(join(parent.path, "file"), "base\n");
    writeFileSync(join(parent.path, "deleted"), "base\n");
    git(parent.path, "add", ".");
    git(parent.path, "commit", "-qm", "files");
    writeFileSync(join(parent.path, "file"), "staged\n");
    writeFileSync(join(parent.path, "binary"), new Uint8Array([0, 1, 255]));
    git(parent.path, "add", ".");
    writeFileSync(join(parent.path, "file"), "unstaged\n");
    rmSync(join(parent.path, "deleted"));
    writeFileSync(join(parent.path, "untracked"), "new\n");
    const status = git(parent.path, "status", "--porcelain").toString();
    const fork = m.create("fork", { baseRef: m.headSha(parent.path)! });
    m.copyChanges(parent.path, fork.path);
    assert.equal(git(fork.path, "status", "--porcelain").toString(), status);
    assert.deepEqual(git(fork.path, "diff", "--binary"), git(parent.path, "diff", "--binary"));
    assert.deepEqual(
      git(fork.path, "diff", "--binary", "--cached"),
      git(parent.path, "diff", "--binary", "--cached"),
    );
    assert.equal(Deno.readTextFileSync(join(fork.path, "untracked")), "new\n");
    assert.equal(git(parent.path, "status", "--porcelain").toString(), status);
  } finally {
    cleanup();
  }
});

test("forking in-place changes omits Loom runtime state even if not gitignored", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    writeFileSync(join(root, "untracked"), "keep me");
    const fork = m.create("in-place-fork");
    m.copyChanges(root, fork.path);
    assert.equal(Deno.readTextFileSync(join(fork.path, "untracked")), "keep me");
    assert.equal(existsSync(join(fork.path, ".loom")), false);
  } finally {
    cleanup();
  }
});
