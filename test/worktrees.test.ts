import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager, slugify } from "@loom/daemon/daemon/worktrees";
import { setLogLevel, makeLogger } from "@loom/core/logger";
import { writeExecutableSync } from "../scripts/lib/executable-fixture.ts";

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

const LOOM = { branchPrefix: ["loom"] };

/** A stand-in session id whose first 8 chars are `short` — the branch a
 *  worktree gets is `<prefix>/<first 8 chars of the id>`. */
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

test("create makes a worktree + branch off base with a push block and no pinned identity", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);
    assert.equal(wt.slug, "aaaaaaaa"); // dir is named after the session id
    assert.equal(wt.branch, "loom/aaaaaaaa"); // branch is named after the session id
    assert.equal(wt.baseRef, "main");
    assert.ok(existsSync(wt.path));

    const cfg = (path: string, k: string) =>
      execFileSync("git", ["-C", path, "config", "--worktree", k], { encoding: "utf8" }).trim();
    assert.equal(cfg(wt.path, "core.hooksPath"), Deno.realPathSync(join(root, ".loom", "hooks")));
    // Identity is the session environment's; the user's own commits keep theirs.
    assert.throws(() => cfg(wt.path, "user.name"));
    assert.throws(() => cfg(wt.path, "user.email"));
    assert.equal(
      execFileSync("git", ["-C", wt.path, "config", "user.name"], { encoding: "utf8" }).trim(),
      "t",
    );

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

test("clearLegacyIdentity drops only the old Loom identity, and only in a session tree", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);
    const git = (path: string, ...a: string[]) =>
      execFileSync("git", ["-C", path, ...a], { encoding: "utf8" }).trim();
    // What older versions pinned in every session tree.
    git(wt.path, "config", "--worktree", "user.name", "Loom (openai/gpt-5:free)");
    git(wt.path, "config", "--worktree", "user.email", "loom+openai-gpt-5-free@localhost");
    m.clearLegacyIdentity(wt.path);
    assert.throws(() => git(wt.path, "config", "--worktree", "user.name"));
    assert.throws(() => git(wt.path, "config", "--worktree", "user.email"));
    assert.equal(git(wt.path, "config", "user.name"), "t");
    assert.ok(git(wt.path, "config", "core.hooksPath").endsWith(join(".loom", "hooks")));
    // A user's deliberate per-tree identity is not Loom's to remove.
    git(wt.path, "config", "--worktree", "user.name", "Someone");
    m.clearLegacyIdentity(wt.path);
    assert.equal(git(wt.path, "config", "--worktree", "user.name"), "Someone");
    // The main checkout's per-worktree config is the user's own.
    git(root, "config", "--worktree", "user.name", "Loom");
    m.clearLegacyIdentity(root);
    assert.equal(git(root, "config", "--worktree", "user.name"), "Loom");
  } finally {
    if (existsSync(root)) cleanup();
  }
});

test("colliding id prefixes get distinct dirs", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const a = m.create(fakeId("aaaaaaaa"), LOOM);
    const b = m.create(fakeId("aaaaaaaa"), LOOM);
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
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);
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
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);

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

test("advisory facts yield, share pending probes, and respect invalidation", async () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const expected = mgr(root).facts(root, "main");
    const pending = m.factsAsync(root, "main");
    assert.equal(m.factsAsync(root, "main"), pending);
    assert.equal(m.cachedFacts(root), null, "Git must not finish synchronously");
    let yielded = false;
    const timer = setTimeout(() => {
      yielded = true;
    }, 0);
    assert.deepEqual(await pending, expected);
    clearTimeout(timer);
    assert(yielded, "timers run while advisory Git commands are in flight");

    m.invalidateFacts(root);
    const obsolete = m.factsAsync(root, "main");
    m.invalidateFacts(root);
    await obsolete;
    assert.equal(m.cachedFacts(root), null, "an invalidated probe cannot refill the cache");
    writeFileSync(join(root, "dirty.txt"), "changed");
    assert.equal((await m.factsAsync(root, "main"))?.dirty, true);
    assert.deepEqual(await m.factsAsync(root, "missing-base"), m.cachedFacts(root));
    m.invalidateFacts(root);
    assert.equal((await m.factsAsync(root, "missing-base"))?.aheadOfBase, 0);
  } finally {
    cleanup();
  }
});

