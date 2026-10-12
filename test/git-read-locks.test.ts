// Loom's read-only Git probes (git facts, dirtiness, the Changes tab, the agent's
// `status` tool, clone-session facts) run while the agent writes the same worktree.
// If a probe takes `index.lock` to refresh stat info, the agent's own `git add` /
// `git commit` fails with "index.lock: File exists". A worktree whose files have
// stale stat info makes every refreshing command rewrite the index, so "the index
// file is byte-identical afterwards" proves the probe never took the lock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "@loom/daemon/daemon/worktrees";
import { makeLogger, setLogLevel } from "@loom/core/logger";
import { statusInWorktree } from "@loom/core/status";
import { CloneGit, type GuestCommand } from "../backend/daemon/src/daemon/clone-git.ts";
import { changesCommand } from "../backend/daemon/src/daemon/session-inspection.ts";
import { executeShellHook } from "../core/src/shell-hook.ts";

setLogLevel("error");

const FILES = ["a.txt", "b.txt", "c.txt"];
const STALE_MTIME_s = 1_000_000_000;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "loom-git-read-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  for (const name of FILES) writeFileSync(join(root, name), `${name}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const manager = new WorktreeManager({
    repoRoot: root,
    treesDir: join(root, ".loom", "trees"),
    hooksDir: join(root, ".loom", "hooks"),
    baseBranch: "main",
    log: makeLogger("test"),
  });
  const wt = manager.create("aaaaaaaa-1111-2222-3333-444444444444", {
    branchPrefix: ["loom"],
  }).path;
  // A real (unstaged) change keeps every dirty/diff branch of the probes live.
  writeFileSync(join(wt, "a.txt"), "changed\n");
  const index = git(wt, "rev-parse", "--path-format=absolute", "--git-path", "index");
  // A fresh mtime per probe: an index a previous probe refreshed is stale again.
  let mutStale_s = STALE_MTIME_s;
  /** Contents unchanged, stat info stale: a refreshing Git rewrites the index. */
  const rewritesIndex = async (probe: () => unknown): Promise<boolean> => {
    mutStale_s += 1;
    for (const name of FILES.slice(1)) utimesSync(join(wt, name), mutStale_s, mutStale_s);
    const before = readFileSync(index);
    await probe();
    return !readFileSync(index).equals(before);
  };
  return {
    root,
    wt,
    manager,
    rewritesIndex,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

test("read-only Git probes never take the worktree's index lock", async () => {
  const f = fixture();
  const run: GuestCommand = async (command, _timeoutMs, signal) => {
    const r = await new Deno.Command("sh", { args: ["-c", command], cwd: f.wt, signal }).output();
    return { code: r.code, output: new TextDecoder().decode(r.stdout), timedOut: false };
  };
  const changes = async (patch: boolean) => {
    const result = await executeShellHook(
      changesCommand("main", patch),
      f.wt,
      Deno.env.toObject(),
      15_000,
      new AbortController().signal,
    );
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /a\.txt/);
    assert.doesNotMatch(result.output, /b\.txt/, "a stat-only change is not a change");
  };
  const probes: Record<string, () => unknown> = {
    facts: () => {
      f.manager.invalidateFacts(f.wt);
      assert.equal(f.manager.facts(f.wt, "main")?.dirty, true);
    },
    factsAsync: async () => {
      f.manager.invalidateFacts(f.wt);
      assert.equal((await f.manager.factsAsync(f.wt, "main"))?.dirty, true);
    },
    isDirty: () => assert.equal(f.manager.isDirty(f.wt), true),
    statusInWorktree: () => {
      const status = statusInWorktree(f.wt, { base: "main", patch: true });
      assert.match(status.text, /\+changed/);
    },
    changesCommand: () => changes(false),
    "changesCommand(patch)": () => changes(true),
    "CloneGit.facts": async () => {
      const facts = await new CloneGit(run).facts(null, new AbortController().signal);
      assert.equal(facts.git.dirty, true);
    },
    "copyChanges (source)": () => {
      const target = f.manager.create("bbbbbbbb-1111-2222-3333-444444444444", {
        branchPrefix: ["loom"],
      }).path;
      f.manager.copyChanges(f.wt, target);
      assert.equal(readFileSync(join(target, "a.txt"), "utf8"), "changed\n");
    },
  };
  try {
    assert.ok(
      await f.rewritesIndex(() => git(f.wt, "status", "--porcelain")),
      "the oracle: plain `git status` refreshes this fixture's index",
    );
    const rewrote: string[] = [];
    for (const [label, probe] of Object.entries(probes))
      if (await f.rewritesIndex(probe)) rewrote.push(label);
    assert.deepEqual(rewrote, []);
  } finally {
    f.cleanup();
  }
});
