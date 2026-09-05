/**
 * The Claude adapter — wraps `@anthropic-ai/claude-agent-sdk` (design spec §3).
 * One `query()` per session in streaming-input mode: the prompt is an async
 * iterable we feed follow-up turns into, `canUseTool` surfaces permission
 * prompts as `HarnessEvent`s, and `SDKMessage`s are normalized by
 * {@link ClaudeEventMapper}. Mode / model changes are live control calls.
 *
 * Auth is not brokered here — the SDK uses Claude's OAuth in `~/.claude`.
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { forkSession as sdkForkSession, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  HookCallback,
  McpServerConfig,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { HarnessEvent } from "@loom/core/events";
import { stateRunning } from "@loom/core/session-state";
import { makeLogger, type Logger } from "@loom/core/logger";
import { AsyncChannel } from "@loom/core/channel";
import { ClaudeEventMapper, type SdkGetUsageResponse } from "./map.ts";
import { resolveClaudeCli } from "./cli.ts";
import { buildLoomMcpServer } from "./loom-mcp.ts";
import { PendingInteractions } from "@loom/runtime/pending";
import type {
  AdapterSnapshot,
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  DiscoveredModel,
  EffortLevel,
  McpServerHandle,
  PermissionDecision,
  PlanDecision,
  ProviderCapabilities,
  SessionMode,
  SessionRef,
  UserInput,
} from "@loom/core/types";

const CAPS: ProviderCapabilities = {
  liveModeSwitch: true,
  liveModelSwitch: true,
  forking: true,
  rewind: true, // fork the transcript truncated, then resume it — ClaudeSession.rewind
  subagents: true,
  compaction: true,
  ownsTranscript: false, // history lives in the Claude Agent SDK's own session
  oneShot: true,
  // `includePartialMessages` is off and the mapper drops `stream_event`, so
  // usage is only emitted from the final `result` — no interim token counts.
  partialTokens: false,
  // All four map 1:1 onto the SDK's PermissionMode. In particular `auto` is the
  // SDK's own "auto" (Claude proceeds, but still prompts for anything it judges
  // unsafe) — *not* `bypassPermissions`, which is the one that needs the CLI to
  // be launched with --dangerously-skip-permissions and which Loom never uses.
  permissionModes: ["default", "plan", "acceptEdits", "auto"],
  models: [],
};

/**
 * Heartbeat cadence while a `/compact` summarise is in flight — same shape as
 * the aisdk engine's beats (`aisdk/src/session.ts`): fast for the first half
 * minute, then back off. The CLI reports no compaction progress, so `generated`
 * stays 0 and the beats are pure liveness.
 */
const COMPACT_BEAT_FAST_MS = 2_000;
const COMPACT_BEAT_SLOW_MS = 10_000;
const COMPACT_BEAT_BACKOFF_AFTER_MS = 30_000;
/**
 * Hard ceiling on one `/compact`. Nothing reports a failure mid-summarise, so
 * without a ceiling a wedged compaction would hold the daemon's op gate (and
 * every queued send) forever. Kept in step with the aisdk engine's
 * `SUMMARISE_TIMEOUT_MS` and the client's `session.compact` RPC timeout.
 */
const COMPACT_CEILING_MS = 15 * 60_000;

/**
 * Minimum gap between structured `/usage` polls (see {@link ClaudeSession.#pollPlanUsage}).
 * The plan windows move slowly; one refresh per turn is plenty, and the poll is
 * a round-trip to the claude.ai usage endpoint.
 */
const PLAN_POLL_MIN_GAP_MS = 60_000;

/** An in-flight `/compact` — see {@link ClaudeSession.#compactWait}. */
interface CompactWait {
  /** Settles when the compaction ends (boundary, failed turn, teardown, ceiling). */
  done: Promise<void>;
  resolve: () => void;
  readonly startedAt: number;
  /** Context-token estimate when the `/compact` was pushed — labels the beats. */
  readonly before: number;
  beatTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
}
/** {@link SessionMode} is a subset of the SDK's {@link PermissionMode}. */
const toPermissionMode = (mode: SessionMode): PermissionMode => mode;

/** Claude's `query()` options accept exactly these five — the shared, open
 *  {@link EffortLevel} lets a model advertise anything, so an unrecognized
 *  value (another vendor's string, a typo) is dropped here rather than sent
 *  to the CLI and rejected. Vendor-specific restriction kept inside the
 *  connector, per {@link EffortLevel}'s own doc comment. */
const CLAUDE_QUERY_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const asQueryEffort = (effort: EffortLevel): NonNullable<Options["effort"]> | undefined =>
  CLAUDE_QUERY_EFFORTS.has(effort) ? (effort as NonNullable<Options["effort"]>) : undefined;

/** `applyFlagSettings`'s live effort field is a stricter subset than
 *  `query()`'s own — no `max` — a genuine asymmetry between the SDK's two
 *  effort surfaces, not a Loom omission. */
const CLAUDE_FLAG_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const asFlagEffort = (effort: EffortLevel): "low" | "medium" | "high" | "xhigh" | undefined =>
  CLAUDE_FLAG_EFFORTS.has(effort) ? (effort as "low" | "medium" | "high" | "xhigh") : undefined;

/** Built-in file-mutating tools — the target path rides in `file_path` /
 *  `notebook_path`. */
