/** Disposable parent process for testing actual parent death, not just cooperative close. */
import { startRuntimeMcp } from "../../backend/daemon/src/daemon/runtime-mcp.ts";
import { launchLocalWorker } from "../../backend/daemon/src/daemon/worker-launch.ts";
const [runtime, workspace] = Deno.args;
if (!runtime || !workspace) throw new Error("Expected runtime and disposable worktree");
const worker = await startRuntimeMcp("tilth", runtime, workspace, (spec) => {
  const child = launchLocalWorker(spec);
  console.log(JSON.stringify({ kind: "starting", state: spec.cwd, pid: child.pid }));
  return child;
});
console.log(JSON.stringify({ kind: "ready" }));
await worker.exited;
await worker.close();
