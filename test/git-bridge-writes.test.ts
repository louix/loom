import assert from "node:assert/strict";
import { join } from "node:path";
import { sessionGitArgs } from "../runtime/src/git-bridge/arguments.ts";
import { startGitBridge } from "../runtime/src/git-bridge/service.ts";
import { gitFixture, bridgeRequest } from "../scripts/lib/git-bridge-fixture.ts";

Deno.test("write grammar limits commits and rebases to non-interactive session operations", () => {
  for (const args of [
    ["add", "-A"],
    ["add", "--", "-file"],
    ["restore", "--staged", "--", "file"],
    ["commit", "-m", "message"],
    ["commit", "--amend", "--no-edit"],
    ["rebase", "main"],
    ["rebase", "--onto", "main", "HEAD~2"],
    ["rebase", "--continue"],
    ["rebase", "--abort"],
    ["rebase", "--skip"],
  ])
    assert.ok(sessionGitArgs(args).length);
  for (const args of [
    ["add", "--", "/etc/passwd"],
    ["add", "../file"],
    ["add", "-p"],
    ["commit"],
    ["commit", "-F", "/etc/passwd"],
    ["commit", "-m", "x", "--author=other"],
    ["commit", "-S", "-m", "x"],
    ["rebase", "main", "other-branch"],
    ["rebase", "-i", "main"],
    ["rebase", "--exec", "evil", "main"],
    ["rebase", "--autostash", "main"],
    ["rebase", "--update-refs", "main"],
    ["rebase", "--rebase-merges", "main"],
    ["restore", "--worktree", "file"],
    ["reset", "--hard"],
    ["push"],
    ["config", "x", "y"],
  ])
    assert.throws(() => sessionGitArgs(args), JSON.stringify(args));
});

Deno.test({
  name: "controlled staging/commit/rebase preserve host state, conflicts, restart and abort",
  fn: async () => {
    const f = await gitFixture();
    let bridge: Awaited<ReturnType<typeof startGitBridge>> | undefined;
    try {
      await f.git("-C", f.repo, "config", "user.name", "Loom test");
      await f.git("-C", f.repo, "config", "user.email", "loom@example.invalid");
      const configBefore = await Deno.readTextFile(join(f.commonDir, "config"));
      const options = { ...f.options, writable: true };
      bridge = await startGitBridge(options);
      const request = (args: string[]) =>
        bridgeRequest(bridge!.socket, { version: 1, op: "git", cwd: f.workspace, args });
      const git = async (...args: string[]) => {
        const r = await request(args);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.code, 0, JSON.stringify(r));
        return r.stdout as string;
      };
      await Deno.writeTextFile(join(f.workspace, "added.txt"), "new file\n");
      await git("add", "-A");
      await git("restore", "--staged", "--", "added.txt");
      assert.match(await f.git("-C", f.workspace, "status", "--porcelain"), /\?\? added.txt/);
      await git("add", "added.txt");
      await git("commit", "-m", "guest commit");
      assert.equal(await f.git("-C", f.workspace, "log", "-1", "--format=%s"), "guest commit");
      assert.equal(
        await f.git("-C", f.workspace, "log", "-1", "--format=%cn <%ce>"),
        "Loom test <loom@example.invalid>",
      );
      await git("commit", "--amend", "-m", "amended guest commit");
      await Deno.writeTextFile(join(f.repo, "main.txt"), "main advanced\n");
      await f.git("-C", f.repo, "add", "main.txt");
      await f.git("-C", f.repo, "commit", "-m", "advance main");
      const main = await f.git("-C", f.repo, "rev-parse", "HEAD");
      await git("rebase", "main");
      assert.equal(await f.git("-C", f.workspace, "rev-parse", "HEAD^"), main);
      // Conflicting rebase survives worker shutdown, so host Git can inspect it.
      await Deno.writeTextFile(join(f.workspace, "file.txt"), "session side\n");
      await git("add", "file.txt");
      await git("commit", "-m", "session conflict");
      const original = await f.git("-C", f.workspace, "rev-parse", "HEAD");
      await Deno.writeTextFile(join(f.repo, "file.txt"), "main side\n");
      await f.git("-C", f.repo, "add", "file.txt");
      await f.git("-C", f.repo, "commit", "-m", "main conflict");
      const conflict = await request(["rebase", "main"]);
      assert.equal(conflict.ok, true);
      assert.notEqual(conflict.code, 0);
      assert.match(await f.git("-C", f.workspace, "status"), /rebase in progress/);
      await bridge.close();
      bridge = await startGitBridge(options);
      await git("rebase", "--abort");
      assert.equal(await f.git("-C", f.workspace, "rev-parse", "HEAD"), original);
      assert.notEqual((await request(["rebase", "main"])).code, 0);
      await Deno.writeTextFile(join(f.workspace, "file.txt"), "resolved\n");
      await git("add", "file.txt");
      await git("rebase", "--continue");
      assert.equal(await Deno.readTextFile(join(f.workspace, "file.txt")), "resolved\n");
      assert.equal(await f.git("-C", f.workspace, "branch", "--show-current"), "session");
      assert.equal(await f.git("-C", f.repo, "branch", "--show-current"), "main");
      assert.equal(await Deno.readTextFile(join(f.commonDir, "config")), configBefore);
      // Host checkout cannot silently grant authority over a different branch.
      await f.git("-C", f.workspace, "checkout", "-b", "different");
      assert.match(
        (await request(["commit", "--allow-empty", "-m", "wrong branch"])).message,
        /host changed/,
      );
    } finally {
      await bridge?.close();
      await f.close();
    }
  },
});