const BUILTIN_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** tilth's MCP write tools, surfaced as `mcp__tilth__tilth_write` / `…_edit`
 *  (a renamed server keeps the `tilth_write` / `tilth_edit` suffix). Loom's own
 *  prompt steers the agent onto these ahead of the built-ins. */
const isTilthWriteTool = (name: string): boolean =>
  name.endsWith("tilth_write") || name.endsWith("tilth_edit");

/** Arg keys that can carry a filesystem target on a guarded tool — `root` is
 *  tilth's base dir, the rest are per-tool path fields. */
const PATH_KEYS = ["file_path", "notebook_path", "path", "root"] as const;

/**
 * Reason string when a file-mutating tool call points outside `root` — the
 * session's pinned worktree — or `null` when every checkable path stays in-tree.
 * `hookCwd` is the tool call's live working directory, so a relative path
 * resolves the way the tool would resolve it.
 *
 * Lexical containment only: the target is catching an agent that built a path
 * off the wrong repo root (e.g. `/repo/foo` or tilth `root: /repo` instead of
 * `/repo/.loom/trees/xxx`), not a symlink escaping the tree. Only ever asks —
 * a false positive costs one prompt.
 */
export const outOfTreeWriteReason = (
  root: string,
  hookCwd: string,
  toolName: string,
  toolInput: unknown,
): string | null => {
  if (!BUILTIN_WRITE_TOOLS.has(toolName) && !isTilthWriteTool(toolName)) return null;
  const raw = (toolInput ?? {}) as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const v = raw[key];
    if (typeof v !== "string" || v === "") continue;
    const abs = isAbsolute(v) ? v : resolvePath(hookCwd || root, v);
    const rel = relative(root, abs);
    const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    if (!inside) return `writes ${abs}, outside this session's worktree (${root})`;
  }
  return null;
};

/**
 * The two SDK entry points behind a mutable indirection so tests can swap in
 * fakes (`__setClaudeSdk`) — there is otherwise no way to exercise ClaudeSession
 * without a real `claude` subprocess. Mirrors the `bin?` seam in
 * `aisdk/src/tools/grep.ts`.
 */
const sdk: { query: typeof sdkQuery; forkSession: typeof sdkForkSession } = {
  query: sdkQuery,
  forkSession: sdkForkSession,
};

/** Test-only: override one or both SDK entry points. Omitted fields are kept. */
export const __setClaudeSdk = (partial: Partial<typeof sdk>): void => {
  Object.assign(sdk, partial);
};

/**
 * Serialises `forkSession` across every session in this process. It reads the
 * transcript from `CLAUDE_CONFIG_DIR`, which `#forkTruncated` mutates on
 * Deno's process-wide env for the duration of the call — two concurrent multi-profile
 * undos would otherwise fork from the wrong profile.
 */
let forkLock: Promise<unknown> = Promise.resolve();

/** Module logger for provider-level work that isn't tied to a session. */
const log = makeLogger("claude");

/** Cap on the model-discovery handshake — the caller also races a timeout, but
 *  bounding it here means the throwaway `query()` subprocess is always closed. */
const LIST_MODELS_TIMEOUT_MS = 15_000;

/** Expand a leading `~` / `~/`; other paths (incl. "") pass through. */
const expandTilde = (p: string): string => {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
};

/**
 * The subprocess env for a `query()`: Deno's env plus Loom's overrides. `env`
 * REPLACES the child environment, so the spread is load-bearing. Always returns
 * an object: we force `NO_COLOR` (and strip `FORCE_COLOR` / `CLICOLOR_FORCE`) so
 * the CLI's own tool subprocesses — `node --test`, `git`, linters — don't spew
 * ANSI escapes into a transcript the model reads as plain text and our own
 * renderers re-colour. A stray `FORCE_COLOR` in the daemon's env would otherwise
 * defeat each tool's TTY check; `NO_COLOR` is the cross-tool standard.
 */
const queryEnv = (opts: {
  promptCacheTtl?: string | undefined;
  configDir?: string | undefined;
}): Record<string, string> => {
  const env: Record<string, string> = { ...Deno.env.toObject(), NO_COLOR: "1" };
  delete env["FORCE_COLOR"];
  delete env["CLICOLOR_FORCE"];
  // Pinning the cache TTL makes the TUI's liveness countdown exact.
  if (opts.promptCacheTtl) env["CLAUDE_CODE_PROMPT_CACHE_TTL"] = opts.promptCacheTtl;
  // Points this session's `claude` at a non-default profile dir.
  if (opts.configDir) env["CLAUDE_CONFIG_DIR"] = expandTilde(opts.configDir);
  return env;
};

/** Pull a context-window size out of a `[1m]` / `[200k]` style tag; 0 if none. */
const parseContextTag = (s: string): number => {
  const m = /\[(\d+(?:\.\d+)?)\s*([mk])\]/i.exec(s);
  if (!m) return 0;
  return Math.round(parseFloat(m[1]!) * (m[2]!.toLowerCase() === "m" ? 1_000_000 : 1_000));
};

const userMessage = (text: string): SDKUserMessage => {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  } as unknown as SDKUserMessage;
};

