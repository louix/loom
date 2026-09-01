/**
 * Background process tools for aisdk sessions — the OpenAI-compatible
 * counterpart to Claude Code's run_in_background / BashOutput / KillShell
 * (Claude sessions get those natively). Each task is a detached `bash -c` in
 * its own process group, so a kill takes descendants (dev servers, watchers)
 * with it; output is merged and buffered per task behind a read cursor:
 *
 *   - `background`         — start a task, get `bg-N` back immediately
 *   - `background_output`  — read what's new since the last read (filter/wait)
 *   - `background_kill`    — kill the task's process group, return the tail
 *
 * The unread buffer is clamped live (head + tail, same shape as the bash
 * tool's) so a dev server that logs for an hour cannot grow memory.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { MAX_OUTPUT_BYTES, collapseLive } from "./bash.ts";

/** Default wall-clock limit per task; `timeout_ms: 0` runs without one. */
export const DEFAULT_BG_TIMEOUT_MS = 600_000;
const MAX_RUNNING = 8;
const MAX_WAIT_MS = 30_000;

interface Task {
  id: string;
  child: ChildProcess;
  /** Output since the last read, clamped live by {@link collapseLive}. */
  unread: string;
  /** Characters the live clamp discarded since the last read. */
  dropped: number;
  running: boolean;
  exitCode: number | null;
  /** Set when the timeout — not the model — killed the task. */
  timedOut: boolean;
  timer: NodeJS.Timeout | null;
  /** Wakes a pending `read(waitMs)` on new output or exit. */
  wake: (() => void) | null;
}

export interface BackgroundReadResult {
  running: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

export class BackgroundTasks {
  readonly #cwd: string;
  readonly #tasks = new Map<string, Task>();
  #nextId = 1;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  /** Spawn `command` detached in its own process group; returns the id at once. */
  start(command: string, timeoutMs: number = DEFAULT_BG_TIMEOUT_MS): string {
    const running = [...this.#tasks.values()].filter((t) => t.running).length;
    if (running >= MAX_RUNNING) {
      throw new Error(
        `${running} background tasks are already running — kill one with background_kill first`,
      );
    }
    const id = `bg-${this.#nextId++}`;
    const child = spawn("bash", ["--noprofile", "--norc", "-c", command], {
      cwd: this.#cwd,
      env: { ...process.env },
      // stdin ignored: a background task must never block waiting for input.
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group — see killGroup
    });
    const task: Task = {
      id,
      child,
      unread: "",
      dropped: 0,
      running: true,
      exitCode: null,
      timedOut: false,
      timer: null,
      wake: null,
    };
    this.#tasks.set(id, task);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    // A late write to a dead stdio stream must not crash the daemon (see bash.ts).
    for (const s of [child.stdout, child.stderr]) s?.on("error", () => {});
    const onData = (d: string): void => {
      task.unread += d;
      if (task.unread.length > MAX_OUTPUT_BYTES) {
        const before = task.unread.length;
        task.unread = collapseLive(task.unread);
        task.dropped += before - task.unread.length;
      }
      task.wake?.();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      task.running = false;
      task.exitCode = code;
      if (task.timer) {
        clearTimeout(task.timer);
        task.timer = null;
      }
      task.wake?.();
    });
    child.on("error", (err) => {
      // Spawn failure (bash missing, ENOMEM): surface it as the task's output.
      task.running = false;
      task.unread += `bash: ${err.message}\n`;
      task.wake?.();
    });
    if (timeoutMs > 0) {
      task.timer = setTimeout(() => {
        if (!task.running) return;
        task.timedOut = true;
        killGroup(task);
      }, timeoutMs);
      task.timer.unref(); // never keep the process alive just to kill a task
    }
    return id;
  }