Deno.test("repository programs are disabled by default and explicitly opt in on the host", async () => {
  const f = await gitFixture();
  let bridge: Awaited<ReturnType<typeof startGitBridge>> | undefined;
  try {
    const hooks = join(f.workspace, "hooks");
    await Deno.mkdir(hooks);
    const marker = join(f.workspace, "hook-ran");
    // Use the host shell's absolute path, including on Nix/Guix hosts without /bin/sh.
    const shell = Deno.env.get("SHELL") ?? "/bin/sh";
    await Deno.writeTextFile(join(hooks, "pre-commit"), `#!${shell}\nprintf ran > '${marker}'\n`, {
      mode: 0o755,
    });
    await f.git("-C", f.repo, "config", "core.hooksPath", hooks);
    const config = await Deno.readTextFile(join(f.commonDir, "config"));
    const request = (args: string[]) =>
      bridgeRequest(bridge!.socket, { version: 1, op: "git", cwd: f.workspace, args });
    bridge = await startGitBridge({ ...f.options, writable: true });
    assert.equal((await request(["commit", "--allow-empty", "-m", "no hook"])).code, 0);
    await assert.rejects(Deno.stat(marker), Deno.errors.NotFound);
    // Recheck policy on every operation, including host changes during a session.
    await f.git("-C", f.repo, "config", "filter.trap.clean", "false");
    assert.match((await request(["add", "-A"])).message, /allow_repo_programs/);
    await bridge.close();
    bridge = undefined;
    await assert.rejects(startGitBridge({ ...f.options, writable: true }), /filter.trap.clean/);
    await f.git("-C", f.repo, "config", "--unset", "filter.trap.clean");
    await f.git("-C", f.repo, "config", "merge.trap.driver", "false");
    await assert.rejects(startGitBridge({ ...f.options, writable: true }), /merge.trap.driver/);
    await f.git("-C", f.repo, "config", "--unset", "merge.trap.driver");
    await f.git("-C", f.repo, "config", "include.path", join(f.workspace, "local-config"));
    await assert.rejects(startGitBridge({ ...f.options, writable: true }), /include.path/);
    await f.git("-C", f.repo, "config", "--unset", "include.path");
    bridge = await startGitBridge({ ...f.options, writable: true, allowRepoPrograms: true });
    assert.equal((await request(["commit", "--allow-empty", "-m", "with hook"])).code, 0);
    assert.equal(await Deno.readTextFile(marker), "ran");
    assert.equal(await Deno.readTextFile(join(f.commonDir, "config")), config);
  } finally {
    await bridge?.close();
    await f.close();
  }
});