test("renameBranch rebrands loom/<id> from a title, keeping the tree dir", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);
    assert.equal(wt.branch, "loom/aaaaaaaa");

    assert.equal(
      m.renameBranch('"Add OAuth login flow"', wt.branch, LOOM.branchPrefix),
      "loom/add-oauth-login-flow",
    );

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
    const a = m.create(fakeId("aaaaaaaa"), LOOM);
    const b = m.create(fakeId("bbbbbbbb"), LOOM);

    assert.equal(m.renameBranch("Same Title", a.branch, LOOM.branchPrefix), "loom/same-title");
    assert.match(
      m.renameBranch("Same Title", b.branch, LOOM.branchPrefix),
      /^loom\/same-title-[0-9a-f]{6}$/,
    );
    // already `loom/<slug>` for this title → left alone
    assert.equal(
      m.renameBranch("same title", "loom/same-title", LOOM.branchPrefix),
      "loom/same-title",
    );
    execFileSync("git", ["-C", root, "rev-parse", "--verify", "loom/same-title"]);
  } finally {
    cleanup();
  }
});

test("a nested branch prefix names generic, renamed and clone branches under it", () => {
  const { root, cleanup } = repo();
  try {
    // given
    const m = mgr(root);
    const prefix = { branchPrefix: ["me", "x"] };
    // when
    const wt = m.create(fakeId("aaaaaaaa"), prefix);
    const renamed = m.renameBranch("Add OAuth login flow", wt.branch, prefix.branchPrefix);
    const clone = m.createBranch(fakeId("bbbbbbbb"), prefix);
    // then
    assert.equal(wt.branch, "me/x/aaaaaaaa");
    assert.equal(renamed, "me/x/add-oauth-login-flow");
    assert.equal(clone.branch, "me/x/bbbbbbbb");
    assert.equal(
      execFileSync("git", ["-C", wt.path, "symbolic-ref", "--short", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      "me/x/add-oauth-login-flow",
    );
  } finally {
    cleanup();
  }
});

test("no branch prefix names bare branches and suffixes a slug that is taken", () => {
  const { root, cleanup } = repo();
  try {
    // given
    const m = mgr(root);
    const none = { branchPrefix: [] };
    execFileSync("git", ["-C", root, "branch", "same-title"]);
    // when
    const a = m.create(fakeId("aaaaaaaa"), none);
    const b = m.create(fakeId("bbbbbbbb"), none);
    const clone = m.createBranch(fakeId("cccccccc"), none);
    // then
    assert.equal(a.branch, "aaaaaaaa");
    assert.equal(b.branch, "bbbbbbbb");
    assert.equal(clone.branch, "cccccccc");
    assert.equal(m.renameBranch("Add OAuth login flow", a.branch, []), "add-oauth-login-flow");
    assert.match(m.renameBranch("Same Title", b.branch, []), /^same-title-[0-9a-f]{6}$/);
    assert.equal(m.renameBranch("same title", "same-title", []), "same-title");
  } finally {
    cleanup();
  }
});

test("no branch prefix leaves a user's branch named like a session's short id alone", () => {
  const { root, cleanup } = repo();
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  try {
    // given
    const m = mgr(root);
    git("commit", "-q", "--allow-empty", "-m", "user work");
    git("branch", "aaaaaaaa");
    git("reset", "-q", "--hard", "HEAD~1");
    const userTip = git("rev-parse", "aaaaaaaa");
    // when
    const wt = m.create(fakeId("aaaaaaaa"), { branchPrefix: [] });
    m.remove(wt.path, { force: true });
    m.deleteBranch(wt.branch);
    // then
    assert.equal(wt.branch, fakeId("aaaaaaaa"));
    assert.equal(git("rev-parse", "aaaaaaaa"), userTip);
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
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);
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
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);
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

test("syncOntoBase: replayed and merge commits carry the session's identity", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const identity = {
      GIT_AUTHOR_NAME: "Session Author",
      GIT_AUTHOR_EMAIL: "author@example.com",
      GIT_COMMITTER_NAME: "Session Committer",
      GIT_COMMITTER_EMAIL: "committer@example.com",
    };
    const log = (path: string, rev: string) =>
      execFileSync("git", ["-C", path, "log", "-1", "--format=%an <%ae>|%cn <%ce>", rev], {
        encoding: "utf8",
      }).trim();
    for (const mode of ["rebase", "merge"] as const) {
      const wt = m.create(fakeId(mode === "rebase" ? "aaaaaaaa" : "bbbbbbbb"), LOOM);
      writeFileSync(join(wt.path, `${mode}.txt`), "mine");
      execFileSync("git", ["-C", wt.path, "add", "-A"]);
      execFileSync("git", ["-C", wt.path, "commit", "-q", "-m", "branch work"]);
      advanceMain(root, `${mode}-base.txt`, "theirs");
      assert.equal(m.syncOntoBase(wt.path, "main", mode, identity).outcome, "updated");
      // A rebase keeps the original author; the merge commit is wholly the session's.
      assert.equal(
        log(wt.path, "HEAD"),
        mode === "rebase"
          ? "t <t@example.com>|Session Committer <committer@example.com>"
          : "Session Author <author@example.com>|Session Committer <committer@example.com>",
      );
    }
  } finally {
    cleanup();
  }
});

test("syncOntoBase: leaves the tree untouched on a conflict", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);
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
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);
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
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);
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
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);
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
    writeExecutableSync(hookPath, `#!/bin/sh\ntouch "${marker}"\n`, 0o755);

    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);

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
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);
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

