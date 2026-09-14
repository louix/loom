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
import { absurd } from "@loom/core/absurd";
import { MAX_OUTPUT_BYTES, collapseLive } from "./bash.ts";
import { toolSpawnEnv } from "./spawn-env.ts";

/** Default wall-clock limit per task; `timeout_ms: 0` runs without one. */
export const DEFAULT_BG_TIMEOUT_MS = 600_000;
const MAX_RUNNING = 8;
/** Default `wait_ms` for `read`/`background_output` when the caller omits it. */
const DEFAULT_WAIT_MS = 30_000;
/** After a task exits, how long `read` still waits for its pipe to flush the
 *  last output before reporting "(no new output)". */
const DRAIN_MS = 250;

/**
 * A task's process lifecycle as one closed union — so "running with an exit
 * code" or "closed but still running" can't be written down:
 *
 *   running ──'exit'──▶ exited ──'close'──▶ closed
 *      └────────────────'error'──────────────▶ closed   (spawn failed: no exit code)
 *
 * `exited` and `closed` both mean the process is gone; they differ in whether
 * its stdout/stderr have finished draining into our buffer. A `read` keeps
 * waiting through `exited` — a fast command (`pwd`) can exit with its last line
 * still queued in the pipe — but not through `closed`. `timedOut` marks the
 * wall-clock timeout, not the model, as the killer; `timer` is that timeout's
 * pending handle and exists only while running.
 */
type TaskLifecycle =
  | { readonly phase: "running"; readonly timer: NodeJS.Timeout | null; readonly timedOut: boolean }
  | { readonly phase: "exited"; readonly exitCode: number | null; readonly timedOut: boolean }
  | { readonly phase: "closed"; readonly exitCode: number | null; readonly timedOut: boolean };

interface FoldTaskLifecycle<B> {
  readonly onRunning: (timer: NodeJS.Timeout | null, timedOut: boolean) => B;
  readonly onExited: (exitCode: number | null, timedOut: boolean) => B;
  readonly onClosed: (exitCode: number | null, timedOut: boolean) => B;
}

const foldTaskLifecycle =
  <B>(fns: FoldTaskLifecycle<B>) =>
  (l: TaskLifecycle): B => {
    switch (l.phase) {
      case "running":
        return fns.onRunning(l.timer, l.timedOut);
      case "exited":
        return fns.onExited(l.exitCode, l.timedOut);
      case "closed":
        return fns.onClosed(l.exitCode, l.timedOut);
      default:
        return absurd(l);
    }
  };

/** What `read` / `background_output` report about the process — derived from the
 *  lifecycle so the three fields can never disagree. */
const lifecycleReport = (
  l: TaskLifecycle,
): { running: boolean; exitCode: number | null; timedOut: boolean } =>
  foldTaskLifecycle<{ running: boolean; exitCode: number | null; timedOut: boolean }>({
    onRunning: () => ({ running: true, exitCode: null, timedOut: false }),
    onExited: (exitCode, timedOut) => ({ running: false, exitCode, timedOut }),
    onClosed: (exitCode, timedOut) => ({ running: false, exitCode, timedOut }),
  })(l);

interface Task {
  readonly id: string;
  readonly child: ChildProcess;
  /** Output since the last read, clamped live by {@link collapseLive}. */
  unread: string;
  /** Characters the live clamp discarded since the last read. */
  dropped: number;
  lifecycle: TaskLifecycle;
  /** Wakes a pending `read(waitMs)` on new output, exit, or close. */
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

  /** Tasks whose process is still alive. */
  #running(): Task[] {
    return [...this.#tasks.values()].filter((t) => t.lifecycle.phase === "running");
  }