const mcpConfig = (handles: McpServerHandle[]): Record<string, McpServerConfig> => {
  const out: Record<string, McpServerConfig> = {};
  for (const h of handles) {
    if (h.spec.transport === "stdio") {
      out[h.name] = {
        type: "stdio",
        command: h.spec.command,
        ...(h.spec.args ? { args: h.spec.args } : {}),
        ...(h.spec.env ? { env: h.spec.env } : {}),
      };
    } else {
      out[h.name] = {
        type: "http",
        url: h.spec.url,
        ...(h.spec.headers ? { headers: h.spec.headers } : {}),
      };
    }
  }
  return out;
};

/** Extra `start()` inputs the provider supplies (and `rewind()` re-supplies). */
interface StartExtra {
  resume?: string;
  cli?: string;
  promptCacheTtl?: string;
  configDir?: string;
  base?: string;
}

// ---------------------------------------------------------------------------

class ClaudeSession implements AgentSession {
  readonly id: string;

  #query: Query | null = null;
  #mapper: ClaudeEventMapper;
  #log: Logger;
  #mode: SessionMode;
  #effort: EffortLevel | null;
  /** The model currently in force — `opts.model` at start, updated by
   *  `setModel()`. `rewind()` composes the resumed query from this (and the
   *  live `#mode` / `#effort`), not the frozen `#startOpts`. */
  #model: string | undefined;
  /** Spans the whole `rewind()` call (incl. the async fork *and* the query
   *  swap) — rejects a second concurrent undo, and tells `#drain`'s cleanup to
   *  leave `#outbox` / `#inbox` open because a resumed query will reuse them. */
  #rewindInFlight = false;
  /** The args `start()` last ran with, so `rewind()` can rebuild the query. */
  #startOpts: CreateSessionOptions | null = null;
  #startExtra: StartExtra = {};

  /** Follow-up turns fed into the streaming-input prompt. */
  #inbox = new AsyncChannel<SDKUserMessage>();
  /** Normalized events out: SDK messages + permission prompts, merged. */
  #outbox = new AsyncChannel<HarnessEvent>();
  #pending = new PendingInteractions<PermissionResult | null, PermissionResult | null>();
  #pump: Promise<void> | null = null;
  #closing = false;
  /**
   * Set by `interrupt()`, cleared by the next `send()`. The SDK's `interrupt()`
   * aborts the live turn but not turns already sitting in its command queue (a
   * message the user sent mid-turn, or the plan-approval path's own follow-up).
   * While this is set, `#drain` keeps the mapper's accounting current but drops
   * every mapped event, so a queued turn can't stream chatter into a session
   * the user has stopped. A real `send()` supersedes the interrupt.
   */
  #interrupted = false;

  /**
   * An in-flight `/compact` pushed by {@link compact}: the promise the daemon's
   * op gate parks on (a `send` during the summarise fast-fails with `busy` and
   * the TUI queues it, instead of racing into the CLI's own input queue) plus
   * the heartbeat / ceiling timers that keep clients showing "compacting…" for
   * the whole run. The CLI reports nothing between the pushed command and the
   * final `compact_boundary`, so liveness is synthesized here. Settled by the
   * boundary, by a failed turn carrying it, by interrupt / close / teardown, or
   * by the ceiling — never by an ok `result`, which a `/compact` queued behind
   * a live turn passes through *before* the boundary lands.
   */
  #compactWait: CompactWait | null = null;

  /** Epoch ms of the last structured `/usage` poll — throttles {@link #pollPlanUsage}. */
  #lastPlanPollAt = 0;

  constructor(opts: CreateSessionOptions) {
    this.id = opts.sessionId;
    this.#mapper = new ClaudeEventMapper(opts.sessionId);
    this.#mode = opts.mode;
    this.#effort = opts.effort ?? null;
    this.#model = opts.model;
    this.#log = makeLogger("claude").child(opts.sessionId.slice(0, 8));
  }

  get providerRef(): string | null {
    return this.#mapper.state.providerRef;
  }

