/** Runs configured shell commands, with bounded output and cancellable per-hook queues.
 * Check hooks may feed failures to the agent; notification hooks never do.
 * Commands use LOOM_* environment variables, not string interpolation.
 */
import { executeShellHook, type HookAttempt as Attempt } from "../../../../core/src/shell-hook.ts";
import { isAbsolute, relative, resolve } from "node:path";
import type { AwaitReason, HarnessEvent } from "@loom/core/events";
import type { Logger } from "@loom/core/logger";
import { writtenPaths } from "@loom/core/tool-paths";
import type { SessionSnapshot } from "@loom/core/wire";
import type { HookConfig, HookEvent } from "../config/config.ts";

/** Facts about the session a hook fires for, read at fire time. */
export interface HookSession {
  id: string;
  title: string | null;
  provider: string;
  model: string | null;
  status: string;
  worktree: string | null;
  branch: string | null;
}

/** A session snapshot, reduced to what a hook needs. */
export const hookSessionOf = (s: SessionSnapshot): HookSession => ({
  id: s.id,
  title: s.title,
  provider: s.provider,
  model: s.model,
  status: s.status.kind,
  worktree: s.worktree,
  branch: s.branch,
});

export interface HookRunnerOptions {
  repoRoot: string;
  log: Logger;
  /** Deliver a failed write hook's output to the agent (the commit-nudge path). */
  onFeedback: (sessionId: string, text: string, signal: AbortSignal) => Promise<void>;
  /** Surface an operator-facing advisory (a waiting hook that failed). */
  onNotice: (text: string, tone: "info" | "warn") => void;
  /** Current TUI presence, evaluated when an event fires. */
  tuiPresence?: () => { connected: boolean; focused: boolean };
}

/**
 * How many times in a row one hook may message a session before it gives up.
 * A checker reporting a failure the agent then can't fix would
 * otherwise re-fire on the very turn its own message provoked, forever. The
 * counter resets on a clean run, and an *unchanged* failure never re-sends at
 * all (see `#lastFeedback`) — this is the backstop for a failure that keeps
 * changing shape.
 */
const MAX_CONSECUTIVE_FEEDBACK = 3;

interface PendingRun {
  event: HookEvent;
  session: HookSession;
  files: string[];
  ctx: { reason?: AwaitReason; detail?: string };
}
interface RunningHook {
  sessionId: string;
  abort: AbortController;
  pending: Map<string, PendingRun>;
}

export class HookRunner {
  readonly #opts: HookRunnerOptions;
  #hooks: HookConfig[] = [];

  /** Write-tool call id → the paths it claimed to write, until its result lands. */
  readonly #inFlight = new Map<string, Map<string, string[]>>();
  /** Files written so far this turn, per session — `turn_end`'s payload. */
  readonly #turnFiles = new Map<string, string[]>();
  /** Last failure text fed back per session+hook, so an unchanged one isn't re-sent. */
  readonly #lastFeedback = new Map<string, string>();
  /** Consecutive feedback messages per session+hook; reset by a clean run. */
  readonly #feedbackRuns = new Map<string, number>();
  /** Each configured hook owns a serial queue; pending writes retain every path. */
  readonly #running = new Map<string, RunningHook>();

  constructor(opts: HookRunnerOptions) {
    this.#opts = opts;
  }

  /** Install (or hot-reload) the configured hooks, keeping only this repo's. */
  setHooks(hooks: HookConfig[]): void {
    this.close();
    this.#hooks = hooks.filter(
      (h) => h.project === "" || matchGlob(h.project, this.#opts.repoRoot),
    );
    const other = hooks.length - this.#hooks.length;
    this.#opts.log.info("hooks loaded", { active: this.#hooks.length, otherProjects: other });
  }

  /** Whether any hook is armed — lets callers skip the bookkeeping entirely. */
  get empty(): boolean {
    return this.#hooks.length === 0;
  }

