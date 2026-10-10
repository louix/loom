/**
 * Terminates a process group whose shell takes 500 ms to unwind after SIGTERM,
 * then prints how the shell ended. Run without read access to /proc and without
 * `ps`: the group must still be watched (by `kill(-pgid, 0)`), not killed blind.
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { terminateProcessGroup } from "../../core/src/process-group.ts";

const child = spawn("sh", ["-c", "trap 'sleep 0.5; exit 7' TERM; while :; do sleep 0.05; done"], {
  detached: true,
  stdio: "ignore",
  // A denied `ps` narrows --allow-run, which then refuses LD_* variables.
  env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
});
const ended = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
  child.once("exit", (code, signal) => resolve({ code, signal })),
);
await delay(100);
await terminateProcessGroup(child.pid!, 5_000);
console.log(JSON.stringify(await ended));
