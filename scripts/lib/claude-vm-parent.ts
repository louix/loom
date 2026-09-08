/** Disposable owner for real parent-SIGKILL acceptance tests. No live credentials. */
import { launchSessionVm } from "../../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../../backend/daemon/src/daemon/worker-launch.ts";
const [artifact, smolvm, workspace, sessionDirectory] = Deno.args;
if (!artifact || !smolvm || !workspace) throw new Error("Expected artifact, smolvm, workspace");
const worker = await launchSessionVm({
  artifact,
  smolvm,
  workspace,
  ...(sessionDirectory ? { sessionDirectory } : {}),
  auth: { ANTHROPIC_API_KEY: "disposable-test-key" },
});
console.log(JSON.stringify({ kind: "starting", state: worker.binding.state, pid: worker.pid }));
await RemoteWorkerSession.connect(
  "lifecycle-parent",
  "mock",
  mockLaunchSpec(workspace),
  () => worker,
  120_000,
);
console.log(JSON.stringify({ kind: "ready", ...(await worker.status()) }));
await worker.exited;
await worker.cleanup?.();
