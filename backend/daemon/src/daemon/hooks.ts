/**
 * `[[hooks]]` — shell commands the daemon runs when something happens in a
 * session. Two families, from one config array:
 *
 *  - **write** hooks (`file_write` / `turn_end`) run a checker over the files
 *    the agent just edited. A non-zero exit is *fed back to the agent* as a
 *    `[loom]` message, so the linter's own output is what the model reads and
 *    acts on — keep the command quiet on success and terse on failure.
 *  - **waiting** hooks (`waiting` / `permission` / `question` / `plan_review` /
 *    `user_question` / `error` / `interrupted`) fire when a turn stops and wants
 *    a human. These never message the agent — a notifier that re-drove the turn
 *    it was announcing would loop — so a failure is logged and shown as an
 *    operator notice only.
 *
 * The command is handed to `sh -c` in the session's worktree, with the session's
 * facts in the environment (`LOOM_*`). Nothing is interpolated into the command
 * string: a branch name or a plan's text reaching a shell through substitution
 * is an injection, and through the environment is just a variable.
 *
 * Trust: a hook can come from the per-repo `.loom/config.toml`, i.e. from
 * whatever repo the daemon was pointed at. That is the same trust level
 * `[[mcp]]` already carries — its `command` is spawned too — so this adds no
 * new exposure, but it is worth knowing before running a daemon against a repo
 * you did not write.
 */
import process from "node:process";
import { spawn } from "node:child_process";
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
  onFeedback: (sessionId: string, text: string) => void;
  /** Surface an operator-facing advisory (a waiting hook that failed). */
  onNotice: (text: string, tone: "info" | "warn") => void;
}

/** Cap on captured output, so a runaway command can't be pasted into a prompt whole. */
const OUTPUT_CAP = 8_000;

/**
 * How many times in a row one hook may message a session before it gives up.
 * A `turn_end` linter reporting a failure the agent then can't fix would
 * otherwise re-fire on the very turn its own message provoked, forever. The
 * counter resets on a clean run, and an *unchanged* failure never re-sends at
 * all (see `#lastFeedback`) — this is the backstop for a failure that keeps
 * changing shape.
 */
const MAX_CONSECUTIVE_FEEDBACK = 3;

interface Attempt {
  code: number;
  output: string;
  timedOut: boolean;
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
  /**
   * One in-flight run per session+hook+event. A second fire while the first is
   * still going is dropped rather than queued: a `file_write` hook on a turn
   * that rewrites ten files should not spawn ten linters, and the run already
   * going will read the same worktree anyway.
   */
  readonly #running = new Map<string, Promise<void>>();

  constructor(opts: HookRunnerOptions) {
    this.#opts = opts;
  }

  /** Install (or hot-reload) the configured hooks, keeping only this repo's. */
  setHooks(hooks: HookConfig[]): void {
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
  forget(sessionId: string): void {
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
      byCall.set(ev.id, paths);
      return;
    }
    if (ev.type !== "tool_result") return;
    const byCall = this.#inFlight.get(ev.sessionId);
    const paths = byCall?.get(ev.id);
    if (!byCall || !paths) return;
    byCall.delete(ev.id);
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
    if (this.empty) return;
    this.fire("waiting", session, { reason });
    this.fire(reason, session, { reason });
  }

  /** The turn stopped on a failure (`error`) or was cut short (`interrupted`). */
  stopped(session: HookSession, event: "error" | "interrupted", detail: string): void {
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
      if (!hook.on.includes(event)) continue;
      if (write && hook.match.length > 0 && !this.#matchesAny(hook, session, files)) continue;
      void this.#run(hook, event, session, files, ctx);
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

  async #run(
    hook: HookConfig,
    event: HookEvent,
    session: HookSession,
    files: string[],
    ctx: { reason?: AwaitReason; detail?: string },
  ): Promise<void> {
    const key = `${session.id} ${hook.name} ${event}`;
    if (this.#running.has(key)) return;
    const job = this.#exec(hook, event, session, files, ctx)
      .then((attempt) => this.#report(hook, event, session, attempt))
      .catch((err) => {
        this.#opts.log.warn("hook failed to start", { hook: hook.name, event, err: String(err) });
      })
      .finally(() => this.#running.delete(key));
    this.#running.set(key, job);
    await job;
  }

  #exec(
    hook: HookConfig,
    event: HookEvent,
    session: HookSession,
    files: string[],
    ctx: { reason?: AwaitReason; detail?: string },
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

    return new Promise<Attempt>((settle, fail) => {
      // `detached` puts the command in its own process group, so the timeout
      // below can take its children with it — `sh -c 'tsc | head'` that wedges
      // would otherwise survive a signal aimed at the shell alone.
      const child = spawn("sh", ["-c", hook.run], {
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
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL"); // group already gone, or no pid — try the shell itself
        }
      }, hook.timeoutMs);
      timer.unref();
      child.on("error", (err) => {
        clearTimeout(timer);
        fail(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const text = out.length > OUTPUT_CAP ? `${out.slice(0, OUTPUT_CAP)}\n… [truncated]` : out;
        settle({ code: code ?? 1, output: text.trim(), timedOut });
      });
    });
  }

  /** Deal with a finished run: nothing on success, feedback or a notice on failure. */
  #report(hook: HookConfig, event: HookEvent, session: HookSession, attempt: Attempt): void {
    const key = `${session.id} ${hook.name}`;
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

    if (event !== "file_write" && event !== "turn_end") {
      // A notifier that failed is the operator's problem, not the agent's.
      this.#opts.onNotice(`hook "${hook.name}" (${event}) ${why}`, "warn");
      return;
    }

    const body = attempt.output || `(no output; ${why})`;
    if (this.#lastFeedback.get(key) === body) return; // unchanged — the agent has been told
    const runs = (this.#feedbackRuns.get(key) ?? 0) + 1;
    if (runs > MAX_CONSECUTIVE_FEEDBACK) {
      this.#opts.onNotice(
        `hook "${hook.name}" has failed ${runs} turns running — not telling the agent again ` +
          "until it passes once",
        "warn",
      );
      return;
    }
    this.#lastFeedback.set(key, body);
    this.#feedbackRuns.set(key, runs);
    this.#opts.onFeedback(
      session.id,
      `[loom] The \`${hook.name}\` hook ${why} after your edits:\n\n${body}\n\n` +
        "Fix what it reports, or say why it should stand.",
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
