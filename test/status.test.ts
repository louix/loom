import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusInWorktree } from "@loom/core/status";

const repo = (): { root: string; git: (...a: string[]) => string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "loom-status-"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git("config", "user.email", "loom+status@localhost");
  git("config", "user.name", "Loom (status)");
  git("config", "commit.gpgsign", "false");
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

test("statusInWorktree reports a clean worktree without counts when in sync", () => {
  const { root, git, cleanup } = repo();
  try {
    git("commit", "-q", "--allow-empty", "-m", "base");
    const res = statusInWorktree(root, { base: "main" });
    assert.equal(res.ok, true);
    assert.equal(res.text, `## main\nworktree: ${root}\nworktree clean`);
  } finally {
    cleanup();
  }
});

test("statusInWorktree lists staged, unstaged and untracked entries with a diffstat", () => {
  const { root, git, cleanup } = repo();
  try {
    writeFileSync(join(root, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(root, "staged.txt"), "s\n");
    git("add", "staged.txt");
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");
    writeFileSync(join(root, "untracked.txt"), "u\n");
    const res = statusInWorktree(root);
    assert.equal(res.ok, true);
    assert.match(res.text, /^## main$/m);
    assert.match(res.text, /^A  staged\.txt$/m);
    assert.match(res.text, /^ M a\.txt$/m);
    assert.match(res.text, /^\?\? untracked\.txt$/m);
    assert.match(res.text, /2 files changed, \+2$/m);
    // without `patch` there is no diff section
    assert.ok(!res.text.includes("diff --git"));
  } finally {
    cleanup();
  }
});

test("statusInWorktree patch mode includes the diff but not untracked files", () => {
  const { root, git, cleanup } = repo();
  try {
    writeFileSync(join(root, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");
    writeFileSync(join(root, "untracked.txt"), "u\n");
    const res = statusInWorktree(root, { patch: true });
    assert.equal(res.ok, true);
    assert.match(res.text, /diff --git a\/a\.txt b\/a\.txt/);
    assert.match(res.text, /^\+two$/m);
    assert.match(res.text, /^\?\? untracked\.txt$/m);
    assert.ok(!res.text.includes("diff --git a/untracked.txt"));
  } finally {
    cleanup();
  }
});

test("statusInWorktree counts ahead/behind vs the base branch", () => {
  const { root, git, cleanup } = repo();
  try {
    git("commit", "-q", "--allow-empty", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    git("commit", "-q", "--allow-empty", "-m", "f1");
    git("commit", "-q", "--allow-empty", "-m", "f2");
    git("checkout", "-q", "main");
    git("commit", "-q", "--allow-empty", "-m", "m1");
    git("checkout", "-q", "feature");
    const res = statusInWorktree(root, { base: "main" });
    assert.equal(res.ok, true);
    assert.equal(res.text, `## feature [+2 -1 vs main]\nworktree: ${root}\nworktree clean`);
  } finally {
    cleanup();
  }
});

test("statusInWorktree skips counts for an unknown base ref", () => {
  const { root, git, cleanup } = repo();
  try {
    git("commit", "-q", "--allow-empty", "-m", "base");
    const res = statusInWorktree(root, { base: "no-such-branch" });
    assert.equal(res.ok, true);
    assert.doesNotMatch(res.text, /vs /);
    assert.equal(res.text, `## main\nworktree: ${root}\nworktree clean`);
  } finally {
    cleanup();
  }
});

test("statusInWorktree names the commit on a detached HEAD", () => {
  const { root, git, cleanup } = repo();
  try {
    git("commit", "-q", "--allow-empty", "-m", "base");
    git("checkout", "-q", "--detach");
    const sha = git("rev-parse", "--short", "HEAD");
    const res = statusInWorktree(root);
    assert.equal(res.text, `## HEAD ${sha}\nworktree: ${root}\nworktree clean`);
  } finally {
    cleanup();
  }
});

test("statusInWorktree reports a non-repository", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-status-nogit-"));
  try {
    const res = statusInWorktree(root);
    assert.equal(res.ok, false);
    assert.match(res.text, /^not a git repository: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("statusInWorktree clamps a huge patch", () => {
  const { root, git, cleanup } = repo();
  try {
    writeFileSync(join(root, "big.txt"), `${"a".repeat(150_000)}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(root, "big.txt"), `${"a".repeat(150_000)}\n${"b".repeat(200_000)}\n`);
    const res = statusInWorktree(root, { patch: true });
    assert.equal(res.ok, true);
    assert.match(res.text, /\[diff truncated\]/);
    assert.ok(Buffer.byteLength(res.text, "utf8") < 140_000);
  } finally {
    cleanup();
  }
});
