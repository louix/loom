/**
 * Worker requests larger than a pipe read must reach the guest. smolvm before 1.16.2
 * stranded `machine exec -i` stdin past 4096 bytes until more input arrived, and the
 * worker protocol sends one frame and then waits, so such a request hung forever.
 */
import assert from "node:assert/strict";
import { gitFixture } from "./lib/git-fixture.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm, "Pass rebuilt session runtime and smolvm");
const f = await gitFixture();
try {
  const worker = await launchSessionVm({
    workspace: f.workspace,
    repoRoot: f.repo,
    artifact,
    smolvm,
    auth: {},
    providerHosts: [],
  });
  try {
    const { session } = await RemoteWorkerSession.connect(
      "frames",
      "mock",
      mockLaunchSpec(f.workspace),
      () => worker,
      { startupMs: 200_000, requestMs: 10_000 },
    );
    try {
      // A create request with long paths and a real prompt is already past 4096 bytes.
      await session.start({
        method: "create",
        args: [
          {
            sessionId: "frames",
            cwd: f.workspace,
            prompt: "p".repeat(6000),
            mode: "default",
            mcpServers: [],
          },
        ],
      });
      for (const size of [4096, 4097, 8192, 8193, 65_536, 900_000])
        await session.send("x".repeat(size));
      console.log("Passed: worker requests from 4 KiB to 900 KB reach the guest");
    } finally {
      await session.close();
    }
  } finally {
    worker.terminate();
    await worker.cleanup?.();
  }
} finally {
  await f.close();
}