test("a prune that cannot see a session tree, as from another session's VM, keeps it", () => {
  const { root, cleanup } = repo();
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  try {
    const m = mgr(root);
    const own = m.create(fakeId("aaaaaaaa"), LOOM);
    const other = m.create(fakeId("bbbbbbbb"), LOOM);
    const plain = join(root, ".loom", "plain");
    git(root, "worktree", "add", "-q", plain, "-b", "plain");
    const admin = (path: string) => git(path, "rev-parse", "--path-format=absolute", "--git-dir");
    const otherAdmin = admin(other.path);
    const plainAdmin = admin(plain);
    // The VM mounts `own` alone: every other tree's directory is missing there.
    for (const path of [other.path, plain]) renameSync(path, `${path}.hidden`);
    git(own.path, "worktree", "prune");
    for (const path of [other.path, plain]) renameSync(`${path}.hidden`, path);

    assert.ok(existsSync(otherAdmin));
    assert.equal(git(other.path, "rev-parse", "--abbrev-ref", "HEAD"), other.branch);
    assert.ok(!existsSync(plainAdmin), "an unlocked tree is pruned");
  } finally {
    cleanup();
  }
});

test("Loom removes and prunes its locked trees, but leaves a user's lock alone", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const locked = (path: string) => m.list().find((w) => w.path === path)?.locked;
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);
    assert.equal(locked(wt.path), `loom session ${fakeId("aaaaaaaa")}`);
    writeFileSync(join(wt.path, "uncommitted.txt"), "x");
    assert.throws(() => m.remove(wt.path), /git worktree remove failed/);
    assert.equal(locked(wt.path), `loom session ${fakeId("aaaaaaaa")}`, "locked again");
    m.remove(wt.path, { force: true });
    assert.ok(!existsSync(wt.path));

    // A tree deleted on the host is pruned, so its branch can come back.
    const gone = m.reattach(fakeId("aaaaaaaa"), wt.branch);
    rmSync(gone.path, { recursive: true, force: true });
    assert.equal(m.prune(), true);
    assert.equal(locked(gone.path), undefined);
    const back = m.reattach(fakeId("aaaaaaaa"), wt.branch);
    assert.ok(existsSync(back.path));

    const user = m.create(fakeId("cccccccc"), LOOM);
    execFileSync("git", ["-C", root, "worktree", "unlock", user.path]);
    execFileSync("git", ["-C", root, "worktree", "lock", "--reason", "on a USB disk", user.path]);
    assert.throws(() => m.remove(user.path, { force: true }), /locked/);
    rmSync(user.path, { recursive: true, force: true });
    m.prune();
    assert.equal(locked(user.path), "on a USB disk");
  } finally {
    cleanup();
  }
});

