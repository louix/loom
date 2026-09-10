/** Real packaged MCP session acceptance, using disposable linked worktrees. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { startRuntimeMcp } from "../backend/daemon/src/daemon/runtime-mcp.ts";
import { startSessionGit } from "../backend/daemon/src/daemon/git-worker.ts";
import { launchLocalWorker } from "../backend/daemon/src/daemon/worker-launch.ts";
import { gitFixture } from "./lib/git-bridge-fixture.ts";
import { resolveRuntime } from "../runtime/src/packaged/artifact.ts";
import { sessionVmName, vmEnvironment } from "../runtime/src/packaged/vm.ts";
import { fileURLToPath } from "node:url";
const runtime = Deno.args[0] ?? "tilth";
const { lock } = await resolveRuntime(runtime);
const results: string[] = [];
for (const mode of [
  "close",
  "parent-eof",
  "vm-worker-kill",
  "git-worker-kill",
  "startup-eof",
] as const) {
  console.error(`Testing linked worktree: ${mode}`);
  const f = await gitFixture();
  let state = "",
    gitPid = -1;
  let parent: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let worker: Awaited<ReturnType<typeof startRuntimeMcp>> | undefined;
  let passed = false;
  try {
    await Deno.writeTextFile(join(f.workspace, "file.txt"), "guest edit\n");
    const launching = startRuntimeMcp(
      "tilth",
      runtime,
      f.workspace,
      (spec) => {
        state = spec.cwd;
        const child = launchLocalWorker(spec);
        parent = child.input.getWriter();
        const sink = parent;
        return {
          ...child,
          input: new WritableStream({
            write: async (bytes) => {
              await sink.write(bytes);
              if (mode === "startup-eof") await sink.close();
            },
            close: () => sink.close(),
          }),
        };
      },
      async (...args) => {
        const git = await startSessionGit(...args);
        gitPid = git?.pid ?? -1;
        return git;
      },
    );
    if (mode === "startup-eof") {
      await assert.rejects(launching);
    } else {
      worker = await launching;
      const spec = worker.handle.spec;
      assert.equal(spec.transport, "http");
      if (spec.transport !== "http") throw new Error("Expected HTTP endpoint");
      let id = 0;
      const call = async (args: unknown) => {
        const response = await fetch(spec.url, {
          method: "POST",
          headers: { ...spec.headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++id,
            method: "tools/call",
            params: { name: "tilth_diff", arguments: args },
          }),
        });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.ok(!result.error, JSON.stringify(result));
        assert.ok(!result.result.isError, JSON.stringify(result));
        return JSON.stringify(result.result);
      };
      assert.match(await call({ root: f.workspace }), /file\.txt/);
      if (mode === "close") {
        await assert.rejects(call({ root: f.workspace, source: "HEAD^{tree}" }), /git diff failed/);
        await f.git("-C", f.workspace, "add", "file.txt");
        assert.match(await call({ root: f.workspace, source: "staged" }), /file\.txt/);
        await f.git("-C", f.workspace, "commit", "-m", "host commit");
        await Deno.writeTextFile(join(f.repo, "main.txt"), "main advance\n");
        await f.git("-C", f.repo, "add", "main.txt");
        await f.git("-C", f.repo, "commit", "-m", "main advance");
        await f.git("-C", f.workspace, "rebase", "main");
        assert.match(await call({ root: f.workspace, source: "main" }), /file\.txt/);
        const exec = async (args: string[]) =>
          await new Deno.Command(lock.smolvm, {
            args: ["machine", "exec", "--name", sessionVmName, "-w", f.workspace, "--", ...args],
            clearEnv: true,
            env: vmEnvironment(state),
            stdout: "piped",
            stderr: "piped",
            stdin: "null",
          }).output();
        const binary = await Deno.readLink(join(lock.artifact, "bin/git"));
        const status = await exec([binary, "status", "--porcelain"]);
        assert.equal(status.code, 0, new TextDecoder().decode(status.stderr));
        const diff = await exec([binary, "diff", "main"]);
        assert.equal(diff.code, 0, new TextDecoder().decode(diff.stderr));
        assert.match(new TextDecoder().decode(diff.stdout), /\+guest edit/);
        const guestGit = async (...args: string[]) => {
          const result = await exec([binary, ...args]);
          assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
        };
        await Deno.writeTextFile(join(f.workspace, "guest.txt"), "from guest\n");
        await guestGit("add", "guest.txt");
        await guestGit("commit", "-m", "guest commit");
        assert.equal(await f.git("-C", f.workspace, "log", "-1", "--format=%s"), "guest commit");
        await Deno.writeTextFile(join(f.repo, "new-base.txt"), "new base\n");
        await f.git("-C", f.repo, "add", "new-base.txt");
        await f.git("-C", f.repo, "commit", "-m", "advance again");
        await guestGit("rebase", "main");
        assert.equal(
          await f.git("-C", f.workspace, "rev-parse", "HEAD~2"),
          await f.git("-C", f.repo, "rev-parse", "HEAD"),
        );
        for (const args of [
          [binary, "push"],
          ["/bin/busybox", "cat", join(f.commonDir, "config")],
        ])
          assert.notEqual((await exec(args)).code, 0);
      }
      if (mode === "parent-eof") await parent!.close();
      if (mode === "vm-worker-kill") Deno.kill(worker.pid, "SIGKILL");
      if (mode === "git-worker-kill") Deno.kill(gitPid, "SIGKILL");
      if (mode !== "close") {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            worker.exited,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Worker did not exit")), 25_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      await worker.close();
    }
    await assert.rejects(Deno.stat(state), Deno.errors.NotFound);
    await assert.rejects(Deno.stat(`/proc/${gitPid}`), Deno.errors.NotFound);
    results.push(mode);
    passed = true;
  } finally {
    await worker?.close();
    if (passed) await f.close();
    else console.error(`Retained Git fixture: ${f.root}; VM state: ${state}`);
  }
}
for (const phase of ["starting", "ready"] as const) {
  console.error(`Testing actual parent SIGKILL: ${phase}`);
  const f = await gitFixture();
  const parent = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      fileURLToPath(new URL("./lib/session-vm-parent.ts", import.meta.url)),
      runtime,
      f.workspace,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stderr = new Response(parent.stderr).text();
  const lines = parent.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let state = "",
    text = "",
    vmPid = -1,
    killed = false,
    passed = false;
  const timeout = setTimeout(() => {
    try {
      parent.kill("SIGKILL");
    } catch {
      /* exited */
    }
  }, 90_000);
  try {
    while (!killed) {
      const next = await lines.read();
      if (next.done) throw new Error(`Parent exited unexpectedly: ${await stderr}`);
      text += next.value;
      let newline: number;
      while ((newline = text.indexOf("\n")) >= 0) {
        const frame = JSON.parse(text.slice(0, newline));
        text = text.slice(newline + 1);
        if (frame.state) state = frame.state;
        if (frame.pid) vmPid = frame.pid;
        if (frame.kind === phase) {
          parent.kill("SIGKILL");
          killed = true;
          break;
        }
      }
    }
    await parent.status;
    // No daemon remains to run its fallback. The VM supervisor must reap on stdin EOF.
    const deadline = Date.now() + 25_000;
    for (;;) {
      const listing = await new Deno.Command(lock.smolvm, {
        args: ["machine", "ls", "--json"],
        clearEnv: true,
        env: vmEnvironment(state),
        stdout: "piped",
        stderr: "piped",
      }).output();
      const entries = [...Deno.readDirSync(state)].filter(
        (e) => e.isDirectory && e.name.startsWith("git-bridge-"),
      );
      let exited = false;
      try {
        if (Deno.build.os === "linux") {
          exited =
            (await Deno.readTextFile(`/proc/${vmPid}/stat`)).split(") ")[1]?.startsWith("Z") ??
            false;
        } else {
          Deno.kill(vmPid, 0);
        }
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) exited = true;
        else throw e;
      }
      if (
        exited &&
        listing.success &&
        JSON.parse(new TextDecoder().decode(listing.stdout)).length === 0 &&
        entries.length === 0
      )
        break;
      if (Date.now() > deadline) throw new Error(`Orphaned session after parent death: ${state}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    // Let any in-progress cold startup settle, then ensure no machine appeared later.
    await new Promise((r) => setTimeout(r, 1000));
    const final = await new Deno.Command(lock.smolvm, {
      args: ["machine", "ls", "--json"],
      clearEnv: true,
      env: vmEnvironment(state),
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(final.code, 0);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(final.stdout)), []);
    results.push(`parent-kill-${phase}`);
    passed = true;
  } finally {
    clearTimeout(timeout);
    try {
      parent.kill("SIGKILL");
    } catch {
      /* exited */
    }
    await parent.status;
    await lines.cancel();
    lines.releaseLock();
    await stderr;
    if (passed) {
      await Deno.remove(state, { recursive: true });
      await f.close();
    } else console.error(`Retained parent-death fixture ${f.root}, VM state ${state}`);
  }
}
console.log(JSON.stringify({ passed: results }, null, 2));