  /** Spawn `command` detached in its own process group; returns the id at once. */
  start(command: string, timeoutMs: number = DEFAULT_BG_TIMEOUT_MS): string {
    const running = this.#running().length;
    if (running >= MAX_RUNNING) {
      throw new Error(
        `${running} background tasks are already running — kill one with background_kill first`,
      );
    }
    const id = `bg-${this.#nextId++}`;
    const child = spawn("bash", ["--noprofile", "--norc", "-c", command], {
      cwd: this.#cwd,
      env: toolSpawnEnv(),
      // stdin ignored: a background task must never block waiting for input.
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group — see killGroup
    });
    const task: Task = {
      id,
      child,
      unread: "",
      dropped: 0,
      lifecycle: { phase: "running", timer: null, timedOut: false },
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
      const timedOut = task.lifecycle.phase === "running" && task.lifecycle.timedOut;
      if (task.lifecycle.phase === "running" && task.lifecycle.timer) {
        clearTimeout(task.lifecycle.timer);
      }
      task.lifecycle = { phase: "exited", exitCode: code, timedOut };
      task.wake?.();
    });
    // Fires after `'exit'`, once stdout/stderr have flushed and closed — the
    // point at which a `read` can stop waiting for more output.
    child.on("close", () => {
      const { exitCode, timedOut } =
        task.lifecycle.phase === "running" ? { exitCode: null, timedOut: false } : task.lifecycle;
      task.lifecycle = { phase: "closed", exitCode, timedOut };
      task.wake?.();
    });
    child.on("error", (err) => {
      // Spawn failure (bash missing, ENOMEM): surface it as the task's output.
      // Neither `'exit'` nor `'close'` follows, so go straight to `closed`.
      task.lifecycle = { phase: "closed", exitCode: null, timedOut: false };
      task.unread += `bash: ${err.message}\n`;
      task.wake?.();
    });
    if (timeoutMs > 0) {
      // Spawn events are async — the task is still `running` here.
      const timer = setTimeout(() => {
        if (task.lifecycle.phase !== "running") return;
        task.lifecycle = { ...task.lifecycle, timedOut: true };
        killGroup(task);
      }, timeoutMs);
      timer.unref(); // never keep the process alive just to kill a task
      task.lifecycle = { phase: "running", timer, timedOut: false };
    }
    return id;
  }

  /**
   * Output since the last read (which resets the cursor). `waitMs` waits for
   * new output or exit before returning (default 30 s, no cap); `filter` keeps
   * only matching lines.
   */
  async read(
    id: string,
    opts: { filter?: string; waitMs?: number } = {},
  ): Promise<BackgroundReadResult> {
    const task = this.#task(id);
    // `wait_ms` has no upper cap, but Node timers clamp delays above 2^31-1 ms
    // down to fire (almost) immediately — pin huge waits there instead.
    const waitMs = Math.min(2_147_483_647, Math.max(0, Math.trunc(opts.waitMs ?? DEFAULT_WAIT_MS)));
    // A closure so the compiler can't stale-narrow `phase` across the `await`
    // (the event handlers reassign `task.lifecycle` while we're parked).
    const phase = (): TaskLifecycle["phase"] => task.lifecycle.phase;
    // Wait for output or a clean `'close'`. `'exit'` alone isn't enough: a
    // short-lived command (`pwd`) can exit with its last line still queued in
    // the pipe, and reading then would wrongly report "no new output". Once the
    // process has exited, cap the extra wait at a short drain window so a task
    // that left its stdio open (a detached grandchild) still returns fast.
    if (waitMs > 0 && task.unread === "" && phase() !== "closed") {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const draining = phase() !== "running";
        const slice = draining ? Math.min(remaining, DRAIN_MS) : remaining;
        const woke = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => {
            task.wake = null;
            resolve(false);
          }, slice);
          task.wake = () => {
            clearTimeout(t);
            task.wake = null;
            resolve(true);
          };
        });
        if (task.unread !== "" || phase() === "closed") break;
        if (!woke && draining) break; // drain window elapsed after exit
      }
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
    return { ...lifecycleReport(task.lifecycle), output };
  }

  /** Kill the task's process group (descendants included); returns the unread tail. */
  kill(id: string): { output: string } {
    const task = this.#task(id);
    if (task.lifecycle.phase === "running") killGroup(task);
    const output = task.unread === "" ? "(no output)" : task.unread;
    task.unread = "";
    task.dropped = 0;
    return { output };
  }

  /** Stop and await running processes, retaining their output for inspection. */
  async stopAll(): Promise<void> {
    await Promise.all(
      this.#running().map(
        (task) =>
          new Promise<void>((resolve, reject) => {
            const finish = (error?: Error): void => {
              clearTimeout(timer);
              task.child.removeListener("close", closed);
              task.child.removeListener("error", failed);
              if (error) reject(error);
              else resolve();
            };
            const closed = (): void => finish();
            const failed = (error: Error): void => finish(error);
            const timer = setTimeout(
              () => finish(new Error(`background task ${task.id} did not stop`)),
              5_000,
            );
            task.child.once("close", closed);
            task.child.once("error", failed);
            try {
              killGroup(task);
            } catch (err) {
              finish(err instanceof Error ? err : new Error(String(err)));
            }
          }),
      ),
    );
  }

  /** Kill everything — the session is going away. */
  close(): void {
    for (const task of this.#tasks.values()) {
      if (task.lifecycle.phase === "running") {
        if (task.lifecycle.timer) clearTimeout(task.lifecycle.timer);
        killGroup(task);
      }
      task.wake?.();
    }
    this.#tasks.clear();
  }

  #task(id: string): Task {
    const task = this.#tasks.get(id);
    if (!task) {
      const live = this.#running().map((t) => t.id);
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
  // descendants the command started go too — as with foreground Bash commands.
  if (typeof c.pid === "number") {
    try {
      Deno.kill(-c.pid, "SIGKILL");
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
          .optional()
          .describe(
            `Wait up to this many milliseconds for new output or exit ` +
              `(default ${DEFAULT_WAIT_MS}); 0 returns immediately.`,
          ),
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
