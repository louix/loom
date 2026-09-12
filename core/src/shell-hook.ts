import process from "node:process";
import { spawn } from "node:child_process";
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
): Promise<HookAttempt> => {
  signal.throwIfAborted();
  return new Promise<Attempt>((settle, fail) => {
    // `detached` puts the command in its own process group, so the timeout
    // below can take its children with it — `sh -c 'tsc | head'` that wedges
    // would otherwise survive a signal aimed at the shell alone.
    const child = spawn("sh", ["-c", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let out = "";
    let timedOut = false;
    const append = (chunk: Buffer): void => {
      if (out.length < OUTPUT_CAP) out += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const kill = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL"); // group already gone, or no pid — try the shell itself
      }
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
