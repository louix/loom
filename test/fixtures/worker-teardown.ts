/**
 * Tears a process-group worker down the way RemoteWorkerSession.#close does — exit
 * awaited, then the frame reader aborted — while the worker's grandchild still owns
 * stdout. Prints "clean" only if no unhandled error killed the process first.
 */
import { fileURLToPath } from "node:url";
import {
  launchLocalWorker,
  mockLaunchSpec,
} from "../../backend/daemon/src/daemon/worker-launch.ts";
import { readFrames } from "../../runtime/src/worker/transport.ts";

const spec = mockLaunchSpec(Deno.cwd());
const proc = launchLocalWorker({
  ...spec,
  entrypoint: fileURLToPath(new URL("orphaned-stdout-worker.ts", import.meta.url)),
  permissions: {
    ...spec.permissions,
    read: [...spec.permissions.read, Deno.execPath()],
    run: [Deno.execPath()],
  },
  processGroup: true,
});
const stop = new AbortController();
const frames = readFrames(proc.output, (value) => value, stop.signal);
await frames.next();
const pending = frames.next();
await proc.exited;
stop.abort();
await pending;
proc.terminate();
// Long enough for a rejection queued by the cancel to surface.
await new Promise((resolve) => setTimeout(resolve, 500));
console.log("clean");
