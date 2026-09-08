/** Real VM lifecycle acceptance; mock connector, no provider credentials or API calls. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { readFrames } from "../runtime/src/worker/transport.ts";
import { gitFixture } from "./lib/git-bridge-fixture.ts";
const artifact = Deno.args[0] ?? "/tmp/loom-claude-session-artifact";
const smolvm =
  Deno.args[1] ??
  (Deno.env.get("PATH") ?? "")
    .split(":")
    .filter(Boolean)
    .map((path) => join(path, "smolvm"))
    .find((path) => {
      try {
        return Deno.statSync(path).isFile;
      } catch {
        return false;
      }
    });
assert(smolvm, "Run in nix develop, or pass the smolvm executable as the second argument");
const processesGone = async (pids: number[]) => {
  const deadline = Date.now() + 10_000;
  for (const pid of pids)
    for (;;) {
      try {
        const stat = await Deno.readTextFile(`/proc/${pid}/stat`);
        if (/\) Z /.test(stat)) break; // terminated, awaiting the host init's reap
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) break;
        throw error;
      }
      if (Date.now() > deadline) throw new Error(`Session process survived cleanup: ${pid}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
};
const gone = async (state: string) => {
  const end = Date.now() + 40_000;
  for (;;) {
    try {
      await Deno.stat(state);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    if (Date.now() > end) throw new Error(`Session state/credentials not removed: ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const f = await gitFixture();
const sessionDirectory = join(f.root, "persistent");
try {
  for (const mode of [
    "close",
    "startup EOF",
    "startup EOF after Git ready",
    "supervisor SIGKILL",
    "Git SIGKILL",
    "guest exec SIGKILL",
  ]) {
    console.error(`Testing ${mode}`);
    const worker = await launchSessionVm({
      artifact,
      smolvm,
      workspace: f.workspace,
      sessionDirectory,
      auth: { ANTHROPIC_API_KEY: "disposable-test-key" },
    });
    let session: RemoteWorkerSession | undefined;
    const pids = [worker.pid];
    try {
      if (mode.startsWith("startup EOF")) {
        if (mode === "startup EOF after Git ready") {
          const deadline = Date.now() + 20_000;
          for (;;) {
            try {
              const { gitPid } = await worker.status();
              if (gitPid) {
                pids.push(gitPid);
                break;
              }
            } catch (error) {
              if (!(error instanceof Deno.errors.NotFound)) throw error;
            }
            if (Date.now() > deadline) throw new Error("Git worker did not start");
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        await worker.input.close();
      } else {
        ({ session } = await RemoteWorkerSession.connect(
          "lifecycle",
          "mock",
          mockLaunchSpec(f.workspace),
          () => worker,
          120_000,
        ));
        const ready = await worker.status();
        if (mode === "close") {
          const duplicate = await launchSessionVm({
            artifact,
            smolvm,
            workspace: f.workspace,
            sessionDirectory,
            auth: { ANTHROPIC_API_KEY: "disposable-test-key" },
          });
          try {
            await assert.rejects(
              RemoteWorkerSession.connect(
                "duplicate",
                "mock",
                mockLaunchSpec(f.workspace),
                () => duplicate,
                120_000,
              ),
            );
            const active = JSON.parse(
              await Deno.readTextFile(join(sessionDirectory, "active.json")),
            );
            assert.equal(active.token, worker.binding.token);
            assert.equal((await worker.status()).phase, "running");
          } finally {
            duplicate.terminate();
            await duplicate.cleanup?.();
          }
        }
        if (ready.gitPid) pids.push(ready.gitPid);
        if (ready.execPid) pids.push(ready.execPid);
        if (mode === "supervisor SIGKILL") Deno.kill(worker.pid, "SIGKILL");
        else if (mode === "Git SIGKILL") {
          const status = await worker.status();
          assert(status.gitPid);
          Deno.kill(status.gitPid, "SIGKILL");
        } else if (mode === "guest exec SIGKILL") {
          const status = await worker.status();
          assert(status.execPid);
          Deno.kill(status.execPid, "SIGKILL");
        } else await session.close();
      }
      await Promise.race([
        worker.exited,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Supervisor did not exit")), 40_000);
          void worker.exited.finally(() => clearTimeout(timer));
        }),
      ]);
      await worker.cleanup?.();
      await gone(worker.binding.state);
      await gone(join(sessionDirectory, "active.json"));
      await processesGone(pids);
    } finally {
      await session?.close();
      worker.terminate();
      await worker.cleanup?.();
    }
  }
  for (const phase of ["starting", "ready"]) {
    console.error(`Testing parent SIGKILL while ${phase}`);
    const parent = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        fileURLToPath(new URL("lib/claude-vm-parent.ts", import.meta.url)),
        artifact,
        smolvm,
        f.workspace,
        sessionDirectory,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    const frames = readFrames(
      parent.stdout,
      (v) => v as { kind: string; state?: string; pid?: number; gitPid?: number; execPid?: number },
    );
    let state: string | undefined;
    let reached = false;
    const pids: number[] = [];
    try {
      for await (const frame of frames) {
        if (frame.state) state = frame.state;
        for (const pid of [frame.pid, frame.gitPid, frame.execPid]) if (pid) pids.push(pid);
        if (frame.kind === phase) {
          reached = true;
          break;
        }
      }
      assert(reached, `Parent did not reach ${phase}`);
      assert(state);
      parent.kill("SIGKILL");
      await parent.status;
      await gone(state);
      await gone(join(sessionDirectory, "active.json"));
      await processesGone(pids);
    } finally {
      try {
        parent.kill("SIGKILL");
      } catch {
        /* exited */
      }
      await parent.status;
    }
  }
  console.log("Session VM lifecycle checks passed");
} finally {
  await f.close();
}