  /** The hooks armed for this repo, for `config.check` / tests. */
  get active(): readonly HookConfig[] {
    return this.#hooks;
  }

  /** Forget a session's accumulated state (it closed, or was removed). */
  close(): void {
    for (const job of this.#running.values()) job.abort.abort();
    this.#running.clear();
    this.#inFlight.clear();
    this.#turnFiles.clear();
    this.#lastFeedback.clear();
    this.#feedbackRuns.clear();
  }

  isRunning(sessionId: string): boolean {
    return [...this.#running.values()].some((job) => job.sessionId === sessionId);
  }

  cancel(sessionId: string): void {
    for (const [key, job] of this.#running) {
      if (job.sessionId !== sessionId) continue;
      job.abort.abort();
      this.#running.delete(key);
    }
  }

  forget(sessionId: string): void {
    this.cancel(sessionId);
    this.#inFlight.delete(sessionId);
    this.#turnFiles.delete(sessionId);
    for (const map of [this.#lastFeedback, this.#feedbackRuns]) {
      for (const key of map.keys()) {
        if (key.startsWith(`${sessionId} `)) map.delete(key);
      }
    }
  }

  // --- ingest ---------------------------------------------------------------

  /**
   * Watch the event stream for writes. `tool_call` records what a write tool
   * claims it will touch; the matching `tool_result` is what says it worked —
   * a hook must not lint a file whose edit was denied or errored.
   */
  observe(ev: HarnessEvent, session: () => HookSession | null): void {
    if (this.empty) return;
    if (ev.type === "tool_call") {
      const paths = writtenPaths(ev.name, ev.input);
      if (paths.length === 0) return;
      let byCall = this.#inFlight.get(ev.sessionId);
      if (!byCall) this.#inFlight.set(ev.sessionId, (byCall = new Map()));
      byCall.set(`${ev.agentId ?? ""} ${ev.id}`, paths);
      return;
    }
    if (ev.type !== "tool_result") return;
    const byCall = this.#inFlight.get(ev.sessionId);
    const paths = byCall?.get(`${ev.agentId ?? ""} ${ev.id}`);
    if (!byCall || !paths) return;
    byCall.delete(`${ev.agentId ?? ""} ${ev.id}`);
    if (!ev.ok) return;

    const snap = session();
    const cwd = snap?.worktree ?? this.#opts.repoRoot;
    const abs = paths.map((p) => (isAbsolute(p) ? p : resolve(cwd, p)));
    const turn = this.#turnFiles.get(ev.sessionId) ?? [];
    for (const p of abs) if (!turn.includes(p)) turn.push(p);
    this.#turnFiles.set(ev.sessionId, turn);
    if (snap) this.fire("file_write", snap, { files: abs });
  }

  // --- firing ---------------------------------------------------------------

  /**
   * The turn settled cleanly. Fires `turn_end` with every file the turn wrote
   * and clears the accumulator — so the next turn's hook sees only its own
   * edits. A turn that wrote nothing still fires, with an empty file list.
   */
  turnEnded(session: HookSession): void {
    const files = this.#turnFiles.get(session.id) ?? [];
    this.#turnFiles.delete(session.id);
    this.#inFlight.delete(session.id);
    if (!this.empty) this.fire("turn_end", session, { files });
  }

  /**
   * The turn stopped and wants a human. `reason` names which flavour of block
   * it is; the generic `waiting` hook fires for all of them.
   */
  waiting(session: HookSession, reason: AwaitReason): void {
    this.cancel(session.id);
    if (this.empty) return;
    this.fire("waiting", session, { reason });
    this.fire(reason, session, { reason });
  }

  /** The turn stopped on a failure (`error`) or was cut short (`interrupted`). */
  stopped(session: HookSession, event: "error" | "interrupted", detail: string): void {
    this.forget(session.id);
    if (this.empty) return;
    this.fire(event, session, { detail });
  }

  /** Run every hook armed for `event`. Fire-and-forget; failures are reported, not thrown. */
  fire(
    event: HookEvent,
    session: HookSession,
    ctx: { files?: string[]; reason?: AwaitReason; detail?: string } = {},
  ): void {
    const files = ctx.files ?? [];
    const write = event === "file_write" || event === "turn_end";
    for (const hook of this.#hooks) {
      if (!hook.on.some((e) => e === event)) continue;
      if (hook.kind === "notify" && hook.when !== "always") {
        const presence = this.#opts.tuiPresence?.();
        if (hook.when === "unfocused" && presence?.focused) continue;
        if (hook.when === "disconnected" && presence?.connected) continue;
      }
      if (write && hook.match.length > 0 && !this.#matchesAny(hook, session, files)) continue;
      if (event === "file_write") {
        for (const file of files) {
          if (hook.match.length === 0 || this.#matchesAny(hook, session, [file])) {
            this.#run(hook, { event, session, files: [file], ctx });
          }
        }
      } else this.#run(hook, { event, session, files, ctx });
    }
  }

  /** Does any written file match the hook's `match` globs? */
  #matchesAny(hook: HookConfig, session: HookSession, files: string[]): boolean {
    const cwd = session.worktree ?? this.#opts.repoRoot;
    return files.some((f) => {
      const rel = relative(cwd, f);
      return hook.match.some((g) => matchGlob(g, f) || matchGlob(g, rel));
    });
  }

  #run(hook: HookConfig, task: PendingRun): void {
    const key = task.session.id + " " + this.#hooks.indexOf(hook);
    let job = this.#running.get(key);
    const pendingKey = task.event + " " + (task.event === "file_write" ? task.files[0] : "");
    if (job) {
      const prior = job.pending.get(pendingKey);
      job.pending.set(pendingKey, {
        ...task,
        files: [...new Set([...(prior?.files ?? []), ...task.files])],
      });
      return;
    }
    job = {
      sessionId: task.session.id,
      abort: new AbortController(),
      pending: new Map([[pendingKey, task]]),
    };
    this.#running.set(key, job);
    void this.#drain(key, hook, job);
  }

  async #drain(key: string, hook: HookConfig, job: RunningHook): Promise<void> {
    const signal = job.abort.signal;
    try {
      for (const [pendingKey, task] of job.pending) {
        job.pending.delete(pendingKey);
        if (signal.aborted) break;
        const { event, session, files, ctx } = task;
        try {
          const attempt = await this.#exec(hook, event, session, files, ctx, signal);
          if (!signal.aborted) await this.#report(hook, event, session, attempt, signal);
        } catch (err) {
          if (!signal.aborted)
            this.#opts.onNotice('hook "' + hook.name + '": ' + String(err), "warn");
        }
      }
    } finally {
      if (this.#running.get(key) === job) this.#running.delete(key);
    }
  }

  #exec(
    hook: HookConfig,
    event: HookEvent,
    session: HookSession,
    files: string[],
    ctx: { reason?: AwaitReason; detail?: string },
    signal: AbortSignal,
  ): Promise<Attempt> {
    const cwd = session.worktree ?? this.#opts.repoRoot;
    const env: Record<string, string> = {
      ...Deno.env.toObject(),
      LOOM_HOOK: hook.name,
      LOOM_HOOK_EVENT: event,
      LOOM_REPO_ROOT: this.#opts.repoRoot,
      LOOM_SESSION_ID: session.id,
      LOOM_SESSION_TITLE: session.title ?? "",
      LOOM_SESSION_PROVIDER: session.provider,
      LOOM_SESSION_MODEL: session.model ?? "",
      LOOM_SESSION_STATUS: session.status,
      LOOM_WORKTREE: session.worktree ?? "",
      LOOM_BRANCH: session.branch ?? "",
      LOOM_FILES: files.join("\n"),
      LOOM_FILE: files[0] ?? "",
      LOOM_AWAIT_REASON: ctx.reason ?? "",
      LOOM_DETAIL: ctx.detail ?? "",
      // A ready-made one-liner, so the common notifier is
      // `notify-send loom "$LOOM_MESSAGE"` with no formatting of its own.
      LOOM_MESSAGE: describe(event, session, files, ctx),
    };

    return executeShellHook(hook.run, cwd, env, hook.timeoutMs, signal);
  }

  /** Deal with a finished run: nothing on success, feedback or a notice on failure. */
  async #report(
    hook: HookConfig,
    event: HookEvent,
    session: HookSession,
    attempt: Attempt,
    signal: AbortSignal,
  ): Promise<void> {
    const key = `${session.id} ${this.#hooks.indexOf(hook)}`;
    if (attempt.code === 0) {
      // A clean run clears the "already told the agent this" memo, so the next
      // regression is reported even if it looks identical to the last one.
      this.#lastFeedback.delete(key);
      this.#feedbackRuns.delete(key);
      this.#opts.log.debug("hook ok", { hook: hook.name, event, id: session.id });
      return;
    }

    const why = attempt.timedOut ? `timed out after ${hook.timeoutMs}ms` : `exited ${attempt.code}`;
    this.#opts.log.warn("hook failed", {
      hook: hook.name,
      event,
      id: session.id,
      why,
      output: attempt.output.slice(0, 400),
    });

    if (hook.kind === "notify") {
      // A notifier that failed is the operator's problem, not the agent's.
      this.#opts.onNotice(`hook "${hook.name}" (${event}) ${why}`, "warn");
      return;
    }

    const body = attempt.output || `(no output; ${why})`;
    if (this.#lastFeedback.get(key) === body) return; // unchanged — the agent has been told
    const runs = (this.#feedbackRuns.get(key) ?? 0) + 1;
    if (runs > MAX_CONSECUTIVE_FEEDBACK) {
      return;
    }
    this.#lastFeedback.set(key, body);
    this.#feedbackRuns.set(key, runs);
    if (runs === MAX_CONSECUTIVE_FEEDBACK)
      this.#opts.onNotice(
        `hook "${hook.name}": feedback limit reached; further failures are suppressed until it passes`,
        "warn",
      );
    await this.#opts.onFeedback(
      session.id,
      `[loom] The \`${hook.name}\` hook ${why} after your edits:\n\n${body}\n\n` +
        "Fix what it reports, or say why it should stand.",
      signal,
    );
  }
}