test("prune keeps the lock of a tree the host cannot see, as against one that is gone", () => {
  const { root, cleanup } = repo();
  const trees = join(root, ".loom", "trees");
  try {
    const m = mgr(root);
    const locked = (path: string) => m.list().find((w) => w.path === path)?.locked;
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);
    const reason = `loom session ${fakeId("aaaaaaaa")}`;
    // Unreadable, as behind macOS privacy protections: lstat fails EACCES.
    chmodSync(trees, 0o000);
    try {
      m.prune();
    } finally {
      chmodSync(trees, 0o755);
    }
    assert.equal(locked(wt.path), reason);
    // Its whole volume unmounted: the parent is missing too.
    renameSync(trees, `${trees}.unmounted`);
    try {
      m.prune();
    } finally {
      renameSync(`${trees}.unmounted`, trees);
    }
    assert.equal(locked(wt.path), reason);
    rmSync(wt.path, { recursive: true, force: true });
    m.prune();
    assert.equal(locked(wt.path), undefined, "a tree deleted from its directory is pruned");
  } finally {
    cleanup();
  }
});

test("Loom locks, finds and removes its trees through a symlinked trees directory", () => {
  const { root, cleanup } = repo();
  try {
    // Git records each tree's realpath; Loom names it through the link.
    const real = join(root, "real-trees");
    mkdirSync(real);
    symlinkSync(real, join(root, "trees"));
    const m = new WorktreeManager({
      repoRoot: root,
      treesDir: join(root, "trees"),
      hooksDir: join(root, ".loom", "hooks"),
      baseBranch: "main",
      log: makeLogger("test"),
    });
    const lockOf = (path: string) =>
      m.list().find((w) => w.path === Deno.realPathSync(path))?.locked;
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);
    assert.ok(wt.path.startsWith(join(root, "trees") + "/"));
    assert.equal(lockOf(wt.path), `loom session ${fakeId("aaaaaaaa")}`);
    m.remove(wt.path, { force: true });
    assert.ok(!existsSync(wt.path));

    // As startup hygiene finds a tree made before Loom locked them.
    const old = m.create(fakeId("bbbbbbbb"), LOOM);
    execFileSync("git", ["-C", root, "worktree", "unlock", old.path]);
    assert.equal(m.lock([{ id: fakeId("bbbbbbbb"), path: old.path }]), 1);
    assert.equal(lockOf(old.path), `loom session ${fakeId("bbbbbbbb")}`);
  } finally {
    cleanup();
  }
});

test("relink rebuilds a tree's pruned metadata and keeps its uncommitted work", () => {
  const { root, cleanup } = repo();
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  try {
    const m = mgr(root);
    const id = fakeId("aaaaaaaa");
    const wt = m.create(id, LOOM);
    writeFileSync(join(wt.path, "tracked.txt"), "committed\n");
    git(wt.path, "add", "tracked.txt");
    git(wt.path, "commit", "-q", "-m", "tracked");
    writeFileSync(join(wt.path, "tracked.txt"), "edited\n");
    writeFileSync(join(wt.path, "staged.txt"), "staged\n");
    git(wt.path, "add", "staged.txt");
    writeFileSync(join(wt.path, "untracked.txt"), "untracked\n");
    // As an older Loom left it: unlocked, then pruned where it was not visible.
    git(root, "worktree", "unlock", wt.path);
    renameSync(wt.path, `${wt.path}.hidden`);
    git(root, "worktree", "prune");
    renameSync(`${wt.path}.hidden`, wt.path);
    assert.throws(() => git(wt.path, "status"), /not a git repository/);

    assert.deepEqual(m.relink(id, wt.path, wt.branch), { kind: "relinked" });

    assert.equal(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD"), wt.branch);
    assert.equal(
      execFileSync("git", ["-C", wt.path, "status", "--porcelain"], { encoding: "utf8" }),
      " M tracked.txt\n?? staged.txt\n?? untracked.txt\n",
    );
    assert.equal(m.list().find((w) => w.path === wt.path)?.locked, `loom session ${id}`);
    assert.equal(
      git(wt.path, "config", "--worktree", "core.hooksPath"),
      Deno.realPathSync(join(root, ".loom", "hooks")),
    );
    assert.deepEqual(m.relink(id, wt.path, wt.branch), { kind: "intact" });
  } finally {
    cleanup();
  }
});

test("relink refuses a branch checked out elsewhere and writes nothing", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("aaaaaaaa"), LOOM);
    const admin = execFileSync(
      "git",
      ["-C", wt.path, "rev-parse", "--path-format=absolute", "--git-dir"],
      { encoding: "utf8" },
    ).trim();
    rmSync(admin, { recursive: true });
    const other = m.create(fakeId("bbbbbbbb"), LOOM);

    const result = m.relink(fakeId("aaaaaaaa"), wt.path, other.branch);

    assert.equal(result.kind, "refused");
    assert.ok(!existsSync(admin));
  } finally {
    cleanup();
  }
});