  /**
   * Output since the last read (which resets the cursor). `waitMs` waits for
   * new output or exit before returning; `filter` keeps only matching lines.
   */
  async read(
    id: string,
    opts: { filter?: string; waitMs?: number } = {},
  ): Promise<BackgroundReadResult> {
    const task = this.#task(id);
    const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, Math.trunc(opts.waitMs ?? 0)));
    if (waitMs > 0 && task.unread === "" && task.running) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          task.wake = null;
          resolve();
        }, waitMs);
        task.wake = () => {
          clearTimeout(t);
          task.wake = null;
          resolve();
        };
      });
    }
    let output = task.unread;
    const dropped = task.dropped;
    task.unread = "";
    task.dropped = 0;
    if (output === "") output = "(no new output)";
    else if (dropped > 0) output = `[~${dropped} earlier characters were dropped]\n${output}`;
    if (opts.filter && output !== "(no new output)") {
      let re: RegExp;
      try {
        re = new RegExp(opts.filter);
      } catch {
        throw new Error(`invalid filter regex: ${opts.filter}`);
      }
      const lines = output.split("\n");
      const kept = lines.filter((l) => re.test(l));
      output =
        `${kept.length} of ${lines.length} lines matched /${opts.filter}/:\n` + kept.join("\n");
    }
    return { running: task.running, exitCode: task.exitCode, timedOut: task.timedOut, output };
  }

  /** Kill the task's process group (descendants included); returns the unread tail. */
  kill(id: string): { output: string } {
    const task = this.#task(id);
    if (task.running) killGroup(task);
    const output = task.unread === "" ? "(no output)" : task.unread;
    task.unread = "";
    task.dropped = 0;
    return { output };
  }

  /** Kill everything — the session is going away. */
  close(): void {
    for (const task of this.#tasks.values()) {
      if (task.timer) clearTimeout(task.timer);
      if (task.running) killGroup(task);
      task.wake?.();
    }
    this.#tasks.clear();
  }

  #task(id: string): Task {
    const task = this.#tasks.get(id);
    if (!task) {
      const live = [...this.#tasks.values()].filter((t) => t.running).map((t) => t.id);
      throw new Error(
        `unknown background task "${id}"` +
          (live.length > 0 ? ` — running: ${live.join(", ")}` : " — none are running"),
      );
    }
    return task;
  }
}

const killGroup = (task: Task): void => {
  const c = task.child;
  // Negative pid = the whole process group (bash was spawned detached), so
  // descendants the command started go too — same as BashShell.#kill.
  if (typeof c.pid === "number") {
    try {
      process.kill(-c.pid, "SIGKILL");
      return;
    } catch {
      // group already gone / never formed — fall through to the direct kill
    }
  }
  c.kill("SIGKILL");
};

export const backgroundTools = (tasks: BackgroundTasks): ToolSet => {
  return {
    background: tool({
      description:
        "Start a long-running command (dev server, watch mode, big test suite) in the " +
        "background and return its task id immediately — the session's bash shell stays " +
        "free. Read output with background_output; stop the task with background_kill. " +
        "The command runs in its own process group, so killing it also kills anything it " +
        "started. Default timeout 10 minutes; timeout_ms: 0 runs until exit or kill.",
      inputSchema: z.object({
        command: z.string().describe("The bash command to run in the background."),
        timeout_ms: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            `Wall-clock timeout in milliseconds (default ${DEFAULT_BG_TIMEOUT_MS}); 0 disables the timeout.`,
          ),
      }),
      execute: async ({ command, timeout_ms }) => {
        return { id: tasks.start(command, timeout_ms ?? DEFAULT_BG_TIMEOUT_MS) };
      },
    }),
    background_output: tool({
      description:
        "Read a background task's output since the last read (the cursor then resets) and " +
        "whether the task is still running. Optionally wait up to wait_ms for new output " +
        "or exit before returning, and/or keep only lines matching a regex. The exit code " +
        "arrives once the task has exited; timed_out is true when the timeout killed it.",
      inputSchema: z.object({
        id: z.string().describe('The task id, e.g. "bg-1".'),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_MS)
          .optional()
          .describe("Wait up to this many milliseconds for new output or exit (default 0)."),
        filter: z
          .string()
          .optional()
          .describe("Regex; only lines matching it are returned, with a match-count header."),
      }),
      execute: async ({ id, wait_ms, filter }) => {
        const r = await tasks.read(id, {
          ...(wait_ms !== undefined ? { waitMs: wait_ms } : {}),
          ...(filter !== undefined ? { filter } : {}),
        });
        return {
          running: r.running,
          exit_code: r.exitCode,
          timed_out: r.timedOut,
          output: r.output,
        };
      },
    }),
    background_kill: tool({
      description:
        "Kill a background task and its whole process group (children included). Returns " +
        "the output that had not been read yet. Already-exited tasks need no kill.",
      inputSchema: z.object({
        id: z.string().describe('The task id, e.g. "bg-1".'),
      }),
      execute: async ({ id }) => tasks.kill(id),
    }),
  } as ToolSet;
};