/** The `LOOM_MESSAGE` one-liner: what happened, in a form fit for a desktop toast. */
const describe = (
  event: HookEvent,
  session: HookSession,
  files: string[],
  ctx: { reason?: AwaitReason; detail?: string },
): string => {
  const who = session.title?.trim() || session.id.slice(0, 8);
  switch (event) {
    case "init":
      return `${who}: session initializing`;
    case "file_write":
    case "turn_end":
      return files.length === 0
        ? `${who}: turn complete`
        : `${who}: ${files.length} file${files.length === 1 ? "" : "s"} written`;
    case "waiting":
    case "permission":
    case "question":
    case "plan_review":
    case "user_question":
      return `${who}: waiting on you (${ctx.reason ?? event})`;
    case "error":
      return `${who}: error — ${ctx.detail ?? "turn failed"}`;
    case "interrupted":
      return `${who}: interrupted`;
  }
};

/**
 * Glob match over a whole string. `*` and `?` stop at a slash, `**` crosses it —
 * the usual shell-glob reading, enough for a `*.ts` suffix rule and a
 * `~/dev/**` project prefix. Everything else matches literally, so a plain path
 * is an equality test.
 */
export const matchGlob = (pattern: string, value: string): boolean => {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // A `**` followed by a separator must also match *zero* directories, so
        // a recursive suffix rule catches a file at the root as well.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  try {
    return new RegExp(`^${re}$`).test(value);
  } catch {
    return false;
  }
};