test("fork copies staged, unstaged, binary, deleted and untracked files without changing parent", () => {
  const { root, cleanup } = repo();
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args]);
  try {
    const m = mgr(root);
    const parent = m.create("parent", LOOM);
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
    const fork = m.create("fork", { ...LOOM, baseRef: m.headSha(parent.path)! });
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
    const fork = m.create("in-place-fork", LOOM);
    m.copyChanges(root, fork.path);
    assert.equal(Deno.readTextFileSync(join(fork.path, "untracked")), "keep me");
    assert.equal(existsSync(join(fork.path, ".loom")), false);
  } finally {
    cleanup();
  }
});

for (const layout of [
  "bare",
  "bare-enabled",
  "bare-linked",
  "linked",
  "linked-core-worktree",
] as const) {
  test(`create and reattach from ${layout} preserve the repository and existing worktrees`, () => {
    const { root, cleanup } = repo();
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
    try {
      let main = root;
      if (layout.startsWith("bare")) {
        main = join(root, "bare.git");
        git(root, "clone", "--bare", root, main);
        git(main, "config", "user.name", "t");
        git(main, "config", "user.email", "t@example.com");
      }
      if (layout === "linked-core-worktree") git(main, "config", "core.worktree", "..");
      const linked = join(root, "existing");
      git(main, "worktree", "add", "--detach", linked);
      if (layout === "bare-enabled") git(main, "config", "extensions.worktreeConfig", "true");
      const source = layout === "bare" || layout === "bare-enabled" ? main : linked;
      const m = mgr(source);
      const wt = m.create(fakeId("cccccccc"), LOOM);
      assert.equal(git(wt.path, "rev-parse", "--show-toplevel"), wt.path);
      assert.equal(git(wt.path, "status", "--porcelain"), "");
      assert.equal(git(linked, "rev-parse", "--show-toplevel"), Deno.realPathSync(linked));
      assert.equal(
        git(main, "rev-parse", "--is-bare-repository"),
        String(layout.startsWith("bare")),
      );
      if (!layout.startsWith("bare"))
        assert.equal(git(main, "rev-parse", "--show-toplevel"), Deno.realPathSync(main));
      assert.equal(git(linked, "config", "user.name"), "t");
      assert.equal(git(main, "config", "user.name"), "t");
      writeFileSync(join(wt.path, "created.txt"), "session work\n");
      git(wt.path, "add", "created.txt");
      git(wt.path, "-c", "commit.gpgsign=false", "commit", "-qm", "session commit");
      // No pinned tree identity: the repository's own applies outside a session.
      assert.equal(git(wt.path, "log", "-1", "--format=%an"), "t");
      m.remove(wt.path);
      const restored = mgr(source).reattach(fakeId("dddddddd"), wt.branch);
      assert.ok(existsSync(join(restored.path, "created.txt")));
      assert.equal(git(restored.path, "status", "--porcelain"), "");
      m.remove(restored.path);
    } finally {
      cleanup();
    }
  });
}

test("failed config migration preserves main checkout settings and can be retried", () => {
  const { root, cleanup } = repo();
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git("config", "core.worktree", "..");
    const lock = join(root, ".git", "config.worktree.lock");
    writeFileSync(lock, "locked");
    const m = mgr(root);
    assert.throws(() => m.create("blocked1", LOOM), /git config migration failed/);
    assert.equal(git("config", "--local", "core.worktree"), "..");
    assert.equal(git("rev-parse", "--show-toplevel"), Deno.realPathSync(root));
    assert.equal(existsSync(join(root, ".loom", "trees", "blocked1")), false);
    rmSync(lock);
    const wt = m.create("retried1", LOOM);
    assert.equal(git("rev-parse", "--show-toplevel"), Deno.realPathSync(root));
    assert.equal(m.facts(wt.path, "main")?.dirty, false);
  } finally {
    cleanup();
  }
});

