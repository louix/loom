/**
 * A persistent-shell Bash tool for aisdk sessions — the OpenAI-compatible
 * counterpart to Claude Code's built-in Bash. One long-lived `bash` process per
 * session: the working directory and exported environment carry between calls.
 * stdout and stderr are merged (`exec 2>&1`), commands are delimited with a
 * random sentinel so we can read exactly one command's output and its exit
 * code, and a per-command wall-clock timeout kills and resets the shell.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";

export const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 120_000;
const HEAD_BYTES = 80_000;

export class BashShell {
  readonly #cwd: string;
  #child: ChildProcess | null = null;
  #buf = "";
  #wake: (() => void) | null = null;
  #busy = false;
  /** Set when the shell can't be spawned (bash missing, ENOMEM, sandbox). */
  #spawnError: Error | null = null;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  #ensure(): ChildProcess {
    const c = this.#child;
    if (c && c.exitCode === null && !c.killed) return c;
    this.#spawnError = null;
    const child = spawn("bash", ["--noprofile", "--norc"], {
      cwd: this.#cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const onData = (d: string): void => {
      this.#buf += d;
      this.#wake?.();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // Without this, a spawn failure throws as an unhandled 'error' event and
    // takes the whole daemon down. `run()` surfaces `#spawnError` instead.
    child.on("error", (err) => {
      if (this.#child === child) this.#child = null;
      this.#spawnError = err instanceof Error ? err : new Error(String(err));
      this.#wake?.();
    });
    child.on("exit", () => {
      if (this.#child === child) this.#child = null;
    });
    child.stdin?.write("exec 2>&1\n"); // merge stderr into stdout for the session
    this.#child = child;
    this.#buf = "";
    return child;
  }

  /**
   * `bash -n` on the command alone. Catches an unbalanced quote / unterminated
   * heredoc *before* it reaches the persistent shell, where it would swallow
   * the sentinel `printf` and wedge the shell for the full timeout.
   */
  #syntaxError(command: string): Promise<string | null> {
    return new Promise((resolve) => {
      let stderr = "";
      const c = spawn("bash", ["--noprofile", "--norc", "-n", "-c", command], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      c.stderr?.setEncoding("utf8");
      c.stderr?.on("data", (d: string) => (stderr += d));
      c.on("error", () => resolve(null)); // can't check → let the real run surface it
      c.on("close", (code) => resolve(code === 0 ? null : (stderr.trim() || "bash: syntax error")));
      setTimeout(() => {
        c.kill("SIGKILL");
        resolve(null);
      }, 5_000).unref();
    });
  }

  async run(
    command: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
    if (this.#busy) throw new Error("the bash shell is busy with another command");
    this.#busy = true;
    try {
      const syntax = await this.#syntaxError(command);
      if (syntax) {
        return { output: syntax, exitCode: 2, timedOut: false };
      }
      const child = this.#ensure();
      const marker = `__LOOM_${randomBytes(12).toString("hex")}__`;
      const re = new RegExp(`\\n?${marker} (-?\\d+)\\n`);
      this.#buf = "";
      // Group command (not a subshell) so `cd` / `export` persist; the `}` on
      // its own line closes it without a stray `;`. Redirect the group's stdin
      // from /dev/null so a `read` in the command gets EOF instead of eating
      // the sentinel `printf` that follows. Then print the sentinel + exit code.
      child.stdin?.write(`{\n${command}\n} </dev/null\nprintf '\\n%s %d\\n' '${marker}' "$?"\n`);

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const m = this.#buf.match(re);
        if (m && m.index !== undefined) {
          const output = this.#buf.slice(0, m.index);
          this.#buf = "";
          return { output: clamp(output), exitCode: Number(m[1]), timedOut: false };
        }
        if (this.#spawnError) {
          const msg = this.#spawnError.message;
          this.#spawnError = null;
          return { output: `bash: ${msg}`, exitCode: null, timedOut: false };
        }
        if (this.#child !== child || child.exitCode !== null || child.killed) {
          // The shell died (the command ran `exit`, `kill $$`, crashed it…).
          const partial = this.#buf;
          this.#buf = "";
          this.#child = null;
          return {
            output: `${clamp(partial)}\n[the shell exited — it was reset, so cwd and env are back to defaults]`,
            exitCode: null,
            timedOut: false,
          };
        }
        if (Date.now() >= deadline) {
          const partial = this.#buf;
          this.#kill();
          return {
            output: `${clamp(partial)}\n[timed out after ${timeoutMs}ms — the shell was reset, so cwd and env are back to defaults]`,
            exitCode: null,
            timedOut: true,
          };
        }
        await this.#waitForOutput(Math.min(50, Math.max(1, deadline - Date.now())));
      }
    } finally {
      this.#busy = false;
    }
  }

  #waitForOutput(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.#wake = null;
        resolve();
      }, ms);
      this.#wake = () => {
        clearTimeout(t);
        this.#wake = null;
        resolve();
      };
    });
  }

  #kill(): void {
    this.#child?.kill("SIGKILL");
    this.#child = null;
    this.#buf = "";
  }

  close(): void {
    this.#kill();
  }
}

function clamp(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= MAX_OUTPUT_BYTES) return s;
  const head = s.slice(0, HEAD_BYTES);
  const tail = s.slice(-(MAX_OUTPUT_BYTES - HEAD_BYTES));
  return `${head}\n… [output truncated] …\n${tail}`;
}

export function bashTool(shell: BashShell) {
  return tool({
    description:
      "Run a command in this session's persistent bash shell. The working " +
      "directory and exported environment persist between calls. stdout and " +
      "stderr are merged. Returns the combined output and the exit code.",
    inputSchema: z.object({
      command: z.string().describe("The bash command to run."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Wall-clock timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).`),
    }),
    execute: async ({ command, timeout_ms }) => {
      const r = await shell.run(command, timeout_ms ?? DEFAULT_TIMEOUT_MS);
      return { output: r.output, exit_code: r.exitCode, timed_out: r.timedOut };
    },
  });
}
