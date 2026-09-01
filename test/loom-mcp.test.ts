import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLoomMcpServer, commitInWorktree } from "@loom/connector-claude/loom-mcp";

const repo = (): { root: string; git: (...a: string[]) => string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "loom-mcp-"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git("config", "user.email", "loom+claude@localhost");
  git("config", "user.name", "Loom (claude)");
  git("config", "commit.gpgsign", "false");
  git("commit", "-q", "--allow-empty", "-m", "base");
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

test("commitInWorktree stages everything and reports the new commit", () => {
  const { root, git, cleanup } = repo();
  try {
    writeFileSync(join(root, "a.txt"), "hello\n");
    const res = commitInWorktree(root, "Add a.txt", { stageAll: true });
    assert.equal(res.ok, true);
    assert.match(res.text, /^committed [0-9a-f]{7,} Add a\.txt/);
    assert.match(res.text, /a\.txt/); // diffstat line
    assert.equal(git("log", "-1", "--format=%s"), "Add a.txt");
    assert.equal(git("log", "-1", "--format=%an"), "Loom (claude)");
    assert.equal(res.sha, git("rev-parse", "--short", "HEAD"));
  } finally {
    cleanup();
  }
});

test("commitInWorktree refuses when there is nothing to commit", () => {
  const { root, cleanup } = repo();
  try {
    const res = commitInWorktree(root, "nothing here", { stageAll: true });
    assert.equal(res.ok, false);
    assert.match(res.text, /nothing to commit/);
  } finally {
    cleanup();
  }
});

test("commitInWorktree with stageAll:false only commits what is already staged", () => {
  const { root, git, cleanup } = repo();
  try {
    writeFileSync(join(root, "staged.txt"), "in\n");
    writeFileSync(join(root, "loose.txt"), "out\n");
    git("add", "staged.txt");
    const res = commitInWorktree(root, "Only the staged file", { stageAll: false });
    assert.equal(res.ok, true);
    const files = git("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);
    assert.deepEqual(files, ["staged.txt"]);
    assert.equal(git("status", "--porcelain"), "?? loose.txt");
  } finally {
    cleanup();
  }
});

test("commitInWorktree rejects an empty message before touching git", () => {
  const { root, git, cleanup } = repo();
  try {
    const before = git("rev-parse", "HEAD");
    const res = commitInWorktree(root, "   ", { stageAll: true });
    assert.equal(res.ok, false);
    assert.match(res.text, /message is empty/);
    assert.equal(git("rev-parse", "HEAD"), before);
  } finally {
    cleanup();
  }
});

test("buildLoomMcpServer exposes an in-process sdk server named loom", async () => {
  const asked: string[] = [];
  const server = buildLoomMcpServer({
    cwd: "/tmp",
    askUser: async (q) => {
      asked.push(q);
      return "the answer";
    },
  });
  assert.equal(server.type, "sdk");
  assert.equal(server.name, "loom");
  assert.ok(server.instance, "carries a live McpServer instance");
});

test("buildLoomMcpServer accepts a base branch for the status tool", () => {
  const server = buildLoomMcpServer({
    cwd: "/tmp",
    base: "main",
    askUser: async (q) => q,
  });
  assert.equal(server.type, "sdk");
  assert.equal(server.name, "loom");
});
