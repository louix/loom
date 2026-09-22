import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { CloneGit, type GuestCommand } from "../backend/daemon/src/daemon/clone-git.ts";
import { gitFixture } from "../scripts/lib/git-fixture.ts";

const fixture = async () => {
  const f = await gitFixture();
  const cwd = join(f.root, "clone");
  await f.git("-C", f.repo, "branch", "clone-session");
  await f.git("clone", "--no-local", "-b", "clone-session", f.repo, cwd);
  await f.git("-C", cwd, "config", "user.name", "test");
  await f.git("-C", cwd, "config", "user.email", "test@localhost");
  const commands: string[] = [];
  const run: GuestCommand = async (command, _timeout, signal) => {
    commands.push(command);
    const r = await new Deno.Command("sh", {
      args: ["-c", command],
      cwd,
      signal,
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    }).output();
    return { code: r.code, output: new TextDecoder().decode(r.stdout), timedOut: false };
  };
  return { ...f, cwd, commands, api: new CloneGit(run) };
};
test("guest Git reports real dirtiness and rebases/merges and publishes through origin", async () => {
  const f = await fixture(),
    signal = new AbortController().signal;
  try {
    const clean = await f.api.facts("main", signal);
    assert.equal(clean.git.dirty, false);
    await Deno.writeTextFile(join(f.cwd, "private.txt"), "private");
    assert.equal((await f.api.facts("main", signal)).git.dirty, true);
    await f.git("-C", f.repo, "commit", "--allow-empty", "-m", "base advanced");
    assert.equal((await f.api.sync("clone-session", "main", "rebase", signal)).outcome, "dirty");
    await f.git("-C", f.cwd, "add", ".");
    await f.git("-C", f.cwd, "commit", "-m", "private commit");
    assert.equal((await f.api.sync("clone-session", "main", "rebase", signal)).outcome, "updated");
    assert.equal(
      await f.git("-C", f.repo, "rev-parse", "clone-session"),
      await f.git("-C", f.cwd, "rev-parse", "HEAD"),
    );
    assert.equal((await f.api.facts("main", signal)).git.behindBase, 0);
    await f.git("-C", f.repo, "commit", "--allow-empty", "-m", "base advanced again");
    assert.equal((await f.api.sync("clone-session", "main", "merge", signal)).outcome, "updated");
    assert.equal((await f.api.sync("clone-session", "main", "merge", signal)).outcome, "current");
  } finally {
    await f.close();
  }
});
test("guest Git aborts its own conflict but leaves an agent's existing operation alone", async () => {
  const f = await fixture(),
    signal = new AbortController().signal;
  try {
    await Deno.writeTextFile(join(f.repo, "conflict"), "base\n");
    await f.git("-C", f.repo, "add", ".");
    await f.git("-C", f.repo, "commit", "-m", "host conflict");
    await Deno.writeTextFile(join(f.cwd, "conflict"), "session\n");
    await f.git("-C", f.cwd, "add", ".");
    await f.git("-C", f.cwd, "commit", "-m", "session conflict");
    const before = await f.git("-C", f.cwd, "rev-parse", "HEAD");
    assert.equal((await f.api.sync("clone-session", "main", "rebase", signal)).outcome, "conflict");
    assert.equal(await f.git("-C", f.cwd, "rev-parse", "HEAD"), before);
    assert.equal((await f.api.facts("main", signal)).git.dirty, false);
    await Deno.mkdir(join(f.cwd, ".git/rebase-merge"));
    await Deno.writeTextFile(join(f.cwd, ".git/rebase-merge/keep"), "agent state");
    assert.equal((await f.api.sync("clone-session", "main", "rebase", signal)).outcome, "busy");
    assert.equal(await Deno.readTextFile(join(f.cwd, ".git/rebase-merge/keep")), "agent state");
  } finally {
    await f.close();
  }
});
test("guest Git does not interpret failed or malformed probes as clean", async () => {
  for (const output of ["", "not a Git result"]) {
    const git = new CloneGit(async () => ({ code: 0, output, timedOut: false }));
    await assert.rejects(git.facts("main", new AbortController().signal), /Invalid guest/);
  }
  const git = new CloneGit(async () => ({ code: 1, output: "", timedOut: false }));
  await assert.rejects(git.facts("main", new AbortController().signal), /Could not read/);
});
