import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const wt = m.create("add a json flag", fakeId("aaaaaaaa"));
    assert.equal(wt.slug, "add-a-json-flag"); // dir still uses the readable slug
    assert.equal(wt.branch, "loom/aaaaaaaa"); // branch is named after the session id
    assert.equal(wt.baseRef, "main");
    assert.ok(existsSync(wt.path));

    const cfg = (k: string) =>
      execFileSync("git", ["-C", wt.path, "config", "--worktree", k], { encoding: "utf8" }).trim();
    assert.equal(cfg("user.name"), "Loom (claude)");
    assert.equal(cfg("user.email"), "loom+claude@localhost");
    assert.equal(cfg("core.hooksPath"), join(root, ".loom", "hooks"));

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

test("colliding hints get distinct slugs", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const a = m.create("same name", fakeId("aaaaaaaa"));
    const b = m.create("same name", fakeId("bbbbbbbb"));
    assert.notEqual(a.slug, b.slug);
    assert.equal(a.slug, "same-name");
    assert.match(b.slug, /^same-name-[0-9a-z]+$/);
  } finally {
    cleanup();
  }
});

test("the pre-push hook rejects a push", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create("push test", fakeId("aaaaaaaa"));
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
    const wt = m.create("facts", fakeId("aaaaaaaa"));

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

test("remove drops the worktree", () => {
  const { root, cleanup } = repo();
  try {
    const m = mgr(root);
    const wt = m.create("removable", fakeId("aaaaaaaa"));
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
