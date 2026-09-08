import assert from "node:assert/strict";
import { join } from "node:path";
import { gitArguments, startGitBridge } from "../runtime/src/git-bridge/service.ts";

import { gitFixture, bridgeRequest } from "../scripts/lib/git-bridge-fixture.ts";
import { gitBridgeWorker } from "../scripts/lib/git-bridge-worker.ts";
import { prepareGitBridge } from "../runtime/src/git-bridge/service.ts";
import { fileURLToPath } from "node:url";

Deno.test("Git bridge grammar rejects authority changes, execution flags and revision expressions", () => {
  for (const request of [
    null,
    [],
    {},
    { version: 2, op: "status" },
    { version: 1, op: "commit" },
    { version: 1, op: "status", cwd: "/tmp" },
    { version: 1, op: "status", argv: ["-c", "core.fsmonitor=evil"] },
    { version: 1, op: "diff", staged: "yes" },
    { version: 1, op: "log", limit: 100 },
    ...["--help", "HEAD:file", "HEAD@{1}", "main..other", "x\n-y", "refs/.hidden", "x.lock"].map(
      (ref) => ({ version: 1, op: "log", ref }),
    ),
  ])
    assert.throws(() => gitArguments(request));
  assert.ok(
    gitArguments({ version: 1, op: "log", ref: "refs/heads/main", limit: 2 }).includes(
      "refs/heads/main",
    ),
  );
});

Deno.test("Git bridge reads live host worktree without config, hooks, helpers or guest-selected paths", async () => {
  const f = await gitFixture();
  let bridge: Awaited<ReturnType<typeof startGitBridge>> | undefined;
  try {
    await Deno.writeTextFile(join(f.workspace, "file.txt"), "guest change\n");
    // Exercise execution surfaces that would be dangerous if the real config leaked in.
    const marker = join(f.root, "executed");
    const trap = join(f.root, "trap.sh");
    await Deno.writeTextFile(trap, `#!/bin/sh\necho executed > '${marker}'\nexit 1\n`);
    await Deno.chmod(trap, 0o700);
    for (const [key, value] of [
      ["core.fsmonitor", trap],
      ["diff.external", trap],
      ["diff.trap.textconv", trap],
      ["filter.trap.clean", trap],
      ["core.pager", trap],
      ["core.hooksPath", f.root],
      ["include.path", join(f.root, "bad-config")],
    ])
      await f.git("-C", f.repo, "config", key!, value!);
    await Deno.writeTextFile(join(f.root, "bad-config"), "this is not valid config\n");
    await Deno.writeTextFile(join(f.workspace, ".gitattributes"), "*.txt diff=trap filter=trap\n");
    await Deno.writeTextFile(join(f.workspace, ".git"), "gitdir: /some/other/repo\n");
    bridge = await startGitBridge(f.options);
    const indexBefore = await Deno.readFile(join(f.gitDir, "index"));
    const status = await bridgeRequest(bridge.socket, { version: 1, op: "status" });
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, / M file.txt/);
    const diff = await bridgeRequest(bridge.socket, { version: 1, op: "diff" });
    assert.equal(diff.code, 0);
    assert.match(diff.stdout, /\+guest change/);
    assert.equal(
      (await bridgeRequest(bridge.socket, { version: 1, op: "log" })).stdout
        .split(" ")
        .slice(1)
        .join(" "),
      "base commit\n",
    );
    assert.deepEqual(
      await bridgeRequest(bridge.socket, { version: 1, op: "status", cwd: f.repo }),
      { version: 1, ok: false, error: "invalid-request" },
    );
    await assert.rejects(Deno.stat(marker), Deno.errors.NotFound);
    assert.deepEqual(await Deno.readFile(join(f.gitDir, "index")), indexBefore);
    // Restore trusted fixture configuration; host changes remain visible through the view.
    await Deno.writeTextFile(
      join(f.commonDir, "config"),
      "[core]\nrepositoryformatversion = 0\nbare = false\n",
    );
    await Deno.writeTextFile(join(f.workspace, ".git"), `gitdir: ${f.gitDir}\n`);
    await f.git("-C", f.workspace, "add", "file.txt");
    assert.match(
      (await bridgeRequest(bridge.socket, { version: 1, op: "diff", staged: true })).stdout,
      /\+guest change/,
    );
    await f.git("-C", f.workspace, "commit", "-m", "host commit");
    await f.git("-C", f.repo, "pack-refs", "--all");
    assert.match(
      (await bridgeRequest(bridge.socket, { version: 1, op: "log", limit: 1 })).stdout,
      /host commit/,
    );
    // Bound output and recover for subsequent requests.
    await Deno.writeTextFile(join(f.workspace, "file.txt"), "large\n".repeat(20_000));
    assert.deepEqual(await bridgeRequest(bridge.socket, { version: 1, op: "diff" }), {
      version: 1,
      ok: false,
      error: "execution-failed",
    });
    assert.equal((await bridgeRequest(bridge.socket, { version: 1, op: "status" })).code, 0);
  } finally {
    await bridge?.close();
    await f.close();
  }
});

Deno.test("Git bridge worker sees parent EOF during startup and leaves no endpoint", async () => {
  const f = await gitFixture();
  try {
    const prepared = await prepareGitBridge(f.options);
    const binding = join(f.state, "binding.json");
    await Deno.writeTextFile(binding, JSON.stringify(prepared));
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        fileURLToPath(new URL("../runtime/src/git-bridge/main.ts", import.meta.url)),
        binding,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    const result = await child.output();
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    assert.equal(result.stdout.length, 0);
    await assert.rejects(Deno.stat(prepared.dir), Deno.errors.NotFound);
  } finally {
    await f.close();
  }
});

Deno.test("Git bridge shutdown disconnects idle clients and removes its endpoint", async () => {
  const f = await gitFixture();
  try {
    const bridge = await startGitBridge(f.options);
    const client = await Deno.connect({ transport: "unix", path: bridge.socket });
    await client.write(new TextEncoder().encode('{"version":'));
    await bridge.close();
    try {
      assert.equal(await client.read(new Uint8Array(10)), null);
    } catch (error) {
      if (!(error instanceof Deno.errors.ConnectionReset)) throw error;
    } finally {
      client.close();
    }
    await assert.rejects(Deno.stat(bridge.socket), Deno.errors.NotFound);
  } finally {
    await f.close();
  }
});

Deno.test("Git bridge worker uses explicit grants and exits on parent stdin EOF", async () => {
  const f = await gitFixture();
  let worker: Awaited<ReturnType<typeof gitBridgeWorker>> | undefined;
  try {
    worker = await gitBridgeWorker(f.options);
    assert.equal((await bridgeRequest(worker.socket, { version: 1, op: "status" })).code, 0);
    await worker.close();
    await assert.rejects(Deno.stat(worker.socket), Deno.errors.NotFound);
  } finally {
    await worker?.close();
    await f.close();
  }
});
