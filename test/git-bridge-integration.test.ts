import assert from "node:assert/strict";
import { join } from "node:path";
import { readOnlyGitArgs } from "../runtime/src/git-bridge/arguments.ts";
import { discoverGitWorktree, validateIndex } from "../runtime/src/git-bridge/layout.ts";
import { startGitBridge } from "../runtime/src/git-bridge/service.ts";
import { bridgeRequest, gitFixture } from "../scripts/lib/git-bridge-fixture.ts";

Deno.test("Git argv boundary accepts Tilth reads and rejects execution, writes and filesystem escapes", () => {
  for (const args of [
    ["-c", "core.quotePath=false", "diff", "HEAD"],
    ["diff", "--staged"],
    ["diff", "HEAD^..HEAD"],
    ["log", "--format=%H %at %s%x00%an", "main..session"],
    ["show", "HEAD:file.txt"],
    ["show", ":file.txt"],
    ["status", "--porcelain"],
    ["branch", "--show-current"],
    ["rev-parse", "--short", "HEAD"],
  ])
    assert.ok(readOnlyGitArgs(args).length);
  for (const args of [
    ["commit", "-m", "x"],
    ["add", "."],
    ["rebase", "main"],
    ["config", "x", "y"],
    ["-c", "core.fsmonitor=evil", "status"],
    ["diff", "--ext-diff"],
    ["diff", "--no-index", "/etc/passwd", "file"],
    ["diff", "--", "../../secret"],
    ["log", "--format=%(contents)"],
    ["log", "--max-count=100"],
    ["log", "--output=/tmp/file"],
    ["show", "HEAD:../../secret"],
    ["show", "HEAD"],
    ["show", ":/pattern"],
    ["rev-parse", "--git-dir"],
    ["diff", "HEAD^{tree}"],
    ["log", "@{upstream}"],
    ["log", "main...--help"],
  ])
    assert.throws(() => readOnlyGitArgs(args), JSON.stringify(args));
});

Deno.test("Git layout validation rejects metadata exposure, split indexes and alternate worktree pointers", async () => {
  const f = await gitFixture();
  try {
    assert.deepEqual(await discoverGitWorktree(f.workspace), {
      gitDir: f.gitDir,
      commonDir: f.commonDir,
    });
    await assert.rejects(discoverGitWorktree(f.repo), /linked worktree/);
    validateIndex(await Deno.readFile(join(f.gitDir, "index")));
    await f.git("-C", f.workspace, "update-index", "--index-version", "4");
    validateIndex(await Deno.readFile(join(f.gitDir, "index")));
    await f.git("-C", f.workspace, "update-index", "--split-index");
    assert.throws(() => validateIndex(Deno.readFileSync(join(f.gitDir, "index"))), /split\/sparse/);
    await assert.rejects(startGitBridge(f.options), /split\/sparse/);
    await Deno.remove(join(f.workspace, ".git"));
    await Deno.symlink(join(f.repo, ".git"), join(f.workspace, ".git"));
    await assert.rejects(discoverGitWorktree(f.workspace), /linked worktree/);
  } finally {
    await f.close();
  }
});

Deno.test("Git worker validates extensions and services only the bound root with live staged/blob reads", async () => {
  const f = await gitFixture();
  let bridge: Awaited<ReturnType<typeof startGitBridge>> | undefined;
  try {
    await f.git("-C", f.repo, "config", "extensions.objectFormat", "sha256");
    await assert.rejects(startGitBridge(f.options), /extensions.objectformat/);
    // Restore with a direct file write: the deliberate format mismatch makes ordinary Git invalid.
    await Deno.writeTextFile(
      join(f.commonDir, "config"),
      "[core]\nrepositoryformatversion=0\nbare=false\n[extensions]\nworktreeConfig=true\n",
    );
    bridge = await startGitBridge(f.options);
    const request = (args: string[], cwd = f.workspace) =>
      bridgeRequest(bridge!.socket, { version: 1, op: "git", args, cwd });
    assert.equal((await request(["show", "HEAD:file.txt"])).stdout, "base\n");
    await Deno.writeTextFile(join(f.workspace, "file.txt"), "staged\n");
    await f.git("-C", f.workspace, "add", "file.txt");
    assert.equal((await request(["show", ":file.txt"])).stdout, "staged\n");
    assert.match((await request(["diff", "--staged"])).stdout, /\+staged/);
    assert.equal((await request(["status"], f.repo)).error, "invalid-request");
    assert.equal((await request(["commit", "-m", "not allowed"])).error, "invalid-request");
    assert.equal((await request(["log", "--format=%H %at %s%x00%an"])).code, 0);
  } finally {
    await bridge?.close();
    await f.close();
  }
});
