/** Disposable owner for real parent-SIGKILL acceptance tests. No live credentials. */
import { RemoteWorkerSession } from "../../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../../backend/daemon/src/daemon/worker-launch.ts";
import { launchTestSessionVm } from "./session-launch.ts";
const [artifact, smolvm, workspace, sessionDirectory, repoRoot] = Deno.args;
if (!artifact || !smolvm || !workspace) throw new Error("Expected artifact, smolvm, workspace");
const worker = await launchTestSessionVm({
  artifact,
  smolvm,
  workspace,
  ...(sessionDirectory ? { sessionDirectory } : {}),
  ...(repoRoot ? { repoRoot } : {}),
  auth: { ANTHROPIC_API_KEY: "disposable-test-key" },
});
// pid is the VM's supervisor; execPid is the worker execution.
const supervisor = await worker.supervisor();
console.log(
  JSON.stringify({
    kind: "starting",
    state: worker.binding.state,
    pid: supervisor,
    execPid: worker.pid,
  }),
);
await RemoteWorkerSession.connect(
  "lifecycle-parent",
  "mock",
  mockLaunchSpec(workspace),
  () => worker,
  120_000,
);
const status = await worker.status();
console.log(JSON.stringify({ kind: "ready", ...status, pid: supervisor }));
await worker.exited;
await worker.cleanup?.();
