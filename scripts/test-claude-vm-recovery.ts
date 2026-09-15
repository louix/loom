/** Ready VM recovery after both owners die; no credentials or API usage. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitFixture } from "./lib/git-fixture.ts";
import { readFrames } from "../runtime/src/worker/transport.ts";
import { Daemon } from "../backend/daemon/src/daemon/daemon.ts";
import {
  sessionVmDirectory,
  stoppedSessionVm,
} from "../backend/daemon/src/daemon/session-vm-state.ts";
import { lockSessionState, SessionVmBusyError } from "../runtime/src/session-vm/persistence.ts";
import { readRecovery } from "../runtime/src/session-vm/recovery.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { setLogLevel } from "@loom/core/logger";
const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm, "Pass Claude runtime and smolvm executable");
setLogLevel("error");
const f = await gitFixture();
Deno.env.set("XDG_STATE_HOME", join(f.root, "persistent"));
Deno.env.set("XDG_CONFIG_HOME", join(f.root, "config"));
await Deno.mkdir(join(f.root, "config/loom"), { recursive: true });
await Deno.writeTextFile(
  join(f.root, "config/loom/config.jsonc"),
  `{
  "titles": {
    "enabled": false
  }
}`,
);
let daemon: Daemon | undefined;
let success = false;
try {
  for (const phase of ["ready"]) {
    const dir = sessionVmDirectory(f.repo, `orphan-${phase}`);
    const parent = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        fileURLToPath(new URL("lib/claude-vm-parent.ts", import.meta.url)),
        artifact,
        smolvm,
        f.workspace,
        dir,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    const frames = readFrames(
      parent.stdout,
      (v) => v as { kind: string; state?: string; pid?: number },
    );
    let supervisor = 0;
    try {
      for await (const frame of frames) {
        if (frame.pid) supervisor = frame.pid;
        if (frame.kind === phase) break;
      }
      assert(supervisor);
      // Freeze the parent first so it cannot race in and perform fallback cleanup.
      Deno.kill(parent.pid, "SIGSTOP");
      Deno.kill(supervisor, "SIGKILL");
      parent.kill("SIGKILL");
      await parent.status;
      const deadline = Date.now() + 10_000;
      for (;;) {
        try {
          (await lockSessionState(dir)).close();
          break;
        } catch (error) {
          if (!(error instanceof SessionVmBusyError)) throw error;
          assert(Date.now() < deadline);
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      const record = await readRecovery(dir);
      assert(record);
      await Deno.writeTextFile(join(dir, "profile/acceptance-history"), "retained");
      daemon = await Daemon.start({
        repoRoot: f.repo,
        standalone: true,
        connectors: { "@loom/connector-mock": () => import("@loom/connector-mock") },
      });
      assert.equal(await readRecovery(dir), undefined, "Startup did not recover abandoned VM");
      await assert.rejects(Deno.stat(record.state), Deno.errors.NotFound);
      assert.equal(await Deno.readTextFile(join(dir, "profile/acceptance-history")), "retained");
      await daemon.stop("recovery-test");
      daemon = undefined;
      // A new owner can use the preserved profile after recovery.
      const worker = await launchSessionVm({
        artifact,
        smolvm,
        workspace: f.workspace,
        sessionDirectory: dir,
        auth: { ANTHROPIC_API_KEY: "disposable-test-key" },
      });
      try {
        const { session } = await RemoteWorkerSession.connect(
          "recovered",
          "mock",
          mockLaunchSpec(f.workspace),
          () => worker,
          120_000,
        );
        await session.close();
      } finally {
        worker.terminate();
        await worker.cleanup?.();
      }
      await stoppedSessionVm(f.repo, `orphan-${phase}`, true);
      await assert.rejects(Deno.stat(join(dir, "profile")), Deno.errors.NotFound);
      console.log(
        JSON.stringify({ phase, recovered: true, historyRetained: true, newOwnerStarted: true }),
      );
    } finally {
      try {
        parent.kill("SIGKILL");
      } catch {
        /*exited*/
      }
      await parent.status;
      await frames.return(undefined);
    }
  }
  success = true;
} finally {
  await daemon?.stop("recovery-test-finally");
  if (success) await f.close();
  else console.error(`Recovery fixture retained: ${f.root}`);
}
