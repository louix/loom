/** One Bash process per command; every call starts from the session environment. */
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { toolSpawnEnv } from "./spawn-env.ts";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_BYTES = 120_000;
const HEAD_BYTES = 80_000;
const MAX_LIVE_BYTES = 512 * 1024;

export class BashShell {
  readonly #cwd: string;
  #child: ChildProcess | null = null;

  constructor(cwd: string) {
    this.#cwd = resolve(cwd);
  }

  async run(
    command: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cwd = this.#cwd,
    signal?: AbortSignal,
  ): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
    if (this.#child) throw new Error("the bash shell is busy with another command");
    signal?.throwIfAborted();
    const child = spawn("bash", ["--noprofile", "--norc", "-c", command], {
      cwd: resolve(this.#cwd, cwd),
      env: toolSpawnEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.#child = child;
    return await new Promise((settle) => {
      let output = "";
      let timedOut = false;
      let error: Error | undefined;
      const append = (chunk: string) => {
        output += chunk;
        if (output.length > MAX_LIVE_BYTES) output = collapseLive(output);
      };
      child.stdout!.setEncoding("utf8").on("data", append);
      child.stderr!.setEncoding("utf8").on("data", append);
      const kill = () => killGroup(child);
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      signal?.addEventListener("abort", kill, { once: true });
      child.once("error", (err) => {
        error = err;
      });
      // A command can leave descendants holding stdout open. They belong to
      // this command; durable servers/jobs must use the background tools.
      child.once("exit", kill);
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", kill);
        this.#child = null;
        if (error) output += `\nbash: ${error.message}`;
        if (timedOut) output += `\n[timed out after ${timeoutMs}ms]`;
        settle({
          output: Buffer.byteLength(output) > MAX_OUTPUT_BYTES ? collapseLive(output) : output,
          exitCode: error ? null : code,
          timedOut,
        });
      });
    });
  }

  close(): void {
    if (this.#child) killGroup(this.#child);
  }
}

const killGroup = (child: ChildProcess) => {
  if (child.pid !== undefined) {
    try {
      Deno.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Group already gone or never formed; try the shell itself.
    }
  }
  child.kill("SIGKILL");
};

/** Bounded head and tail, also used by background-task output buffers. */
export const collapseLive = (s: string): string => {
  const bytes = Buffer.from(s);
  const head = bytes.subarray(0, HEAD_BYTES).toString("utf8");
  const tail = bytes.subarray(-(MAX_OUTPUT_BYTES - HEAD_BYTES - 100)).toString("utf8");
  return `${head}\n… [output truncated] …\n${tail}`;
};

export const bashTool = (shell: BashShell) =>
  tool({
    description:
      "Run a command in a fresh Bash process. Each call starts in the session worktree " +
      "with the prepared environment; cd and export do not persist between calls. " +
      "Use cwd to select a working directory, and background for long-running jobs. " +
      "Returns combined stdout/stderr and the exit code.",
    inputSchema: z.object({
      command: z.string().describe("The bash command to run."),
      cwd: z
        .string()
        .optional()
        .describe("Working directory, absolute or relative to the session worktree."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Wall-clock timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).`),
    }),
    execute: async ({ command, timeout_ms, cwd }, { abortSignal }) => {
      const r = await shell.run(command, timeout_ms ?? DEFAULT_TIMEOUT_MS, cwd, abortSignal);
      return { output: r.output, exit_code: r.exitCode, timed_out: r.timedOut };
    },
  });