Deno.test("multiple bridges serialize commits and only resume their own plain rebases", async () => {
  const f = await gitFixture();
  const bridges: Awaited<ReturnType<typeof startGitBridge>>[] = [];
  try {
    for (let i = 0; i < 2; i++)
      bridges.push(await startGitBridge({ ...f.options, writable: true }));
    const request = (i: number, args: string[]) =>
      bridgeRequest(bridges[i]!.socket, { version: 1, op: "git", cwd: f.workspace, args });
    const commits = await Promise.all(
      [0, 1].map((i) => request(i, ["commit", "--allow-empty", "-m", `parallel ${i}`])),
    );
    for (const result of commits) assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(await f.git("-C", f.workspace, "rev-list", "--count", "main..HEAD"), "2");
    await Deno.writeTextFile(join(f.workspace, "file.txt"), "session\n");
    assert.equal((await request(0, ["commit", "-a", "-m", "conflict"])).code, 0);
    await Deno.writeTextFile(join(f.repo, "file.txt"), "main\n");
    await f.git("-C", f.repo, "commit", "-am", "main conflict");
    const main = await f.git("-C", f.repo, "rev-parse", "HEAD");
    assert.notEqual((await request(0, ["rebase", "--onto", "main", "HEAD~3"])).code, 0);
    await Deno.writeTextFile(
      join(f.gitDir, "rebase-merge", "git-rebase-todo"),
      "exec touch should-not-run\n",
      { append: true },
    );
    assert.match((await request(1, ["rebase", "--continue"])).message, /instructions were edited/);
    // Abort is safe even when the host edited the todo list.
    assert.equal((await request(1, ["rebase", "--abort"])).code, 0);
    assert.notEqual((await request(0, ["rebase", "main"])).code, 0);
    assert.equal((await request(1, ["rebase", "--skip"])).code, 0);
    assert.equal(await f.git("-C", f.repo, "rev-parse", "HEAD"), main);
    assert.equal(await Deno.readTextFile(join(f.workspace, "file.txt")), "main\n");
    // A host operation has no ownership record and cannot execute via the bridge.
    await Deno.mkdir(join(f.gitDir, "rebase-merge"));
    await Deno.writeTextFile(join(f.gitDir, "rebase-merge", "head-name"), "refs/heads/session\n");
    assert.match(
      (await request(0, ["rebase", "--continue"])).message,
      /not started by the session bridge/,
    );
  } finally {
    for (const bridge of bridges) await bridge.close();
    await f.close();
  }
});

Deno.test("separate Git worker processes share the worktree operation lock", async () => {
  const { gitBridgeWorker } = await import("../scripts/lib/git-bridge-worker.ts");
  const f = await gitFixture();
  const workers: Awaited<ReturnType<typeof gitBridgeWorker>>[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const state = join(f.state, `${i}`);
      await Deno.mkdir(state);
      workers.push(await gitBridgeWorker({ ...f.options, state, writable: true }));
    }
    for (let round = 0; round < 5; round++) {
      const replies = await Promise.all(
        workers.map((worker, i) =>
          bridgeRequest(worker.socket, {
            version: 1,
            op: "git",
            cwd: f.workspace,
            args: ["commit", "--allow-empty", "-m", `worker ${i} round ${round}`],
          }),
        ),
      );
      for (const reply of replies) assert.equal(reply.code, 0, JSON.stringify(reply));
    }
    assert.equal(await f.git("-C", f.workspace, "rev-list", "--count", "main..HEAD"), "10");
  } finally {
    for (const worker of workers) await worker.close();
    await f.close();
  }
});
