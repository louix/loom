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
/**
 * Live cap on the accumulating output buffer. `clamp()` only runs once the
 * command's sentinel arrives — a command that streams gigabytes first (`yes`,
 * `cat /dev/urandom | base64`) would grow `#buf` until V8 throws
 * `Invalid string length` or the daemon OOMs. Collapse to head + tail on the
 * fly instead; the sentinel line is always in the retained tail.
 */
const MAX_LIVE_BYTES = 512 * 1024;

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
      // Own process group, so a timeout / reset SIGKILLs anything the command
      // backgrounded (dev servers, `foo &`) instead of orphaning it — see #kill.
      detached: true,
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    // A late/buffered write to a stdio stream of a process that failed to spawn
    // emits an unhandled 'error' (EPIPE / ERR_STREAM_DESTROYED) that would crash
    // the daemon — the `child.on("error")` below only covers the ChildProcess.
    for (const s of [child.stdin, child.stdout, child.stderr]) s?.on("error", () => {});
    const onData = (d: string): void => {
      this.#buf += d;
      if (this.#buf.length > MAX_LIVE_BYTES) this.#buf = collapseLive(this.#buf);
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
   * Detect an *unclosed* construct (quote / heredoc) that would make the
   * persistent shell keep reading and never emit the sentinel — a full-timeout
   * wedge. A plain syntax error is NOT rejected: the command group aborts,
   * prints the error, and the sentinel still arrives, so `if;then`, an extglob
   * pattern used after `shopt -s extglob`, etc. run in the shell as before.
   */
  #unclosedConstruct(command: string): Promise<string | null> {
    // Only an odd quote count or a heredoc can cause the wedge — skip the fork
    // for anything else (which is the overwhelming majority of commands).
    const bare = command.replace(/\\./g, "");
    const odd = (c: string): boolean => (bare.split(c).length - 1) % 2 === 1;
    if (!odd("'") && !odd('"') && !command.includes("<<")) return Promise.resolve(null);

    return new Promise((resolve) => {
      let stderr = "";
      const c = spawn("bash", ["--noprofile", "--norc", "-n", "-c", command], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      c.stderr?.setEncoding("utf8");
      c.stderr?.on("data", (d: string) => (stderr += d));
      c.on("error", () => resolve(null)); // can't check → let the real run surface it
      c.on("close", (code) => {
        // An unterminated heredoc: `bash -n` exits 0 but warns.
        if (/here-document.*delimited by end-of-file|warning: here-document/i.test(stderr)) {
          return resolve(stderr.trim() || "bash: unterminated here-document");
        }
        if (code === 0) return resolve(null);
        // Non-zero: only the "still waiting for a closing token" classes wedge.
        return resolve(
          /unexpected EOF|end of file|unterminated/i.test(stderr)
            ? stderr.trim() || "bash: unterminated quote"
            : null,
        );
      });
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
      // A trailing line-continuation backslash splices the command group's
      // closing `}` onto the command, so bash never sees the terminator and the
      // sentinel never prints — a silent full-timeout wedge. Same for a dangling
      // `|` / `&&` / `||`. Reject up front (bash -n doesn't reliably catch these
      // in the wrapped form).
      const tail = command.replace(/\s+$/, "");
      if (/(?:^|[^\\])(?:\\\\)*\\$/.test(tail)) {
        return {
          output: "bash: command ends with a line-continuation backslash — drop the trailing '\\'",
          exitCode: 2,
          timedOut: false,
        };
      }
      if (/(?:\|\||&&|\|)$/.test(tail)) {
        return {
          output: "bash: command ends with a dangling '|', '&&' or '||'",
          exitCode: 2,
          timedOut: false,
        };
      }
      const unclosed = await this.#unclosedConstruct(command);
      if (unclosed) {
        return { output: unclosed, exitCode: 2, timedOut: false };
      }
      const child = this.#ensure();
      const marker = `__LOOM_${randomBytes(12).toString("hex")}__`;
      // Anchor the marker to a line start. With `set -x` left on, bash echoes
      // the sentinel line to the merged stream as `+ printf … <marker> 0` — the
      // marker there is preceded by a space, so an anchored match skips it and
      // only the real `\n<marker> N\n` sentinel is picked up.
      const re = new RegExp(`(?:^|\\n)${marker} (-?\\d+)\\n`);
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
    const c = this.#child;
    this.#child = null;
    this.#buf = "";
    if (!c) return;
    // Kill the whole process group (bash was spawned detached) so descendants
    // the command left running go too. Negative pid = the group.
    if (typeof c.pid === "number") {
      try {
        process.kill(-c.pid, "SIGKILL");
        return;
      } catch {
        // group already gone / never formed — fall through to the direct kill
      }
    }
    c.kill("SIGKILL");
  }

  close(): void {
    this.#kill();
  }
}

const clamp = (s: string): string => {
  if (Buffer.byteLength(s, "utf8") <= MAX_OUTPUT_BYTES) return s;
  const head = s.slice(0, HEAD_BYTES);
  const tail = s.slice(-(MAX_OUTPUT_BYTES - HEAD_BYTES));
  return `${head}\n… [output truncated] …\n${tail}`;
};

/** In-stream collapse when the buffer outgrows {@link MAX_LIVE_BYTES}. Head +
 *  tail total stays just under `MAX_OUTPUT_BYTES` so the final `clamp()` is a
 *  no-op (no doubled truncation marker); the tail is wide enough that a
 *  not-yet-arrived sentinel line is never cut off. */
const collapseLive = (s: string): string => {
  const head = s.slice(0, HEAD_BYTES);
  const tail = s.slice(-(MAX_OUTPUT_BYTES - HEAD_BYTES - 100));
  return `${head}\n… [output truncated mid-stream] …\n${tail}`;
};

export const bashTool = (shell: BashShell) => {
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
};