  /** Build the `query()` and start pumping its messages into the outbox. */
  start(opts: CreateSessionOptions, extra: StartExtra = {}): void {
    this.#startOpts = opts;
    this.#startExtra = extra;
    const { resume, cli, promptCacheTtl, configDir } = extra;
    if (opts.prompt) this.#inbox.push(userMessage(opts.prompt));

    const canUseTool: CanUseTool = (toolName, input, ctx) => {
      // C6: a turn already sitting in the SDK's own command queue when the user
      // interrupted still calls `canUseTool` as it unwinds. Deny outright — do
      // not push a `permission_request` / `plan_review` that would resurface a
      // stopped session as `awaiting_input`. (`#drain`'s muzzle only covers
      // *mapped* events, not these.)
      if (this.#interrupted) {
        return Promise.resolve({ behavior: "deny", message: "session interrupted" });
      }
      const reqId = ctx.toolUseID || ctx.requestId;
      // In plan mode the agent presents its plan via ExitPlanMode; surface that
      // as a first-class plan review rather than a generic permission prompt.
      if (toolName === "ExitPlanMode" || toolName === "exit_plan_mode") {
        const raw = (input as { plan?: unknown } | null)?.plan;
        const plan =
          typeof raw === "string" && raw.trim() !== "" ? raw : JSON.stringify(input ?? {});
        const decision = this.#pending.requestPlan(reqId);
        this.#outbox.push({
          type: "plan_review",
          sessionId: this.id,
          ts: Date.now(),
          id: reqId,
          plan,
          ...(ctx.agentID ? { agentId: ctx.agentID } : {}),
        });
        return decision;
      }
      const decision = this.#pending.requestPermission(reqId);
      this.#outbox.push({
        type: "permission_request",
        sessionId: this.id,
        ts: Date.now(),
        id: reqId,
        tool: toolName,
        input,
        ...(ctx.suggestions ? { suggestions: ctx.suggestions } : {}),
        ...(ctx.agentID ? { agentId: ctx.agentID } : {}),
      });
      return decision;
    };

    // `auto` mode lets the CLI auto-approve edits without ever calling
    // `canUseTool`, so an agent that builds an absolute path off the wrong repo
    // root (the main checkout instead of `.loom/trees/<id>`) writes there
    // silently. This PreToolUse hook runs ahead of that classifier: for a
    // file-mutating tool whose target escapes the session's worktree it forces
    // an `ask`, which flows back through `canUseTool` as a normal
    // `permission_request`. Self-gates on the *live* mode — every other mode
    // already prompts, so the guard would only double up.
    const worktreeRoot = opts.cwd;
    const guardOutOfTreeWrites: HookCallback = (input) => {
      if (input.hook_event_name !== "PreToolUse") return Promise.resolve({});
      if (this.#mode !== "auto") return Promise.resolve({});
      const reason = outOfTreeWriteReason(
        worktreeRoot,
        input.cwd,
        input.tool_name,
        input.tool_input,
      );
      if (reason === null) return Promise.resolve({});
      this.#log.info("out-of-worktree write → prompting", { tool: input.tool_name, reason });
      return Promise.resolve({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `Claude ${reason}`,
        },
      });
    };

    const mcpServers = mcpConfig(opts.mcpServers);
    if (opts.loomServer) {
      mcpServers["loom"] = buildLoomMcpServer({
        cwd: opts.cwd,
        ...(extra.base ? { base: extra.base } : {}),
        askUser: (question, context) => this.#askUser(question, context),
      });
    }

    const env = queryEnv({ promptCacheTtl, configDir });
    const queryEffort = opts.effort ? asQueryEffort(opts.effort) : undefined;
    const options: Options = {
      cwd: opts.cwd,
      permissionMode: toPermissionMode(opts.mode),
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [guardOutOfTreeWrites] }] },
      includePartialMessages: false,
      mcpServers,
      stderr: (data) => this.#log.debug("cli stderr", { data: data.slice(0, 500) }),
      env,
      ...(cli ? { pathToClaudeCodeExecutable: cli } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(queryEffort ? { effort: queryEffort } : {}),
      ...(resume ? { resume } : {}),
      ...(opts.disableTools && opts.disableTools.length > 0
        ? { disallowedTools: opts.disableTools }
        : {}),
      ...(opts.settingSources
        ? { settingSources: opts.settingSources as NonNullable<Options["settingSources"]> }
        : {}),
      ...(opts.systemPromptAppend
        ? {
            systemPrompt: {
              type: "preset",
              preset: "claude_code",
              append: opts.systemPromptAppend,
            },
          }
        : {}),
      ...(opts.subagents && opts.subagents.length > 0
        ? {
            agents: Object.fromEntries(
              opts.subagents.map((a) => [
                a.name,
                {
                  description: a.description,
                  prompt: a.prompt,
                  ...(a.tools ? { tools: a.tools } : {}),
                  ...(a.model ? { model: a.model } : {}),
                },
              ]),
            ) as NonNullable<Options["agents"]>,
          }
        : {}),
    };

    this.#query = sdk.query({ prompt: this.#inbox, options });
    this.#pump = this.#drain();

    // Prime the plan rate-limit windows once the CLI handshake lands — covers
    // both a fresh session and a resume, so a reattached daemon shows real
    // `five_hour` / `seven_day` numbers within a second instead of waiting for
    // the next spontaneous `rate_limit_event`.
    void this.#query
      .initializationResult()
      .then(() => this.#pollPlanUsage())
      .catch(() => {});
  }

  /**
   * Fetch the structured `/usage` data (the `get_usage` control request) and
   * emit a `rate_limit` event per plan window. This is the on-demand counterpart
   * to the streamed `rate_limit_event`, which only fires on a change to the
   * binding window — without this poll `five_hour` / `seven_day` sit blank or
   * stale until something nears the cap. No-op for API-key sessions
   * (`rate_limits_available: false`); best-effort, since the SDK method is
   * flagged experimental — a throw or a missing method just skips this round.
   */
  async #pollPlanUsage(): Promise<void> {
    const q = this.#query;
    const fn = q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (!q || typeof fn !== "function") return;
    this.#lastPlanPollAt = Date.now();
    try {
      const resp = (await fn.call(q)) as SdkGetUsageResponse;
      if (this.#closing) return;
      for (const ev of this.#mapper.mapPlanUsage(resp)) this.#outbox.push(ev);
    } catch (err) {
      this.#log.debug("plan usage poll failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async #drain(): Promise<void> {
    const q = this.#query;
    if (!q) return;
    try {
      for await (const msg of q) {
        // Always run the mapper — it carries cumulative token / cost state
        // that must stay correct even for a turn we're suppressing.
        const events = this.#mapper.map(msg);
        // A tracked compaction ends at its `compact_boundary` — or when the
        // turn carrying it fails. Checked before the interrupt muzzle so the
        // wait (and the daemon's op gate) releases even for events we drop.
        if (this.#compactWait) {
          for (const ev of events) {
            if (ev.type === "compact" || (ev.type === "result" && ev.kind === "error")) {
              this.#settleCompact();
              break;
            }
          }
        }
        if (this.#interrupted) continue;
        for (const ev of events) this.#outbox.push(ev);
        // A completed turn may have moved the plan windows — refresh, throttled.
        if (
          events.some((ev) => ev.type === "result") &&
          Date.now() - this.#lastPlanPollAt > PLAN_POLL_MIN_GAP_MS
        ) {
          void this.#pollPlanUsage();
        }
      }
    } catch (err) {
      if (!this.#closing && !this.#rewindInFlight) {
        this.#outbox.push({
          type: "error",
          sessionId: this.id,
          ts: Date.now(),
          message: err instanceof Error ? err.message : String(err),
          fatal: true,
        });
      }
    } finally {
      // The CLI process ended (crash / transport error) without `close()` —
      // resolve any outstanding gate/ask_user/plan promise so the MCP tool's
      // `execute` doesn't hang forever.
      this.#rejectPending("the session ended before this was answered");
      // C5: gate cleanup on `#rewindInFlight`, which spans the *whole* rewind
      // (fork + query swap). If the live stream ends while `#forkTruncated` is
      // still running, a resumed query is about to reuse these channels —
      // closing them here would leave the resumed session permanently silent.
      if (!this.#rewindInFlight) {
        this.#outbox.close();
        this.#inbox.close();
      }
    }
  }

  /** Resolve every outstanding permission / question / plan promise. */
  #rejectPending(reason: string): void {
    this.#pending.failAll(
      { behavior: "deny", message: reason },
      `(${reason})`,
      { behavior: "deny", message: reason },
    );
    // An in-flight compaction is pending on the same process: interrupt /
    // stream-end / close all abandon it. The error event is what clients use
    // to clear the "compacting…" indicator (trackCompacting in the TUI model).
    this.#settleCompact(`compaction abandoned — ${reason}`);
  }

  events(): AsyncIterable<HarnessEvent> {
    return this.#outbox;
  }

  async send(input: UserInput): Promise<void> {
    if (this.#closing) throw new Error("session is closing");
    this.#interrupted = false; // a fresh user turn supersedes any prior interrupt
    this.#inbox.push(userMessage(input));
  }

  /**
   * Drive the Claude Code CLI's `/compact` command over the streaming input.
   * The CLI treats a leading-slash user message as a command; when the summary
   * lands it emits a `compact_boundary` system message, which the mapper turns
   * into a `compact` event.
   *
   * The promise resolves only when that boundary (or a failure) lands, holding
   * the daemon's op gate for the whole summarise; `compact_progress` beats keep
   * clients showing "compacting…" in the meantime.
   */
  async compact(instructions?: string): Promise<void> {
    if (this.#closing) throw new Error("session is closing");
    const trimmed = instructions?.trim();
    this.#inbox.push(userMessage(trimmed ? `/compact ${trimmed}` : "/compact"));
    // One tracked compaction at a time. The daemon's op gate serialises
    // `session.compact` calls, so this only spins for the plan-approval path
    // racing a manual one; the CLI runs the queued `/compact`s in input order.
    while (this.#compactWait) await this.#compactWait.done.catch(() => {});
    if (this.#closing) return;
    // Park here until the `compact_boundary` (or a failed turn / interrupt /
    // close / the 15-minute ceiling) settles the wait. This is what holds the
    // daemon's op gate closed for the whole summarise — without it the gate
    // reopens instantly, a racing `send` streams straight into the CLI's input
    // queue instead of bouncing with `busy`, and the "compacting…" overlay
    // clears while the CLI is still working.
    await this.#trackCompact().done;
  }

  /** Start the beats and open the wait the daemon's op gate parks on. */
  #trackCompact(): CompactWait {
    const startedAt = Date.now();
    const before = this.#mapper.state.contextUsed;
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const wait: CompactWait = {
      done,
      resolve,
      startedAt,
      before,
      beatTimer: null,
      deadlineTimer: null,
    };
    this.#compactWait = wait;
    const beat = (): void =>
      this.#outbox.push({
        type: "compact_progress",
        sessionId: this.id,
        ts: Date.now(),
        elapsedMs: Date.now() - startedAt,
        // The CLI streams no summary text we can see — the beat is liveness only.
        generated: 0,
        before,
      });
    const schedule = (): void => {
      if (this.#compactWait !== wait) return;
      const slow = Date.now() - startedAt > COMPACT_BEAT_BACKOFF_AFTER_MS;
      wait.beatTimer = setTimeout(
        () => {
          beat();
          schedule();
        },
        slow ? COMPACT_BEAT_SLOW_MS : COMPACT_BEAT_FAST_MS,
      );
      if (typeof wait.beatTimer.unref === "function") wait.beatTimer.unref();
    };
    beat();
    schedule();
    wait.deadlineTimer = setTimeout(() => {
      this.#log.warn("compaction ceiling reached — releasing the op gate", {
        elapsedMs: Date.now() - startedAt,
      });
      this.#settleCompact(
        "the compaction hit its 15-minute ceiling — the transcript was left as-is",
      );
    }, COMPACT_CEILING_MS);
    if (typeof wait.deadlineTimer.unref === "function") wait.deadlineTimer.unref();
    return wait;
  }

  /** End the tracked compaction (if any): stop the timers, release the waiter. */
  #settleCompact(abandoned?: string): void {
    const wait = this.#compactWait;
    if (!wait) return;
    this.#compactWait = null;
    if (wait.beatTimer) clearTimeout(wait.beatTimer);
    if (wait.deadlineTimer) clearTimeout(wait.deadlineTimer);
    wait.resolve();
    if (abandoned) {
      // Mirrors the aisdk engine's "compaction was cancelled" error — clients
      // clear the "compacting…" indicator on any `error` event for the session.
      this.#outbox.push({
        type: "error",
        sessionId: this.id,
        ts: Date.now(),
        message: abandoned,
        fatal: false,
      });
    }
  }

  async respondToPermission(id: string, decision: PermissionDecision): Promise<void> {
    if (decision.behavior === "allow") {
      this.#pending.resolvePermission(id, {
        behavior: "allow",
        ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
      });
    } else {
      this.#pending.resolvePermission(id, { behavior: "deny", message: decision.message ?? "denied by user" });
    }
  }

  /** loom `ask_user` handler: emit a `question` event, block until answered. */
  #askUser(question: string, context: string | undefined): Promise<string> {
    const id = randomUUID();
    const answer = this.#pending.requestQuestion(id);
    this.#outbox.push({
      type: "question",
      sessionId: this.id,
      ts: Date.now(),
      id,
      question,
      ...(context ? { context } : {}),
    });
    return answer;
  }

  async answerQuestion(id: string, text: string): Promise<void> {
    if (!this.#pending.resolveQuestion(id, text)) return;
    this.#outbox.push({ type: "answer", sessionId: this.id, ts: Date.now(), id, text });
  }

  async respondToPlan(id: string, decision: PlanDecision): Promise<void> {
    if (!this.#pending.hasPlan(id)) return; // already resolved / unknown — first writer won

    if (decision.action === "implement") {
      // Native exit: the SDK leaves plan mode and the turn implements. Mirror
      // the requested mode into our own snapshot so `snapshot()` (and the
      // daemon registry that reads it) stops reporting "plan" once the turn is
      // already executing.
      try {
        await this.setMode(decision.mode ?? "default");
      } catch (err) {
        this.#log.warn("failed to sync mode after plan exit", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      this.#pending.resolvePlan(id, { behavior: "allow" });
      return;
    }

    // The other cases end the ExitPlanMode call and re-drive the session
    // deterministically, so behaviour doesn't hinge on SDK `updatedInput` support.
    if (decision.action === "discuss") {
      this.#pending.resolvePlan(id, { behavior: "deny", message: decision.message });
      return; // stays in plan mode; the message arrives as the next user turn
    }

    if (decision.action === "handoff") {
      // The daemon has spawned a fresh session (an `⌥p` retarget onto a
      // different provider) to carry the implementation. End the turn here;
      // no compact, no mode change, no implement send.
      this.#pending.resolvePlan(id, {
        behavior: "deny",
        message: "Plan approved — implementation continues in a separate session.",
      });
      return;
    }

    this.#pending.resolvePlan(id, { behavior: "deny", message: "Plan accepted — implementing now." });
    if (decision.action === "implement_fresh") {
      void this.#implementFresh(decision);
      return;
    }
    await this.setMode(decision.mode ?? "acceptEdits");
    const plan = decision.action === "revise" ? decision.plan : "the plan you just presented";
    await this.send(`The plan is approved. Implement it now:\n\n${plan}`);
  }

  async #implementFresh(decision: Extract<PlanDecision, { action: "implement_fresh" }>): Promise<void> {
    try {
      if (decision.model) await this.setModel(decision.model);
      if (decision.effort) await this.setEffort(decision.effort);
      await this.compact(
        "Keep the approved plan and the original goal verbatim. Drop the exploration transcript.",
      );
      if (this.#closing) return;
      await this.setMode(decision.mode ?? "acceptEdits");
      await this.send("The plan is approved. Implement it now:\n\nthe plan you just presented");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log.warn("plan compaction failed", { err: message });
      if (!this.#closing)
        this.#outbox.push({ type: "error", sessionId: this.id, ts: Date.now(), message, fatal: false });
    }
  }

  async interrupt(): Promise<void> {
    // Stop the live turn, and don't let anything queued behind it speak into
    // the stopped session. `#inbox.drain()` clears sends the SDK hasn't pulled
    // yet; `#interrupted` (lifted by the next `send()`) muzzles a turn already
    // in the SDK's own command queue — 0.3.251's `interrupt()` takes no
    // `cancel_queued`, so that queue can't be emptied from here.
    this.#interrupted = true;
    // C6: release any gate / ask_user / plan promise parked on this turn now —
    // don't wait for the stream to end or `close()` to run.
    this.#rejectPending("the turn was interrupted");
    this.#inbox.drain();
    const receipt = await this.#query?.interrupt();
    const queued = receipt?.still_queued;
    if (queued && queued.length > 0) {
      this.#log.debug("interrupt left queued turns in the CLI", { count: queued.length });
    }
  }

  /**
   * Undo. `resumeSessionAt` isn't honoured in streaming-input mode, so instead
   * {@link forkSession} writes a *new* transcript file sliced at `at` (the kept
   * turn's last chain-entry UUID — {@link ClaudeEventMapper} tracks it), and we
   * swap the live `query()` for a plain resume of that shorter fork. `#outbox`
   * survives the swap so the daemon's event stream is unbroken; the mapper is
   * kept, so cumulative cost never regresses (the first turn after an undo may
   * under-report token deltas until the resumed total catches up). `_keep` is
   * the aisdk message count — unused here.
   *
   * The fork runs *before* the live query is touched, so a fork failure (a bad
   * ref, a missing transcript) leaves the session completely intact.
   *
   * Conversation only: anything the dropped turns wrote to disk / a memory tool
   * stays. That's the same contract as the aisdk path.
   */
  async rewind(_keep: number, at?: string): Promise<void> {
    if (this.#closing) throw new Error("session is closing");
    if (this.#rewindInFlight) throw new Error("an undo is already in progress");
    if (!at) throw new Error("Claude undo needs a fork ref (a chain-entry UUID)");
    if (!this.#startOpts) throw new Error("this session was never started");
    const source = this.#mapper.state.providerRef;
    if (!source) throw new Error("this Claude session has no id to fork from");

    this.#rewindInFlight = true;
    try {
      // Fork first — the last turn's `result` already flushed the transcript
      // file, and if this throws the live query is still untouched.
      const forkedId = await this.#forkTruncated(source, at);
      if (this.#closing) return; // close() raced the fork

      // Now end the live query without closing the channels the daemon holds —
      // `#drain`'s cleanup is gated on `#rewindInFlight`, still true here.
      this.#inbox.drain();
      try {
        this.#query?.close();
      } catch {
        // best effort — we're replacing it regardless
      }
      await this.#pump?.catch(() => {});
      if (this.#closing) return; // ...or raced the teardown

      // Fresh inbox for the resumed fork; `#outbox` stays as-is.
      this.#inbox = new AsyncChannel<SDKUserMessage>();
      this.#interrupted = false;
      // C1: resume with the *live* model / mode / effort, not the values frozen
      // into `#startOpts` at creation — a `setModel` / `setMode` / `setEffort`
      // before the undo would otherwise be silently reverted.
      this.#mapper.onQuerySwap();
      this.start(
        {
          ...this.#startOpts,
          prompt: "",
          mode: this.#mode,
          ...(this.#model ? { model: this.#model } : {}),
          ...(this.#effort ? { effort: this.#effort } : {}),
        },
        { ...this.#startExtra, resume: forkedId },
      );
    } finally {
      this.#rewindInFlight = false;
    }
  }

  /**
   * `forkSession` reads the transcript from `CLAUDE_CONFIG_DIR` in-process (not
   * a subprocess), so `#forkTruncatedUnlocked` points Deno's process-wide env at this
   * session's profile dir for the call. That global mutation is held across an
   * `await`, so every fork in the process is serialised through `forkLock` —
   * two concurrent multi-profile undos would otherwise interleave and fork from
   * the wrong profile (C4).
   */
  #forkTruncated(sourceId: string, upToMessageId: string): Promise<string> {
    const run = forkLock.then(() => this.#forkTruncatedUnlocked(sourceId, upToMessageId));
    forkLock = run.catch(() => {});
    return run;
  }

  async #forkTruncatedUnlocked(sourceId: string, upToMessageId: string): Promise<string> {
    const dir = this.#startExtra.configDir;
    const key = "CLAUDE_CONFIG_DIR";
    const prev = Deno.env.get(key);
    if (dir) Deno.env.set(key, expandTilde(dir));
    try {
      const { sessionId } = await sdk.forkSession(sourceId, { upToMessageId });
      return sessionId;
    } finally {
      if (dir) {
        if (prev === undefined) Deno.env.delete(key);
        else Deno.env.set(key, prev);
      }
    }
  }

  async setMode(mode: SessionMode): Promise<void> {
    try {
      await this.#query?.setPermissionMode(toPermissionMode(mode));
      this.#mode = mode;
    } catch (err) {
      // Keep the old mode and give the caller a readable reason.
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(`Claude rejected the "${mode}" permission mode: ${raw}`);
    }
  }

  async setModel(model: string): Promise<void> {
    try {
      await this.#query?.setModel(model);
      this.#model = model;
    } catch (err) {
      // Keep the old model and give the caller a readable reason (matches
      // setMode / setEffort); an out-of-catalog id otherwise surfaces raw.
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(`Claude rejected the model "${model}": ${raw}`);
    }
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    const flagEffort = asFlagEffort(effort);
    if (!flagEffort) throw new Error(`Claude does not support live effort changes to "${effort}"`);
    try {
      await this.#query?.applyFlagSettings({ effortLevel: flagEffort });
      this.#effort = effort;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(`Claude rejected the "${effort}" effort level: ${raw}`);
    }
  }

  snapshot(): AdapterSnapshot {
    const s = this.#mapper.state;
    return {
      status: stateRunning,
      providerRef: s.providerRef,
      model: s.model,
      effort: this.#effort,
      mode: this.#mode,
      usage: { ...s.usage },
      contextUsed: s.contextUsed,
      contextLimit: s.contextLimit,
      costUsd: s.costUsd,
      turns: s.turns,
      ...(s.rewindRef ? { rewindRef: s.rewindRef } : {}),
    };
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#rejectPending("the session was closed before this was answered");
    try {
      this.#query?.close();
    } catch {
      // best effort
    }
    this.#outbox.close();
    this.#inbox.close();
    await this.#pump?.catch(() => {});
  }
}

// ---------------------------------------------------------------------------

export interface ClaudeProviderOptions {
  /** Provider id this instance serves — `claude` or `claude:<profile>`. */
  id?: string;
  /** `providers.claude.cli_path` — "" means discover / bundled. */
  cliPath?: string;
  /** `providers.claude.prompt_cache_ttl` — "5m" | "1h" | "" (CLI decides). */
  promptCacheTtl?: string;
  /** `CLAUDE_CONFIG_DIR` for this profile — "" leaves the SDK's default. */
  configDir?: string;
  /** The repo's base branch — feeds the `status` tool's ahead/behind counts. */
  base?: string;
}

export class ClaudeProvider implements AgentProvider {
  readonly id: string;
  readonly capabilities = CAPS;

  readonly #cliPathOption: string;
  readonly #base: string;
  readonly #promptCacheTtl: string;
  readonly #configDir: string;
  #cli: string | undefined;
  #cliResolved = false;

  constructor(opts: ClaudeProviderOptions = {}) {
    this.id = opts.id ?? "claude";
    this.#cliPathOption = opts.cliPath ?? "";
    this.#base = opts.base ?? "";
    this.#promptCacheTtl = opts.promptCacheTtl ?? "";
    this.#configDir = opts.configDir ?? "";
  }

  #resolveCli(): string | undefined {
    if (!this.#cliResolved) {
      this.#cli = resolveClaudeCli(this.#cliPathOption);
      this.#cliResolved = true;
      // Which binary sessions spawn is otherwise invisible — on systems where
      // the SDK's prebuilt ELF can't run (NixOS, musl, Guix) sessions just die
      // with a bare loader error and nothing says which path was chosen.
      if (this.#cli) {
        log.info("claude cli", {
          path: this.#cli,
          source: this.#cliPathOption ? "config" : "path",
        });
      } else {
        log.warn(
          "no `claude` on the daemon's PATH and no cli_path set — the SDK's bundled binary will be spawned (a plain glibc ELF; does not run everywhere — NixOS, musl, minimal containers). Set [providers.claude] cli_path, or restart the daemon with `claude` on PATH",
        );
      }
    }
    return this.#cli;
  }

  #extra(cli: string | undefined) {
    return {
      ...(cli ? { cli } : {}),
      ...(this.#promptCacheTtl ? { promptCacheTtl: this.#promptCacheTtl } : {}),
      ...(this.#configDir ? { configDir: this.#configDir } : {}),
      ...(this.#base ? { base: this.#base } : {}),
    };
  }

  async createSession(opts: CreateSessionOptions): Promise<AgentSession> {
    const cli = this.#resolveCli();
    const s = new ClaudeSession(opts);
    s.start(opts, this.#extra(cli));
    return s;
  }

  async resumeSession(ref: SessionRef): Promise<AgentSession> {
    const cli = this.#resolveCli();
    const opts: CreateSessionOptions = {
      sessionId: ref.sessionId,
      cwd: ref.cwd,
      prompt: "", // resume replays in-flight state; the next real turn comes via send()
      mode: ref.mode ?? "default",
      mcpServers: ref.mcpServers ?? [],
      loomServer: true,
      ...(ref.model ? { model: ref.model } : {}),
      ...(ref.effort ? { effort: ref.effort } : {}),
      ...(ref.systemPromptAppend ? { systemPromptAppend: ref.systemPromptAppend } : {}),
    };
    const s = new ClaudeSession(opts);
    s.start(opts, { resume: ref.providerRef, ...this.#extra(cli) });
    return s;
  }

  async listPersistedSessions(): Promise<SessionRef[]> {
    // Wired up with the worktree manager (M3), which owns the per-session cwd.
    return [];
  }

  /**
   * The model catalog the CLI reports — no hard-coded list. A throwaway
   * `query()` whose prompt never yields: the `initialize` handshake carries
   * `models`, so we read it and close without running a turn.
   */
  async listModels(): Promise<DiscoveredModel[]> {
    const cli = this.#resolveCli();
    const env = queryEnv({ configDir: this.#configDir });
    const q = sdk.query({
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {})(),
      options: {
        ...(cli ? { pathToClaudeCodeExecutable: cli } : {}),
        env,
        stderr: (data) => log.debug("listModels cli stderr", { data: data.slice(0, 500) }),
      },
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const init = await Promise.race([
        q.initializationResult(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(
            () => rej(new Error("timed out waiting for the Claude CLI handshake")),
            LIST_MODELS_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
      const seen = new Set<string>();
      const out: DiscoveredModel[] = [];
      for (const m of init.models) {
        if (!m.value || m.value === "default") continue; // "default" = whatever the account picks; Loom has its own
        // Some rows tag a context variant in the value / name, e.g. "…[1m]".
        const ctx = parseContextTag(`${m.value} ${m.displayName ?? ""}`);
        const id = (m.resolvedModel || m.value).replace(/\s*\[[^\]]*\]\s*$/, "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          ...(m.displayName ? { label: m.displayName } : {}),
          ...(ctx ? { context: ctx } : {}),
          ...(m.supportsEffort ? { supportsEffort: true } : {}),
          ...(m.supportedEffortLevels && m.supportedEffortLevels.length > 0
            ? { effortLevels: m.supportedEffortLevels }
            : {}),
        });
      }
      return out;
    } finally {
      if (timer) clearTimeout(timer);
      await Promise.resolve(q.close?.()).catch(() => {});
    }
  }
}
