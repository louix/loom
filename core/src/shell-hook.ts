import process from "node:process";
import { spawn } from "node:child_process";
import { escalateProcessGroup } from "./process-group.ts";
const OUTPUT_CAP = 8_000;
export interface HookAttempt {
  code: number;
  output: string;
  timedOut: boolean;
}
type Attempt = HookAttempt;
/** Trusted shell command with bounded output, timeout, and process-group cancellation. */
export const executeShellHook = (
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal,
  output?: "inherit",
): Promise<HookAttempt> => {
  signal.throwIfAborted();
  return new Promise<Attempt>((settle, fail) => {
    // `detached` puts the command in its own process group, so the timeout
    // below can take its children with it — `sh -c 'tsc | head'` that wedges
    // would otherwise survive a signal aimed at the shell alone.
    const child = spawn("sh", ["-c", command], {
      cwd,
      env,
      stdio: ["ignore", output ?? "pipe", output ?? "pipe"],
      detached: true,
    });
    let out = "";
    let timedOut = false;
    const append = (chunk: Buffer): void => {
      if (out.length < OUTPUT_CAP) out += chunk.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    // A hook may be running `git`: SIGTERM first so it can drop its index.lock.
    const kill = (): void => {
      const pid = child.pid;
      try {
        if (pid !== undefined) {
          process.kill(-pid, "SIGTERM");
          void escalateProcessGroup(pid);
          return;
        }
      } catch {
        // group already gone — try the shell itself
      }
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal.addEventListener("abort", kill, { once: true });
    timer.unref();
    child.on("error", (err) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      fail(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      const text = out.length > OUTPUT_CAP ? `${out.slice(0, OUTPUT_CAP)}\n… [truncated]` : out;
      settle({ code: code ?? 1, output: text.trim(), timedOut });
    });
  });
};
