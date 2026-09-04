import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loomInstructions } from "@loom/core/paths";
import { systemPromptAppendFor } from "@loom/daemon/daemon/prompt";

const tmpRepo = (): string => mkdtempSync(join(tmpdir(), "loom-md-"));

const writeLoomMd = (dir: string, text: string): void => {
  mkdirSync(join(dir, ".loom"), { recursive: true });
  writeFileSync(join(dir, ".loom", "LOOM.md"), text);
};

test("loomInstructions returns null when there is no file", () => {
  assert.equal(loomInstructions(tmpRepo()), null);
});

test("loomInstructions returns null for an empty or whitespace-only file", () => {
  const dir = tmpRepo();
  writeLoomMd(dir, "   \n\n  \n");
  assert.equal(loomInstructions(dir), null);
});

test("loomInstructions frames the trimmed content", () => {
  const dir = tmpRepo();
  writeLoomMd(dir, "\n# House rules\n\n- typecheck with `pnpm typecheck`\n");
  const md = loomInstructions(dir);
  assert.ok(md?.startsWith("# Repository instructions (.loom/LOOM.md)\n\n# House rules"));
  assert.ok(md?.endsWith("- typecheck with `pnpm typecheck`"));
});

test("a claude append is the tool steer followed by the repo's LOOM.md", () => {
  const repoRoot = tmpRepo();
  const cwd = tmpRepo(); // a fresh worktree: branched from base, file not committed there
  writeLoomMd(cwd, "typecheck with `pnpm typecheck`");
  const md = systemPromptAppendFor(false, true, cwd, repoRoot);
  assert.ok(md.startsWith("This session runs under Loom"));
  assert.ok(md.includes("typecheck with `pnpm typecheck`"));
  assert.ok(md.indexOf("This session runs under Loom") < md.indexOf("typecheck with"));
});

test("an uncommitted LOOM.md falls back to the repoRoot checkout", () => {
  const repoRoot = tmpRepo();
  const cwd = tmpRepo();
  writeLoomMd(repoRoot, "start with `pnpm init`");
  assert.ok(systemPromptAppendFor(false, true, cwd, repoRoot).includes("start with `pnpm init`"));
});

test("a worktree's own LOOM.md wins over the repoRoot copy", () => {
  const repoRoot = tmpRepo();
  const cwd = tmpRepo();
  writeLoomMd(repoRoot, "repoRoot copy");
  writeLoomMd(cwd, "worktree copy");
  const md = systemPromptAppendFor(false, true, cwd, repoRoot);
  assert.ok(md.includes("worktree copy"));
  assert.ok(!md.includes("repoRoot copy"));
});

test("with no LOOM.md anywhere the append matches the previous prompts", () => {
  const repoRoot = tmpRepo();
  const cwd = tmpRepo();
  // claude: the steer, unchanged
  assert.ok(
    systemPromptAppendFor(false, true, cwd, repoRoot).startsWith("This session runs under Loom"),
  );
  // aisdk with MCP: base prompt, then the steer
  const withMcp = systemPromptAppendFor(true, true, cwd, repoRoot);
  assert.ok(withMcp.startsWith("You are a coding agent"));
  assert.ok(withMcp.includes("This session runs under Loom"));
  // aisdk without MCP: base prompt only
  const noMcp = systemPromptAppendFor(true, false, cwd, repoRoot);
  assert.ok(noMcp.startsWith("You are a coding agent"));
  assert.ok(!noMcp.includes("This session runs under Loom"));
});

test("the steer names the session's checkout root for absolute-path tools", () => {
  const repoRoot = tmpRepo();
  const cwd = tmpRepo();
  const md = systemPromptAppendFor(false, true, cwd, repoRoot);
  assert.ok(md.includes(cwd));
  // dropped together with the steer for aisdk sessions without MCP servers
  assert.ok(!systemPromptAppendFor(true, false, cwd, repoRoot).includes(cwd));
});

test("the steer warns that a path outside the worktree is a different tree", () => {
  const repoRoot = tmpRepo();
  const cwd = tmpRepo();
  const md = systemPromptAppendFor(false, true, cwd, repoRoot);
  assert.match(md, /stays inside the worktree/);
  assert.match(md, /writes never reach your branch/);
});
