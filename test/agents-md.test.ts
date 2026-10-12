/**
 * The repository's AGENTS.md reaches every provider exactly once: Codex reads
 * it itself, Claude Code reads it itself unless a CLAUDE.md takes precedence
 * (https://code.claude.com/docs/en/memory#agents-md), and the AI SDK engine
 * reads no instruction files, so Loom adds it to the system prompt.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { repoInstructionsFor, systemPromptAppendFor } from "@loom/daemon/daemon/prompt";

const tmpRepo = (): string => mkdtempSync(join(tmpdir(), "loom-agents-md-"));

const mkRepo = (files: Record<string, string>): string => {
  const dir = tmpRepo();
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
};

const AGENTS = "\n# House rules\n\n- typecheck with `pnpm typecheck`\n";

describe("repoInstructionsFor", () => {
  test("no AGENTS.md, or an empty one, gives no instructions", () => {
    for (const reader of ["claude", "codex", "aisdk"] as const) {
      assert.equal(repoInstructionsFor(reader, tmpRepo(), ["project"]), null);
      assert.equal(
        repoInstructionsFor(reader, mkRepo({ "AGENTS.md": "  \n\n " }), ["project"]),
        null,
      );
    }
  });

  test("aisdk gets the trimmed AGENTS.md, framed", () => {
    const md = repoInstructionsFor("aisdk", mkRepo({ "AGENTS.md": AGENTS }));
    assert.equal(
      md,
      "# Repository instructions (AGENTS.md)\n\n# House rules\n\n- typecheck with `pnpm typecheck`",
    );
  });

  test("codex reads AGENTS.md itself", () => {
    assert.equal(repoInstructionsFor("codex", mkRepo({ "AGENTS.md": AGENTS })), null);
  });

  test("claude with project settings and no CLAUDE.md reads AGENTS.md itself", () => {
    const dir = mkRepo({ "AGENTS.md": AGENTS });
    assert.equal(repoInstructionsFor("claude", dir, ["project"]), null);
    // A resume passes no settingSources: Claude loads every source.
    assert.equal(repoInstructionsFor("claude", dir, undefined), null);
  });

  test("claude without project settings reads no instruction files", () => {
    const dir = mkRepo({ "AGENTS.md": AGENTS });
    assert.match(repoInstructionsFor("claude", dir, []) ?? "", /typecheck with/);
  });

  test("claude with a CLAUDE.md that does not import AGENTS.md gets it from Loom", () => {
    for (const name of ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]) {
      const dir = mkRepo({ "AGENTS.md": AGENTS, [name]: "# Claude notes\n" });
      assert.match(repoInstructionsFor("claude", dir, ["project"]) ?? "", /typecheck with/, name);
    }
  });

  test("claude with a CLAUDE.md that imports or links AGENTS.md reads it itself", () => {
    for (const text of ["@AGENTS.md\n", "See @./AGENTS.md for the rules.\n"]) {
      const dir = mkRepo({ "AGENTS.md": AGENTS, "CLAUDE.md": text });
      assert.equal(repoInstructionsFor("claude", dir, ["project"]), null, text);
    }
    const linked = mkRepo({ "AGENTS.md": AGENTS });
    symlinkSync("AGENTS.md", join(linked, "CLAUDE.md"));
    assert.equal(repoInstructionsFor("claude", linked, ["project"]), null);
  });

  test("claude counts a CLAUDE.md above the workspace", () => {
    const parent = mkRepo({ "CLAUDE.md": "# Parent notes\n" });
    const dir = join(parent, "repo");
    mkdirSync(dir);
    writeFileSync(join(dir, "AGENTS.md"), AGENTS);
    assert.match(repoInstructionsFor("claude", dir, ["project"]) ?? "", /typecheck with/);
  });
});

describe("systemPromptAppendFor", () => {
  test("the tool steer comes first, then the repository instructions", () => {
    const cwd = tmpRepo();
    const md = systemPromptAppendFor(
      false,
      true,
      cwd,
      "# Repository instructions (AGENTS.md)\n\nrules",
    );
    assert.ok(md.startsWith("This session runs under Loom"));
    assert.ok(md.indexOf("This session runs under Loom") < md.indexOf("rules"));
  });

  test("without instructions the append is the base prompt and steer alone", () => {
    const cwd = tmpRepo();
    // claude: the steer, unchanged
    assert.ok(
      systemPromptAppendFor(false, true, cwd, null).startsWith("This session runs under Loom"),
    );
    // aisdk with MCP: base prompt, then the steer
    const withMcp = systemPromptAppendFor(true, true, cwd, null);
    assert.ok(withMcp.startsWith("You are a coding agent"));
    assert.ok(withMcp.includes("This session runs under Loom"));
    // aisdk without MCP: base prompt only
    const noMcp = systemPromptAppendFor(true, false, cwd, null);
    assert.ok(noMcp.startsWith("You are a coding agent"));
    assert.ok(!noMcp.includes("This session runs under Loom"));
  });

  test("the steer names the session's checkout root for absolute-path tools", () => {
    const cwd = tmpRepo();
    const md = systemPromptAppendFor(false, true, cwd, null);
    assert.ok(md.includes(cwd));
    // dropped together with the steer for aisdk sessions without MCP servers
    assert.ok(!systemPromptAppendFor(true, false, cwd, null).includes(cwd));
  });

  test("the steer warns that a path outside the worktree is a different tree", () => {
    const md = systemPromptAppendFor(false, true, tmpRepo(), null);
    assert.match(md, /stays inside the worktree/);
    assert.match(md, /writes never reach your branch/);
  });
});