test("async removal preserves dirty trees unless forced and keeps the branch", async () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create(fakeId("async123"), LOOM);
    writeFileSync(join(wt.path, "uncommitted.txt"), "keep until forced");
    await assert.rejects(m.removeAsync(wt.path), /git worktree remove failed/);
    assert.equal(
      m.list().find((w) => w.path === wt.path)?.locked,
      `loom session ${fakeId("async123")}`,
      "a failed removal puts the lock back",
    );
    assert.ok(existsSync(join(wt.path, "uncommitted.txt")));
    await m.removeAsync(wt.path, { force: true });
    assert.equal(existsSync(wt.path), false);
    execFileSync("git", ["-C", root, "rev-parse", "--verify", wt.branch]);
    const restored = m.reattach(fakeId("async123"), wt.branch);
    assert.ok(existsSync(restored.path));
  } finally {
    cleanup();
  }
});

test("a clone session gets a branch and ref facts without a worktree", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const made = m.createBranch(fakeId("dddddddd"), LOOM);
    assert.deepEqual(made, { branch: "loom/dddddddd", baseRef: "main" });
    assert.equal(m.list().length, 1, "no worktree was added");
    assert.equal(m.branchHead(made.branch), m.branchHead("main"));
    assert.equal(m.branchHead("loom/missing"), null);
    assert.throws(
      () => m.createBranch(fakeId("eeeeeeee"), { ...LOOM, baseRef: "nope" }),
      /does not resolve/,
    );

    // The guest publishes by pushing; stand in for that by moving the ref on the host.
    execFileSync("git", ["-C", root, "commit", "-q", "--allow-empty", "-m", "on main"]);
    const tip = execFileSync(
      "git",
      ["-C", root, "commit-tree", "-p", made.branch, "-m", "from guest", "HEAD^{tree}"],
      { encoding: "utf8" },
    ).trim();
    execFileSync("git", ["-C", root, "update-ref", `refs/heads/${made.branch}`, tip]);
    assert.deepEqual(m.refFacts(made.branch, "main"), {
      branch: made.branch,
      commits: 2,
      aheadOfBase: 1,
      behindBase: 1,
      dirty: false,
      lastCommitSubject: "from guest",
    });
    assert.equal(m.refFacts("loom/missing", "main"), null);
  } finally {
    cleanup();
  }
});

test("host Git refuses to open a session clone, even one that redirects Git", async () => {
  const { root, cleanup } = repo();
  const cloneRoot = mkdtempSync(join(tmpdir(), "loom-clones-"));
  try {
    const clone = join(cloneRoot, "session", "checkout");
    mkdirSync(clone, { recursive: true });
    const marker = join(cloneRoot, "ran-on-host");
    // What an agent could leave behind: a repository whose config runs a command.
    execFileSync("git", ["init", "-q", clone]);
    execFileSync("git", ["-C", clone, "config", "core.fsmonitor", `touch ${marker}; false`]);
    const m = new WorktreeManager({
      repoRoot: root,
      treesDir: join(root, ".loom", "trees"),
      hooksDir: join(root, ".loom", "hooks"),
      baseBranch: "main",
      cloneRoot,
      log: makeLogger("test"),
    });
    assert.equal(m.isClone(clone), true);
    assert.equal(m.isClone(root), false);
    for (const probe of [
      () => m.isDirty(clone),
      () => m.headSha(clone),
      () => m.facts(clone, "main"),
      () => m.pendingGitOp(clone),
      () => m.restoreTo(clone, "HEAD"),
      () => m.syncOntoBase(clone, "main", "rebase"),
      () => m.clearLegacyIdentity(clone),
      () => m.remove(clone, { force: true }),
      () => m.copyChanges(clone, root),
    ])
      assert.throws(probe, /must not open a session clone/);
    await assert.rejects(m.removeAsync(clone, { force: true }), /must not open a session clone/);
    assert.equal(await m.factsAsync(clone, "main"), null);
    assert.ok(!existsSync(marker), "the clone's config ran on the host");
  } finally {
    rmSync(cloneRoot, { recursive: true, force: true });
    cleanup();
  }
});
