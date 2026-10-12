/**
 * Leads its own group with nothing else in it, and without read access to /proc
 * ends that group as a worker exiting does; prints how long that took.
 */
import { terminateProcessGroup } from "../../core/src/process-group.ts";

// The group's SIGTERM reaches this process too.
Deno.addSignalListener("SIGTERM", () => {});
const started = Date.now();
await terminateProcessGroup(Deno.pid, 10_000);
console.log(JSON.stringify({ elapsed_ms: Date.now() - started }));
