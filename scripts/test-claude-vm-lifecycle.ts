/**
 * Real VM lifecycle acceptance; mock connector, no provider credentials or API calls.
 * LOOM_TEST_LAUNCHER=isolation runs it on the isolation launcher, where the worker is
 * an execution beside the environment's own guest: "worker exec SIGKILL" then kills
 * the worker alone, and "guest exec SIGKILL" kills the environment under it.
 * "VM process SIGKILL" kills the VMM itself: its executions end before its supervisor
 * notices, and the session must still get the VM's diagnosis.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { readFrames } from "../runtime/src/worker/transport.ts";
import { gitFixture } from "./lib/git-fixture.ts";
import { hostProcesses } from "./lib/host-processes.ts";
import { launchTestSessionVm, testLauncher, type TestSessionWorker } from "./lib/session-launch.ts";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";
import { VmTerminationError } from "../core/src/vm-termination.ts";
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
        if (Deno.build.os === "linux") {
          const stat = await Deno.readTextFile(`/proc/${pid}/stat`);
          if (/\) Z /.test(stat)) break; // terminated, awaiting the host init's reap
        } else {
          Deno.kill(pid, 0);
        }
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
// Keep this run's VM inventory and session state out of the user's.
Deno.env.set("XDG_STATE_HOME", join(f.root, "xdg-state"));
const sessionDirectory = sessionVmDirectory(f.repo, "lifecycle");
const modes = [
  "close",
  "startup EOF",
  "supervisor SIGKILL",
  "guest exec SIGKILL",
  "VM process SIGKILL",
];
/** smolvm's VMM process for this VM, found through its runtime state path. */
const vmmPid = async (state: string) =>
  (await hostProcesses()).find(
    (process) => process.text.includes("_boot-vm") && process.text.includes(state),
  )?.pid;
if (testLauncher === "isolation") modes.push("worker exec SIGKILL");
try {
  for (const mode of modes) {
    console.error(`Testing ${mode}`);
    const launch = (): Promise<TestSessionWorker> =>
      launchTestSessionVm({
        artifact,
        smolvm,
        workspace: f.workspace,
        repoRoot: f.repo,
        sessionDirectory,
        auth: { ANTHROPIC_API_KEY: "disposable-test-key" },
      });
    const worker = await launch();
    let session: RemoteWorkerSession | undefined;
    const supervisor = await worker.supervisor();
    assert(supervisor, "found the VM supervisor");
    const pids = [worker.pid, supervisor];
    try {
      if (mode.startsWith("startup EOF")) {
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
        if (mode === "close" && testLauncher === "isolation") {
          // The adapter refuses a second generation while one is live.
          await assert.rejects(launch(), /already running|still running/);
          assert.equal((await worker.status()).phase, "running");
        } else if (mode === "close") {
          const duplicate = await launch();
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
        if (ready.execPid) pids.push(ready.execPid);
        if (mode === "supervisor SIGKILL") Deno.kill(supervisor, "SIGKILL");
        else if (mode === "worker exec SIGKILL") Deno.kill(worker.pid, "SIGKILL");
        else if (mode === "VM process SIGKILL") {
          const vmm = await vmmPid(worker.binding.state);
          assert(vmm, "found the VMM process");
          Deno.kill(vmm, "SIGKILL");
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
      if (mode.endsWith("SIGKILL")) {
        // The VM's own diagnosis when it failed; the worker's exit when only it did.
        const failure = await worker.failure?.();
        assert(failure instanceof VmTerminationError, String(failure));
        console.error(mode + ": " + JSON.stringify(failure.termination));
        if (mode === "worker exec SIGKILL") {
          assert.equal(failure.termination.reason, "guest_exit");
          assert.equal(failure.termination.hostReason, "worker_failure");
        } else if (mode === "supervisor SIGKILL")
          assert.equal(failure.termination.supervisorExit?.signal, "SIGKILL");
        else assert.notEqual(failure.termination.hostReason, "worker_failure");
      }
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
        f.repo,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    const frames = readFrames(
      parent.stdout,
      (v) => v as { kind: string; state?: string; pid?: number; execPid?: number },
    );
    let state: string | undefined;
    let reached = false;
    const pids: number[] = [];
    try {
      for await (const frame of frames) {
        if (frame.state) state = frame.state;
        for (const pid of [frame.pid, frame.execPid]) if (pid) pids.push(pid);
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
