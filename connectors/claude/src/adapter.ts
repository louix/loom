/**
 * The Claude adapter — wraps `@anthropic-ai/claude-agent-sdk` (design spec §3).
 * One `query()` per session in streaming-input mode: the prompt is an async
 * iterable we feed follow-up turns into, `canUseTool` surfaces permission
 * prompts as `HarnessEvent`s, and `SDKMessage`s are normalized by
 * {@link ClaudeEventMapper}. Mode / model changes are live control calls.
 *
 * Auth is not brokered here — the SDK uses Claude's OAuth in `~/.claude`.
 */
import { claudeInitHooks } from "./init-hooks.ts";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
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
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  BackgroundTaskEndedEvent,
  BackgroundTaskInfo,
  DiscardedInput,
  HarnessEvent,
  PlanWindow,
  ProviderTotal,
} from "@loom/core/events";
import { stateRunning } from "@loom/core/session-state";
import { makeLogger, type Logger } from "@loom/core/logger";
import { AsyncChannel } from "@loom/core/channel";
import { WorkerDiagnostic } from "@loom/core/worker";
import { copyClaudeSkills } from "@loom/core/claude-skills";
import {
  ClaudeEventMapper,
  baselineOf,
  planWindows,
  taskKind,
  type SdkGetUsageResponse,
} from "./map.ts";
import { resolveClaudeCli } from "./cli.ts";
import { buildAgentsMcpServer, buildLoomMcpServer, type LoomToolDeps } from "./loom-mcp.ts";
import { PendingInteractions } from "@loom/runtime/pending";
import { AgentCalls } from "@loom/runtime/agent-tools";
import { LOOM_AGENTS_SERVER } from "@loom/core/agents";
import type {
  AdapterSnapshot,
  AgentCallResult,
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
  TaskOutput,
  UserInput,
} from "@loom/core/types";
import type { SendOptions } from "@loom/core/message-queue";

const CAPS: ProviderCapabilities = {
  liveModeSwitch: true,
  liveModelSwitch: true,
  forking: true,
  rewind: true, // fork the transcript truncated, then resume it — ClaudeSession.rewind
  // The SDK's own sub-agent tool is never offered (NATIVE_SUBAGENT_TOOLS): a
  // Loom session delegates through `loom-agents` instead.
  subagents: false,
  compaction: true,
  compactionInstructions: true, // /compact takes a custom summary steer
  ownsTranscript: false, // history lives in the Claude Agent SDK's own session
  oneShot: true,
  // The CLI's `command_lifecycle` frames say when it takes a queued message up.
  inputReceipts: true,
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

/**
 * How long a background task's output read may take before it fails. Under
 * the worker's request timeout, which would take the whole worker down.
 */
const TASK_OUTPUT_TIMEOUT_MS = 5_000;

/**
 * `get_task_output` (CLI 2.1.287, SDK 0.3.287): the SDK's `Query` has the
 * method at runtime, but its public type does not declare it yet.
 */
interface TaskOutputQuery {
  getTaskOutput?(taskId: string): Promise<{
    output: string;
    total_bytes: number;
    truncated: boolean;
  }>;
}

/**
 * How long a resumed query holds its first user message while asking the CLI
 * what it restored (see {@link ClaudeSession.#seedBaseline}). The answer needs
 * the initialize handshake plus one `get_usage` round-trip; past this the
 * persisted fallback seeds the baseline and the turn goes ahead.
 */
let seedTimeoutMs = 10_000;

/** Test-only: shorten {@link seedTimeoutMs}. */
export const __setSeedTimeoutMs = (ms: number): void => {
  seedTimeoutMs = ms;
};

/**
 * `inbox`, held back until `ready` settles. A resumed CLI must not start a
 * turn before Loom has read its restored totals, or the totals would already
 * include new spend.
 */
const afterReady = async function* <T>(
  ready: Promise<void>,
  inbox: AsyncIterable<T>,
): AsyncGenerator<T> {
  await ready;
  yield* inbox;
};

/** `Query.interrupt` as the SDK implements it: it takes `{ cancelQueued }`. */
type InterruptWithOptions = (options: { cancelQueued: boolean }) => ReturnType<Query["interrupt"]>;
const CANCEL_QUEUED = { cancelQueued: true } as const;

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

/**
 * The SDK's built-in sub-agent tool, under its current name and the one it had
 * before (`Task`), withheld from every session: Loom's own agents
 * (`loom-agents`) replace it, and its worktrees under `<repo>/.claude/worktrees`
 * trip the writes-outside-the-workspace guard. Background shells are Bash's
 * `run_in_background` and stay.
 */
export const NATIVE_SUBAGENT_TOOLS = ["Agent", "Task"] as const;

/** The `attribution` setting that hides the commit trailer, the PR line and the session link. */
const NO_ATTRIBUTION = { commit: "", pr: "", sessionUrl: false } as const;

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

/** Lexical containment: is `abs` `base` itself or under it? A sibling that
 *  merely shares the string prefix (`/root-scratch` vs `/root`) is outside. */
const under = (base: string, abs: string): boolean => {
  const rel = relative(base, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Roots a file-mutating tool may target without prompting, on top of the
 * session's worktree: scratch space under the system temp dir, and the profile
 * directory this session's `claude` runs against (`CLAUDE_CONFIG_DIR`, default
 * `~/.claude`) — where the CLI keeps its settings and memory files, which the
 * agent edits on the user's behalf and which by definition never live inside a
 * worktree. `configDir` is the connector's own setting; "" means the default.
 */
export const allowedWriteRoots = (configDir?: string): string[] => {
  const roots = [tmpdir(), "/tmp", configDir ? expandTilde(configDir) : join(homedir(), ".claude")];
  // Containment is lexical, so macOS's `/tmp` → `/private/tmp` and
  // `/var/folders` → `/private/var/folders` symlinks need both spellings — a
  // tool that resolved the path before handing it over reports the `/private` one.
  const aliases = roots
    .filter((r) => r.startsWith("/tmp") || r.startsWith("/var"))
    .map((r) => `/private${r}`);
  return [...new Set([...roots, ...aliases])];
};

/**
 * Reason string when a file-mutating tool call points outside `root` — the
 * session's pinned worktree — or `null` when every checkable path stays in-tree.
 * `hookCwd` is the tool call's live working directory, so a relative path
 * resolves the way the tool would resolve it. Paths under any of
 * `alsoAllowed` (see {@link allowedWriteRoots}) are let through too.
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
  alsoAllowed: readonly string[] = [],
): string | null => {
  if (!BUILTIN_WRITE_TOOLS.has(toolName) && !isTilthWriteTool(toolName)) return null;
  const raw = (toolInput ?? {}) as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const v = raw[key];
    if (typeof v !== "string" || v === "") continue;
    const abs = isAbsolute(v) ? v : resolvePath(hookCwd || root, v);
    if (under(root, abs)) continue;
    if (alsoAllowed.some((base) => under(base, abs))) continue;
    return `writes ${abs}, outside this session's worktree (${root})`;
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

/**
 * Copy Claude session `sourceId` into a new session file (through
 * `upToMessageId`, inclusive, when given) and return the copy's id. Undo and
 * native history forks both use it. `forkSession` reads the transcript from
 * `CLAUDE_CONFIG_DIR` in-process (not a subprocess), so this points Deno's
 * process-wide env at the profile dir for the call. That global mutation is
 * held across an `await`, so every fork in the process is serialised through
 * `forkLock` — two concurrent multi-profile forks would otherwise interleave
 * and fork from the wrong profile (C4).
 *
 * The copy carries the conversation chain only, not the source's `cost-state`
 * stamp, so a resume of it starts its own ledger.
 */
const forkClaudeSession = (
  configDir: string | undefined,
  sourceId: string,
  upToMessageId?: string,
): Promise<string> => {
  const run = forkLock.then(async () => {
    const key = "CLAUDE_CONFIG_DIR";
    const prev = Deno.env.get(key);
    if (configDir) Deno.env.set(key, expandTilde(configDir));
    try {
      const { sessionId } = await sdk.forkSession(sourceId, upToMessageId ? { upToMessageId } : {});
      return sessionId;
    } finally {
      if (configDir) {
        if (prev === undefined) Deno.env.delete(key);
        else Deno.env.set(key, prev);
      }
    }
  });
  forkLock = run.catch(() => {});
  return run;
};

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
  // DISABLE_PROMPT_CACHING is Claude Code's documented switch for no caching at all.
  if (opts.promptCacheTtl === "off") env["DISABLE_PROMPT_CACHING"] = "1";
  else if (opts.promptCacheTtl) env["CLAUDE_CODE_PROMPT_CACHE_TTL"] = opts.promptCacheTtl;
  // Points this session's `claude` at a non-default profile dir.
  if (opts.configDir) env["CLAUDE_CONFIG_DIR"] = expandTilde(opts.configDir);
  return env;
};

/**
 * A local plugin holding copies of the named skills from the profile's config
 * dir. User skills load only with the `user` setting source, which brings the
 * rest of the user settings along; a plugin loads under any setting sources.
 * The Skill tool resolves a bare `coding-style` to `loom:coding-style`.
 */
const skillsPlugin = (
  configDir: string | undefined,
  names: readonly string[],
  log: Logger,
): string => {
  const profile = configDir
    ? expandTilde(configDir)
    : (Deno.env.get("CLAUDE_CONFIG_DIR") ?? join(homedir(), ".claude"));
  const root = Deno.makeTempDirSync({ prefix: "loom-skills-" });
  const copy = copyClaudeSkills(profile, names, join(root, "skills"));
  if (copy.kind === "invalid") {
    Deno.removeSync(root, { recursive: true });
    throw new Error(copy.message);
  }
  for (const skipped of copy.skipped) log.warn("skill symlink not copied", { skipped });
  Deno.mkdirSync(join(root, ".claude-plugin"));
  Deno.writeTextFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "loom" }),
  );
  return root;
};

/** Pull a context-window size out of a `[1m]` / `[200k]` style tag; 0 if none. */
const parseContextTag = (s: string): number => {
  const m = /\[(\d+(?:\.\d+)?)\s*([mk])\]/i.exec(s);
  if (!m) return 0;
  return Math.round(parseFloat(m[1]!) * (m[2]!.toLowerCase() === "m" ? 1_000_000 : 1_000));
};

const userMessage = (
  text: string,
  uuid: string,
  sent: { now: boolean; human: boolean },
): SDKUserMessage => {
  return {
    type: "user",
    // The interrupt receipt only lists UUID-stamped queued messages.
    uuid,
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    // The SDK asks hosts relaying keyboard input to say so: without an origin
    // a message is unattributed, and fails the CLI's isHuman() trust gates.
    ...(sent.human ? { origin: { kind: "human" } } : {}),
    // The CLI moves calls aside only for a message a person typed; one
    // without an origin waits for the tool, then ends the turn to start its own.
    ...(sent.now ? { priority: "now" } : {}),
  } as unknown as SDKUserMessage;
};

/**
 * The tool calls the CLI moves aside for a `priority: "now"` message (CLI
 * 2.1.286+): a shell goes on as a background task, an agent goes to the
 * background, a web call detaches — each result still reaches the model
 * later. For any other running call (an MCP tool, an edit) the CLI falls
 * back after a short grace to stopping the turn for the message, and while
 * the model is only writing it stops the response. So Loom asks for "now"
 * only while every root call in flight is one of these.
 */
const MOVABLE_TOOLS: ReadonlySet<string> = new Set([
  "Bash",
  "PowerShell",
  ...NATIVE_SUBAGENT_TOOLS,
  "WebFetch",
  "WebSearch",
]);

/** How many queued-input uuids {@link ClaudeSession} remembers, either way. */
const QUEUED_INPUTS_MAX = 256;

/** Hold an insertion-ordered collection to its bound, the oldest out first. */
const bounded = <K>(into: Map<K, unknown> | Set<K>): void => {
  if (into.size > QUEUED_INPUTS_MAX) into.delete(into.keys().next().value as K);
};

export const mcpConfig = (handles: McpServerHandle[]): Record<string, McpServerConfig> => {
  const out: Record<string, McpServerConfig> = {};
  for (const h of handles) {
    if (h.spec.transport === "runtime")
      throw new Error("Packaged MCP was not mounted by the daemon");
    if (h.spec.transport === "stdio") {
      const { command, args = [], env, cwd } = h.spec;
      out[h.name] = {
        type: "stdio",
        // The SDK's stdio config has no working directory, so sh changes to it first.
        ...(cwd === undefined
          ? { command, ...(h.spec.args ? { args } : {}) }
          : {
              command: "sh",
              args: ["-c", 'cd -- "$1" && shift && exec "$@"', "sh", cwd, command, ...args],
            }),
        ...(env ? { env } : {}),
        ...(h.requestTimeoutMs ? { timeout: h.requestTimeoutMs } : {}),
      };
    } else {
      out[h.name] = {
        type: "http",
        url: h.spec.url,
        ...(h.spec.headers ? { headers: h.spec.headers } : {}),
        ...(h.requestTimeoutMs ? { timeout: h.requestTimeoutMs } : {}),
      };
    }
  }
  return out;
};

/** Extra `start()` inputs the provider supplies (and `rewind()` re-supplies). */
interface StartExtra {
  resume?: string;
  /** Loom's last observation of the CLI's totals for `resume` — the seed of last resort. */
  usageBaseline?: ProviderTotal;
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
  /** Spans a rewind or fresh implementation's query replacement. Rejects
   *  concurrent transcript operations and keeps `#drain` from closing the
   *  channels while the replacement query is being prepared. */
  #rewindInFlight = false;
  /** The args `start()` last ran with, so `rewind()` can rebuild the query. */
  #startOpts: CreateSessionOptions | null = null;
  #startExtra: StartExtra = {};
  /** What the mounted `loom` tools read at each call. */
  #loomDeps: LoomToolDeps | null = null;

  /** Follow-up turns fed into the streaming-input prompt. */
  #inbox = new AsyncChannel<SDKUserMessage>();
  /**
   * Input Loom queued for the CLI that the agent has not yet been seen taking
   * up, by the uuid it was stamped with. A Stop reports the entries its
   * receipt names as cancelled, along with whatever `#inbox` still held; an
   * assistant frame's `user_message_uuids` retires them as consumed.
   */
  #queued = new Map<string, DiscardedInput>();
  /** Uuids the agent took up or a Stop already reported: a receipt that lists
   *  one again (a repeat interrupt, a fold the abort caught after the agent
   *  answered it) must not report it as never seen. */
  #settledInputs = new Set<string>();
  /**
   * Queued messages sent with an `inputId` (their uuid) that the CLI has not
   * taken up yet, and whether each went into a live turn: each gets one
   * `input_consumed` when it is.
   */
  #receipts = new Map<string, boolean>();
  /** The main loop's tool calls without a result yet: tool_use id → name. */
  #rootToolCalls = new Map<string, string>();
  /** Normalized events out: SDK messages + permission prompts, merged. */
  #outbox = new AsyncChannel<HarnessEvent>();
  #pending = new PendingInteractions<PermissionResult | null, PermissionResult | null>();
  readonly #agentCalls = new AgentCalls();
  #plans = new Map<string, string>();
  #interruptEpoch = 0;
  #contextPollEpoch = 0;
  #taskIds = new Set<string>();
  /**
   * Tasks that settled (a `task_notification`, or a stop Loom confirmed). A
   * level that still lists one lags behind the bookend and is not believed —
   * until a `task_started` registers the id again: `SendMessage` resumes a
   * finished sub-agent under its old task id.
   */
  #finishedTaskIds = new Set<string>();
  #backgroundTaskIds = new Set<string>();
  /** What each task started as: its tool call, and what kind of task it is. */
  #taskStarts = new Map<
    string,
    { toolId?: string; kind: BackgroundTaskInfo["kind"]; title: string }
  >();
  /** The CLI's last `background_tasks_changed` set, ambient entries dropped. */
  #levelTasks: BackgroundTaskInfo[] = [];
  /** What was last published: {@link #levelTasks} minus finished tasks. */
  #backgroundTasks: BackgroundTaskInfo[] = [];
  #taskStops = new Map<string, Promise<void>>();
  #interruptOperation: Promise<void> | null = null;
  #interruptFailed = false;
  #pump: Promise<void> | null = null;
  #closing = false;
  /**
   * Set by `interrupt()`, cleared by the next `send()`. The SDK's `interrupt()`
   * aborts the live turn but not turns already sitting in its command queue (a
   * message the user sent mid-turn, or the plan-approval path's own follow-up).
   * While this is set, `#drain` keeps the mapper's accounting current but drops
   * conversational events while forwarding usage and task lifecycle cleanup. A queued
   * turn cannot stream chatter into a stopped session. A real `send()`
   * supersedes the interrupt once cancellation has completed.
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

  /**
   * Settles once a resumed query's accounting baseline is seeded; null when the
   * query needs no seed. `#drain` maps no `result` before it, so a result can
   * never be diffed against an unseeded baseline. Always settles, by
   * {@link seedTimeoutMs} at the latest.
   */
  #seeding: Promise<void> | null = null;
  /** Ends a pending seed wait early on close. */
  #cancelSeed: (() => void) | null = null;

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

  #initDirectory: string | undefined;
  /** The local plugin carrying the profile's skills; kept across restarts. */
  #skillsPlugin: string | undefined;

  /** Build the `query()` and start pumping its messages into the outbox. */
  start(opts: CreateSessionOptions, extra: StartExtra = {}): void {
    if (opts.skills?.length && !opts.oneShot && !this.#skillsPlugin)
      this.#skillsPlugin = skillsPlugin(extra.configDir, opts.skills, this.#log);
    let init: ReturnType<typeof claudeInitHooks> | undefined;
    if (opts.initHooks?.hooks.length && !opts.oneShot) {
      this.#initDirectory = Deno.makeTempDirSync({ prefix: "loom-init-" });
      init = claudeInitHooks(opts, this.#initDirectory);
      opts = {
        ...opts,
        systemPromptAppend: [opts.systemPromptAppend, init.context].filter(Boolean).join("\n\n"),
      };
    }
    opts = { ...opts };
    delete opts.initHooks;
    // Folded in once, here: a restarted query (rewind, plan) reuses these opts.
    if (opts.agentPrompt) {
      opts.systemPromptAppend = [opts.systemPromptAppend, opts.agentPrompt]
        .filter(Boolean)
        .join("\n\n");
      delete opts.agentPrompt;
    }
    this.#taskIds.clear();
    this.#rootToolCalls.clear();
    this.#finishedTaskIds.clear();
    this.#backgroundTaskIds.clear();
    this.#taskStarts.clear();
    this.#levelTasks = [];
    this.#backgroundTasks = [];
    this.#startOpts = opts;
    this.#startExtra = extra;
    const { resume, cli, promptCacheTtl, configDir } = extra;
    // A new CLI process: the old one's queue and its uuids are gone with it.
    this.#queued.clear();
    this.#settledInputs.clear();
    this.#receipts.clear();
    if (opts.prompt)
      this.#enqueueInput(opts.prompt, "message", opts.promptByHuman ? { human: true } : {});

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
        this.#plans.set(reqId, plan);
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
    // file-mutating tool whose target escapes the session's worktree — and
    // isn't under one of the always-writable roots (`allowedWriteRoots`) — it
    // forces an `ask`, which flows back through `canUseTool` as a normal
    // `permission_request`. Self-gates on the *live* mode — every other mode
    // already prompts, so the guard would only double up.
    const worktreeRoot = opts.cwd;
    const writableOutsideTree = allowedWriteRoots(configDir);
    const guardOutOfTreeWrites: HookCallback = (input) => {
      if (input.hook_event_name !== "PreToolUse") return Promise.resolve({});
      // Auto-approved tools bypass canUseTool. A queued turn that survives
      // the native interrupt must still be unable to perform more work.
      if (this.#interrupted)
        return Promise.resolve({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "The session was interrupted.",
          },
        });
      if (this.#mode !== "auto") return Promise.resolve({});
      const reason = outOfTreeWriteReason(
        worktreeRoot,
        input.cwd,
        input.tool_name,
        input.tool_input,
        writableOutsideTree,
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
      // Kept, so `setBase` reaches the `status` tool of the running query.
      this.#loomDeps = {
        cwd: opts.cwd,
        ...(extra.base ? { base: extra.base } : {}),
        askUser: (question, context) => this.#askUser(question, context),
      };
      mcpServers["loom"] = buildLoomMcpServer(this.#loomDeps);
    }
    if (opts.agentTools && !opts.oneShot)
      mcpServers[LOOM_AGENTS_SERVER] = buildAgentsMcpServer((tool, input) =>
        this.#agentCall(tool, input),
      );

    const env = queryEnv({ promptCacheTtl, configDir });
    const queryEffort = opts.effort ? asQueryEffort(opts.effort) : undefined;
    const options: Options = {
      // Flag settings: no `Co-Authored-By` trailer or PR line, whatever the
      // user's settings say. Loom's Git identity decides authorship. Not
      // `attribution: false`: CLIs before 2.1.281 (a user's `cli_path`) report
      // it as an invalid setting; every version takes empty strings.
      settings: { ...init?.settings, attribution: NO_ATTRIBUTION },
      cwd: opts.cwd,
      permissionMode: toPermissionMode(opts.mode),
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [guardOutOfTreeWrites] }] },
      includePartialMessages: false,
      mcpServers,
      stderr: (data) => this.#log.debug("cli stderr", { data: data.slice(0, 500) }),
      env,
      ...(opts.oneShot
        ? {
            tools: [],
            mcpServers: {},
            strictMcpConfig: true,
            settingSources: [],
            maxTurns: 1,
            persistSession: false,
          }
        : {}),
      ...(cli ? { pathToClaudeCodeExecutable: cli } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(queryEffort ? { effort: queryEffort } : {}),
      ...(resume ? { resume } : {}),
      disallowedTools: [
        ...new Set([
          ...NATIVE_SUBAGENT_TOOLS,
          ...(opts.disableTools ?? []),
          ...(opts.denyTools ?? []),
        ]),
      ],
      // An agent profile's allow list narrows the built-in tools; MCP stays.
      ...(opts.allowTools && !opts.oneShot ? { tools: opts.allowTools } : {}),
      ...(opts.skills && !opts.oneShot ? { skills: opts.skills } : {}),
      ...(this.#skillsPlugin
        ? { plugins: [{ type: "local", path: this.#skillsPlugin, skipMcpDiscovery: true }] }
        : {}),
      ...(opts.settingSources && !opts.oneShot
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
      ...(opts.subagents && opts.subagents.length > 0 && !opts.oneShot
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

    // A fresh CLI session starts its ledger at zero, which is the mapper's
    // baseline already. A resumed one restores what it saved, so its first
    // user message waits until that has been read. A seed still pending for a
    // replaced query is moot.
    this.#cancelSeed?.();
    const seeded = resume ? Promise.withResolvers<void>() : null;
    try {
      this.#query = sdk.query({
        prompt: seeded ? afterReady(seeded.promise, this.#inbox) : this.#inbox,
        options,
      });
    } catch (error) {
      if (init && this.#initDirectory) {
        Deno.removeSync(this.#initDirectory, { recursive: true });
        this.#initDirectory = undefined;
      }
      if (this.#skillsPlugin && !this.#query) {
        Deno.removeSync(this.#skillsPlugin, { recursive: true });
        this.#skillsPlugin = undefined;
      }
      throw error;
    }
    this.#seeding = seeded?.promise ?? null;
    this.#pump = this.#drain();
    const query = this.#query;
    if (seeded) {
      void this.#seedBaseline(query, resume!, extra.usageBaseline)
        .catch((err) => this.#log.warn("usage baseline failed", { err: String(err) }))
        .finally(seeded.resolve);
      return;
    }

    // Prime the plan rate-limit windows once the CLI handshake lands, so the
    // session shows real `five_hour` / `seven_day` numbers within a second
    // instead of waiting for the next spontaneous `rate_limit_event`. A
    // resumed query gets both from its seed.
    void query
      .initializationResult()
      .then(async () => {
        if (this.#query !== query || this.#closing) return;
        await Promise.all([this.#pollPlanUsage(), this.#pollContextLimit()]);
      })
      .catch(() => {});
  }

  /**
   * Seed a resumed query's accounting baseline with what its CLI restored. A
   * resumed CLI continues from the totals its transcript saved at its last
   * graceful exit, and every result reports those plus new spend. Asked before
   * the first turn, `get_usage` reports exactly the restored part. When it
   * can't answer in time, Loom's last observation of the same CLI session
   * stands in: it never over-charges, but after a crash (an older or missing
   * stamp) it under-charges the new process until it passes that mark. With
   * neither, the baseline stays zero and the restored spend is charged again.
   */
  async #seedBaseline(q: Query, ref: string, fallback: ProviderTotal | undefined): Promise<void> {
    const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    const asked = q
      .initializationResult()
      .then(() =>
        typeof fn === "function"
          ? (fn.call(q, { skipBehaviors: true }) as Promise<SdkGetUsageResponse>)
          : null,
      );
    // The plan windows are worth showing whenever they arrive.
    void asked
      .then((resp) => {
        if (this.#closing || this.#query !== q) return;
        this.#lastPlanPollAt = Date.now();
        for (const ev of this.#mapper.mapPlanUsage(resp)) this.#outbox.push(ev);
      })
      .catch(() => {});
    void q
      .initializationResult()
      .then(() => {
        if (this.#query === q && !this.#closing) return this.#pollContextLimit();
      })
      .catch(() => {});

    // Only an answer that lands before the first turn is released describes
    // the restored ledger alone; a later one is ignored for seeding.
    const resp = await new Promise<SdkGetUsageResponse | null>((resolve) => {
      const settle = (r: SdkGetUsageResponse | null) => {
        clearTimeout(timer);
        if (this.#cancelSeed === cancel) this.#cancelSeed = null;
        resolve(r);
      };
      const cancel = () => settle(null);
      const timer = setTimeout(cancel, seedTimeoutMs);
      this.#cancelSeed = cancel;
      asked.then(settle, cancel);
    });
    if (this.#query !== q || this.#closing) return;
    const reported = baselineOf(resp);
    const persisted =
      fallback && fallback.ref === ref
        ? { costUsd: fallback.costUsd, usage: fallback.tokens }
        : null;
    const seed = reported ?? persisted;
    if (seed) this.#mapper.seedQueryBaseline(seed);
    let source = "none";
    if (reported) source = "provider";
    else if (persisted) source = "persisted";
    this.#log.info("usage baseline", { source, costUsd: seed?.costUsd ?? 0 });
  }

  /** Discover the window before the first turn finishes. Keep request usage
   * from the message stream; the context report is only our source of capacity. */
  async #pollContextLimit(): Promise<void> {
    const q = this.#query;
    if (!q || typeof q.getContextUsage !== "function") return;
    const epoch = ++this.#contextPollEpoch;
    try {
      const report = await q.getContextUsage();
      if (this.#closing || this.#query !== q || epoch !== this.#contextPollEpoch) return;
      const limit = report.rawMaxTokens > 0 ? report.rawMaxTokens : report.maxTokens;
      if (!Number.isFinite(limit) || limit <= 0) return;
      this.#mapper.state.contextLimit = limit;
      this.#outbox.push({
        type: "context",
        sessionId: this.id,
        ts: Date.now(),
        contextUsed: this.#mapper.state.contextUsed,
        contextLimit: limit,
      });
    } catch (err) {
      this.#log.debug("context limit poll failed", { err: String(err) });
    }
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
    const seeding = this.#seeding;
    try {
      for await (const msg of q) {
        // A startup-error result can precede the first turn; it must not be
        // diffed against a baseline that is still being read.
        if (msg.type === "result" && seeding) await seeding;
        this.#trackTasks(msg);
        this.#trackRootToolCalls(msg);
        this.#trackConsumed(msg);
        if (msg.type === "system" && msg.subtype === "init") {
          const missing = (this.#startOpts?.mcpServers ?? []).filter(
            (server) =>
              server.required &&
              !msg.mcp_servers.some(
                (status) => status.name === server.name && status.status === "connected",
              ),
          );
          if (missing.length) {
            q.close();
            throw new Error(
              `Required tools failed to connect: ${missing.map((server) => server.name).join(", ")}`,
            );
          }
        }
        // Always run the mapper — it carries cumulative token / cost state
        // that must stay correct even for a turn we're suppressing.
        const events = this.#mapper.map(msg);
        for (const event of events) {
          if (event.type === "background_tasks") {
            this.#levelTasks = event.tasks;
            event.tasks = this.#liveBackgroundTasks();
            this.#backgroundTasks = event.tasks;
          }
        }
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
        if (this.#interrupted) {
          // Spend is not chatter: an interrupted turn was still billed, and
          // the mapper has already moved its baseline past it.
          for (const ev of events)
            if (
              ev.type === "subagent_stopped" ||
              ev.type === "background_tasks" ||
              ev.type === "usage"
            )
              this.#outbox.push(ev);
          continue;
        }
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
    this.#plans.clear();
    this.#pending.failAll({ behavior: "deny", message: reason }, `(${reason})`, {
      behavior: "deny",
      message: reason,
    });
    this.#agentCalls.failAll(`(${reason})`);
    // An in-flight compaction is pending on the same process: interrupt /
    // stream-end / close all abandon it. The error event is what clients use
    // to clear the "compacting…" indicator (trackCompacting in the TUI model).
    this.#settleCompact(`compaction abandoned — ${reason}`);
  }

  events(): AsyncIterable<HarnessEvent> {
    return this.#outbox;
  }

  send(input: UserInput, opts: SendOptions = {}): Promise<void> {
    return this.#submit(input, "message", opts);
  }

  /** A new turn's input: `send()`'s, or the adapter's own follow-up. */
  async #submit(
    input: UserInput,
    kind: "message" | "command",
    opts: SendOptions = {},
  ): Promise<void> {
    if (this.#closing) throw new Error("session is closing");
    if (this.#interruptOperation || this.#interruptFailed || this.#taskStops.size > 0)
      throw new Error("Claude cancellation is unresolved — retry interrupt before sending");
    if (this.#rewindInFlight) throw new Error("a context replacement is in progress");
    this.#interrupted = false; // a fresh user turn supersedes any prior interrupt
    this.#enqueueInput(input, kind, opts);
  }

  /** Queue `text` for the CLI, remembered under its uuid until the agent takes
   *  it up — see {@link #queued}. A queued message is stamped with its own
   *  `inputId`, which is what the CLI's receipts name. */
  #enqueueInput(text: string, kind: "message" | "command", opts: SendOptions = {}): void {
    const uuid = opts.inputId ?? randomUUID();
    this.#queued.set(uuid, { kind, text, ref: uuid });
    bounded(this.#queued);
    if (opts.inputId !== undefined) {
      this.#receipts.set(uuid, opts.midTurn ?? false);
      bounded(this.#receipts);
    }
    const calls = [...this.#rootToolCalls.values()];
    const now =
      opts.now === true &&
      opts.midTurn === true &&
      calls.length > 0 &&
      calls.every((name) => MOVABLE_TOOLS.has(name));
    if (opts.now) this.#log.info("send now", { inputId: uuid, running: calls, now });
    this.#inbox.push(userMessage(text, uuid, { now, human: now || opts.human === true }));
  }

  /** Follow the main loop's tool calls in flight — what a send-now would
   *  have the CLI move aside ({@link MOVABLE_TOOLS}). */
  #trackRootToolCalls(msg: SDKMessage): void {
    if (msg.type === "result") {
      this.#rootToolCalls.clear();
      return;
    }
    if ((msg.type !== "assistant" && msg.type !== "user") || msg.parent_tool_use_id != null) return;
    const content: unknown = msg.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<{
      type?: string;
      id?: string;
      name?: string;
      tool_use_id?: string;
    }>) {
      if (msg.type === "assistant" && block.type === "tool_use" && block.id && block.name)
        this.#rootToolCalls.set(block.id, block.name);
      else if (msg.type === "user" && block.type === "tool_result" && block.tool_use_id)
        this.#rootToolCalls.delete(block.tool_use_id);
    }
  }

  /**
   * The agent took these queued inputs up; a Stop can no longer discard them.
   * The CLI says so as it happens with a `command_lifecycle` frame in state
   * `started` — at the start of the turn it runs, or straight after the tool
   * result it is folded into (not in the SDK's typings; seen on CLI 2.1.280).
   * The `user_message_uuids` an assistant or `result` frame carries back it
   * up: a `result` lists every message its turn consumed, folds included.
   */
  #trackConsumed(msg: SDKMessage): void {
    const frame = msg as unknown as {
      type: string;
      command_uuid?: string;
      state?: string;
      user_message_uuid?: string;
      user_message_uuids?: string[];
    };
    if (frame.type === "command_lifecycle") {
      if (frame.state === "started" && frame.command_uuid) this.#takenUp(frame.command_uuid);
      return;
    }
    if (frame.type !== "assistant" && frame.type !== "result") return;
    const uuids =
      frame.user_message_uuids ?? (frame.user_message_uuid ? [frame.user_message_uuid] : []);
    for (const uuid of uuids) this.#takenUp(uuid);
  }

  #takenUp(uuid: string): void {
    const midTurn = this.#receipts.get(uuid);
    this.#settleInput(uuid);
    if (midTurn === undefined) return;
    this.#outbox.push({
      type: "input_consumed",
      sessionId: this.id,
      ts: Date.now(),
      inputId: uuid,
      midTurn,
    });
  }

  #settleInput(uuid: string): void {
    this.#queued.delete(uuid);
    this.#receipts.delete(uuid);
    this.#settledInputs.add(uuid);
    bounded(this.#settledInputs);
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
    if (this.#rewindInFlight) throw new Error("a context replacement is in progress");
    const trimmed = instructions?.trim();
    this.#enqueueInput(trimmed ? `/compact ${trimmed}` : "/compact", "command");
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
      this.#pending.resolvePermission(id, {
        behavior: "deny",
        message: decision.message ?? "denied by user",
      });
    }
  }

  /** loom `ask_user` handler: emit a `question` event, block until answered. */
  #askUser(question: string, context: string | undefined): Promise<string> {
    if (this.#interrupted || this.#closing) return Promise.resolve("The session was interrupted.");
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

  /** `loom-agents` handler: hand the call to the daemon, block until answered. */
  #agentCall(tool: string, input: Record<string, unknown>): Promise<AgentCallResult> {
    if (this.#interrupted || this.#closing)
      return Promise.resolve({ ok: false, text: "The session was interrupted." });
    return this.#agentCalls.call((id) =>
      this.#outbox.push({
        type: "agent_call",
        sessionId: this.id,
        ts: Date.now(),
        id,
        tool,
        input,
      }),
    );
  }

  async respondToAgentCall(id: string, result: AgentCallResult): Promise<void> {
    this.#agentCalls.resolve(id, result);
  }

  async setBase(base: string): Promise<void> {
    // A rewind rebuilds the query from `#startExtra`; the live tools read deps.
    this.#startExtra = { ...this.#startExtra, base };
    if (this.#loomDeps) this.#loomDeps.base = base;
  }

  /** The daemon wants the plan windows now (a client is showing stale ones):
   *  poll past the per-turn throttle. Not awaited — the windows arrive as
   *  `rate_limit` events, and a slow `/usage` must not hold the request. */
  async refreshPlanUsage(): Promise<void> {
    if (this.#closing) return;
    void this.#pollPlanUsage();
  }

  /**
   * The last 8 KiB of a background shell or Monitor task's output — the tail
   * the CLI's own task view reads. The CLI refuses any other task (an agent,
   * or an id not of this session), and an older CLI has no such request:
   * both read as `unreadable`.
   */
  async readTaskOutput(taskId: string): Promise<TaskOutput> {
    const q = this.#query as (Query & TaskOutputQuery) | null;
    if (this.#closing || !q || typeof q.getTaskOutput !== "function") return { t: "unreadable" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const r = await Promise.race([
        q.getTaskOutput(taskId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error("timed out reading the task output"));
          }, TASK_OUTPUT_TIMEOUT_MS);
        }),
      ]);
      return {
        t: "output",
        output: typeof r.output === "string" ? r.output : "",
        totalBytes: Number.isInteger(r.total_bytes) && r.total_bytes >= 0 ? r.total_bytes : 0,
        truncated: r.truncated === true,
      };
    } catch (err) {
      if (timedOut) throw err;
      this.#log.debug("task output refused", {
        taskId,
        err: err instanceof Error ? err.message : String(err),
      });
      return { t: "unreadable" };
    } finally {
      clearTimeout(timer);
    }
  }

  async respondToPlan(id: string, decision: PlanDecision): Promise<void> {
    if (!this.#pending.hasPlan(id)) return; // already resolved / unknown — first writer won

    const approvedPlan = this.#plans.get(id);
    this.#plans.delete(id);
    if (decision.action === "implement_fresh") {
      await this.#implementFresh(decision, approvedPlan ?? "");
      return;
    }

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

    this.#pending.resolvePlan(id, {
      behavior: "deny",
      message: "Plan accepted — implementing now.",
    });
    await this.setMode(decision.mode ?? "acceptEdits");
    const plan = decision.action === "revise" ? decision.plan : "the plan you just presented";
    await this.#submit(`The plan is approved. Implement it now:\n\n${plan}`, "command");
  }

  async #implementFresh(
    decision: Extract<PlanDecision, { action: "implement_fresh" }>,
    plan: string,
  ): Promise<void> {
    if (!this.#startOpts) throw new Error("this session was never started");
    if (!plan.trim()) throw new Error("fresh implementation needs the approved plan text");
    if (this.#rewindInFlight) throw new Error("a context replacement is already in progress");
    if (this.#closing) throw new Error("session is closing");

    // Denying ExitPlanMode resumes the planning model. Close that query before
    // resolving its review. A new query applies the implementation settings
    // before its first inference and carries only the approved plan and goal.
    this.#rewindInFlight = true;
    this.#interrupted = true;
    const interruptEpoch = this.#interruptEpoch;
    try {
      this.#inbox.drain();
      this.#inbox.close();
      this.#query?.close();
      this.#rejectPending("Plan approved — implementation continues in a new context.");
      await this.#pump;
      if (this.#closing || this.#interruptEpoch !== interruptEpoch) {
        this.#outbox.close();
        return;
      }

      const opts = this.#startOpts;
      const { resume: _resume, ...extra } = this.#startExtra;
      this.#inbox = new AsyncChannel<SDKUserMessage>();
      this.#mapper.onQuerySwap();
      const before = this.#mapper.state.contextUsed;
      this.#mapper.state.providerRef = null;
      this.#mapper.state.contextUsed = 0;
      this.#mode = decision.mode ?? "acceptEdits";
      this.#model = decision.model ?? this.#model;
      this.#effort = decision.effort ?? this.#effort;
      this.#mapper.state.model = this.#model ?? null;
      this.#interrupted = false;
      this.start(
        {
          ...opts,
          prompt: `The plan is approved. Implement it now.\n\nOriginal goal: ${opts.prompt}\n\n${plan}`,
          mode: this.#mode,
          ...(this.#model ? { model: this.#model } : {}),
          ...(this.#effort ? { effort: this.#effort } : {}),
        },
        extra,
      );
      // Invalidate undo checkpoints into the discarded native transcript.
      this.#outbox.push({
        type: "compact",
        sessionId: this.id,
        ts: Date.now(),
        trigger: "manual",
        before,
        after: 0,
        summary: plan,
      });
    } catch (err) {
      this.#outbox.push({
        type: "error",
        sessionId: this.id,
        ts: Date.now(),
        message: `Could not start fresh implementation: ${err instanceof Error ? err.message : String(err)}`,
        fatal: true,
      });
      this.#inbox.close();
      this.#outbox.close();
      throw err;
    } finally {
      this.#rewindInFlight = false;
    }
  }

  interrupt(): Promise<void> {
    if (this.#interruptOperation) return this.#interruptOperation;
    const operation = this.#interruptAll().finally(() => {
      this.#interruptOperation = null;
    });
    this.#interruptOperation = operation;
    return operation;
  }

  async #interruptAll(): Promise<void> {
    this.#interruptEpoch++;
    // Stop the live turn, and don't let anything queued behind it speak into
    // the stopped session. `#inbox.drain()` clears sends the SDK hasn't pulled
    // yet; `cancelQueued` has the CLI drop what it already queued behind the
    // turn (sends made mid-turn, sub-agent hand-backs, task notifications).
    // Without it each of those would run as its own turn after the stop, so a
    // retry could only ever clear one of them. `#interrupted` (lifted by the
    // next `send()`) still muzzles anything an older CLI lets through.
    this.#interrupted = true;
    // C6: release any gate / ask_user / plan promise parked on this turn now —
    // don't wait for the stream to end or `close()` to run.
    this.#rejectPending("the turn was interrupted");
    const drained = this.#inbox.drain();
    let cancelled: readonly string[] = [];
    const failures: string[] = [];
    const parent = Promise.resolve().then(async () => {
      try {
        const q = this.#query;
        // The SDK forwards `cancelQueued` as the control request's
        // `cancel_queued` (CLI capability `interrupt_cancel_queued_v1`), though
        // its typings don't declare the parameter yet.
        const receipt = q
          ? await (q.interrupt as InterruptWithOptions).call(q, CANCEL_QUEUED)
          : undefined;
        cancelled = receipt?.cancelled ?? [];
        if (receipt?.still_queued?.length)
          failures.push(`Claude still has ${receipt.still_queued.length} queued turn(s)`);
      } catch (err) {
        failures.push(String(err));
      }
    });
    const attempted = new Set<string>();
    const stopChildren = async (): Promise<void> => {
      for (;;) {
        const ids = [...this.#taskIds].filter((id) => !attempted.has(id));
        if (!ids.length) break;
        for (const id of ids) attempted.add(id);
        const results = await Promise.allSettled(ids.map((id) => this.#stopTask(id)));
        for (const result of results)
          if (result.status === "rejected") failures.push(String(result.reason));
      }
    };
    // Stop known children without waiting for the parent (which may itself be
    // awaiting a child), then sweep registrations that arrived during its ACK.
    await stopChildren();
    await parent;
    // Reported whether or not the rest of the stop succeeds: these are gone.
    this.#reportDiscarded(drained, cancelled);
    await stopChildren();
    this.#interruptFailed = failures.length > 0;
    if (failures.length) throw new Error(`Claude cancellation incomplete: ${failures.join("; ")}`);
  }

  /**
   * Tell the session manager what this Stop dropped that the agent never saw:
   * sends the SDK had not yet pulled from `#inbox`, and the queued commands
   * the interrupt receipt lists under `cancelled` (uuid-stamped main-thread
   * commands only — the CLI dequeues its uuid-less task notifications too, but
   * cannot name them). A cancelled uuid Loom never sent is the CLI's own.
   */
  #reportDiscarded(drained: readonly SDKUserMessage[], cancelled: readonly string[]): void {
    // In queue order: the CLI's queue holds what the SDK pulled before
    // anything still sitting in `#inbox`.
    const items: DiscardedInput[] = [];
    for (const uuid of cancelled) {
      if (this.#settledInputs.has(uuid)) continue;
      items.push(this.#queued.get(uuid) ?? { kind: "notification", ref: uuid });
      this.#settleInput(uuid);
    }
    for (const msg of drained) {
      const uuid = msg.uuid ?? randomUUID();
      const content = msg.message.content;
      items.push(
        this.#queued.get(uuid) ?? {
          kind: "message",
          text: typeof content === "string" ? content : "",
          ref: uuid,
        },
      );
      this.#settleInput(uuid);
    }
    if (items.length)
      this.#outbox.push({ type: "input_discarded", sessionId: this.id, ts: Date.now(), items });
  }

  #stopTask(id: string): Promise<void> {
    const pending = this.#taskStops.get(id);
    if (pending) return pending;
    const q = this.#query;
    // Defer invocation until after the promise is registered, including the
    // missing-method case which otherwise settles before the map insertion.
    const stop = Promise.resolve().then(async () => {
      try {
        if (!q || typeof q.stopTask !== "function")
          throw new Error("this Claude runtime does not support stopping tasks");
        await q.stopTask(id);
        if (q === this.#query) this.#retireTask(id, "stopped");
      } catch (err) {
        if (q === this.#query && this.#taskIds.has(id))
          throw new Error(`task ${id}: ${String(err)}`);
      } finally {
        this.#taskStops.delete(id);
      }
    });
    this.#taskStops.set(id, stop);
    return stop;
  }

  #trackTasks(msg: SDKMessage): void {
    if (msg.type !== "system") return;
    const added: string[] = [];
    if (msg.subtype === "task_started") {
      if (msg.ambient || msg.skip_transcript) return;
      this.#taskIds.add(msg.task_id);
      this.#taskStarts.set(msg.task_id, {
        ...(msg.tool_use_id ? { toolId: msg.tool_use_id } : {}),
        kind: taskKind(msg.task_type),
        title: msg.description || msg.task_type || "background task",
      });
      added.push(msg.task_id);
      // A finished sub-agent resumed by `SendMessage` starts again under its
      // old id. The level listing it came first and was not believed then.
      if (this.#finishedTaskIds.delete(msg.task_id)) {
        if (this.#levelTasks.some((task) => task.id === msg.task_id))
          this.#backgroundTaskIds.add(msg.task_id);
        this.#publishBackgroundTasks();
      }
    } else if (msg.subtype === "task_notification") {
      this.#retireTask(msg.task_id, msg.status);
    } else if (msg.subtype === "background_tasks_changed") {
      const ids = new Set(
        msg.tasks
          .filter((task) => !task.ambient && !this.#finishedTaskIds.has(task.task_id))
          .map((task) => task.task_id),
      );
      for (const id of this.#backgroundTaskIds) if (!ids.has(id)) this.#taskIds.delete(id);
      for (const id of ids) {
        this.#taskIds.add(id);
        added.push(id);
      }
      this.#backgroundTaskIds = ids;
    }
    // Late task registrations must not escape an already completed interrupt.
    if (this.#interrupted && !this.#interruptOperation && !this.#closing && !this.#rewindInFlight) {
      for (const id of added) {
        void this.#stopTask(id).catch((err: unknown) => {
          this.#interruptFailed = true;
          this.#outbox.push({
            type: "error",
            sessionId: this.id,
            ts: Date.now(),
            fatal: true,
            message: `Claude cancellation incomplete: ${String(err)} — retry interrupt`,
          });
        });
      }
    }
  }

  #retireTask(id: string, status: BackgroundTaskEndedEvent["status"]): void {
    this.#finishedTaskIds.add(id);
    this.#taskIds.delete(id);
    const start = this.#taskStarts.get(id);
    this.#taskStarts.delete(id);
    // A sub-agent's row is keyed by the tool call that spawned it.
    if (start?.kind === "subagent" && start.toolId)
      this.#outbox.push({
        type: "subagent_stopped",
        sessionId: this.id,
        ts: Date.now(),
        subagentId: start.toolId,
      });
    else if (start && start.kind !== "subagent")
      this.#outbox.push({
        type: "background_task_ended",
        sessionId: this.id,
        ts: Date.now(),
        taskId: id,
        kind: start.kind,
        title: start.title,
        status,
      });
    this.#publishBackgroundTasks();
  }

  /** The live background set: the CLI's level, less tasks known to have settled. */
  #liveBackgroundTasks(): BackgroundTaskInfo[] {
    return this.#levelTasks.filter((task) => !this.#finishedTaskIds.has(task.id));
  }

  /** Publish the live set when a bookend changed its membership between levels. */
  #publishBackgroundTasks(): void {
    const tasks = this.#liveBackgroundTasks();
    const ids = (list: BackgroundTaskInfo[]): string =>
      list
        .map((task) => task.id)
        .sort()
        .join(",");
    if (ids(tasks) === ids(this.#backgroundTasks)) return;
    this.#backgroundTasks = tasks;
    this.#outbox.push({ type: "background_tasks", sessionId: this.id, ts: Date.now(), tasks });
  }

  /**
   * Undo. `resumeSessionAt` isn't honoured in streaming-input mode, so instead
   * {@link forkSession} writes a *new* transcript file sliced at `at` (the kept
   * turn's last chain-entry UUID — {@link ClaudeEventMapper} tracks it), and we
   * swap the live `query()` for a plain resume of that shorter fork. `#outbox`
   * survives the swap so the daemon's event stream is unbroken; the mapper is
   * kept, so cumulative cost never regresses, and the resumed fork's ledger is
   * seeded like any other resume. `_keep` is the aisdk message count — unused
   * here.
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
      // The conversation now lives in the fork. Its `init` would say so, but
      // only once the next turn starts; a revive before then must not resume
      // the pre-undo transcript.
      this.#mapper.state.providerRef = forkedId;
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

  #forkTruncated(sourceId: string, upToMessageId: string): Promise<string> {
    return forkClaudeSession(this.#startExtra.configDir, sourceId, upToMessageId);
  }

  /** A native history fork resumes a copy whose id the daemon records before
   *  the CLI has reported it (the CLI says nothing until its first turn). */
  adoptProviderRef(ref: string): void {
    this.#mapper.state.providerRef = ref;
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
      this.#mapper.state.model = model;
      void this.#pollContextLimit();
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
    this.#cancelSeed?.();
    this.#rejectPending("the session was closed before this was answered");
    try {
      this.#query?.close();
    } catch {
      // best effort
    }
    this.#outbox.close();
    this.#inbox.close();
    await this.#pump?.catch(() => {});
    if (this.#initDirectory)
      await Deno.remove(this.#initDirectory, { recursive: true }).catch(() => {});
    if (this.#skillsPlugin)
      await Deno.remove(this.#skillsPlugin, { recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------

export interface ClaudeProviderOptions {
  /** Provider id this instance serves — `claude` or `claude:<profile>`. */
  id?: string;
  /** `providers.claude.cli_path` — "" means discover / bundled. */
  cliPath?: string;
  /** `providers.claude.prompt_cache_ttl` — "5m" | "1h" | "off" | "" (CLI decides). */
  promptCacheTtl?: string;
  /** `CLAUDE_CONFIG_DIR` for this profile — "" leaves the SDK's default. */
  configDir?: string;
  /** The repo's base branch — feeds the `status` tool's ahead/behind counts. */
  base?: string;
}

export class ClaudeProvider implements AgentProvider {
  readonly supportsAsyncInit = true;
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

  /** `session`: the session's own base, when the daemon passed one. */
  #extra(cli: string | undefined, session: string | undefined) {
    const base = session ?? this.#base;
    return {
      ...(cli ? { cli } : {}),
      ...(this.#promptCacheTtl ? { promptCacheTtl: this.#promptCacheTtl } : {}),
      ...(this.#configDir ? { configDir: this.#configDir } : {}),
      ...(base ? { base } : {}),
    };
  }

  async createSession(opts: CreateSessionOptions): Promise<AgentSession> {
    const cli = this.#resolveCli();
    const s = new ClaudeSession(opts);
    s.start(opts, this.#extra(cli, opts.base));
    return s;
  }

  async resumeSession(ref: SessionRef): Promise<AgentSession> {
    const cli = this.#resolveCli();
    const opts: CreateSessionOptions = {
      sessionId: ref.sessionId,
      cwd: ref.cwd,
      ...(ref.initHooks ? { initHooks: ref.initHooks } : {}),
      prompt: "", // resume replays in-flight state; the next real turn comes via send()
      mode: ref.mode ?? "default",
      mcpServers: ref.mcpServers ?? [],
      loomServer: true,
      ...(ref.model ? { model: ref.model } : {}),
      ...(ref.effort ? { effort: ref.effort } : {}),
      ...(ref.systemPromptAppend ? { systemPromptAppend: ref.systemPromptAppend } : {}),
      ...(ref.agentTools ? { agentTools: true } : {}),
      ...(ref.agentPrompt ? { agentPrompt: ref.agentPrompt } : {}),
      ...(ref.skills ? { skills: ref.skills } : {}),
      ...(ref.allowTools ? { allowTools: ref.allowTools } : {}),
      ...(ref.denyTools ? { denyTools: ref.denyTools } : {}),
    };
    // A native history fork resumes a full copy of the source session. The
    // source's observed totals describe the source, never the copy, and the
    // copy's own ledger is seeded at start like any other resume.
    const resume = ref.forkHistory
      ? await forkClaudeSession(this.#configDir, ref.providerRef)
      : ref.providerRef;
    const s = new ClaudeSession(opts);
    if (ref.forkHistory) s.adoptProviderRef(resume);
    s.start(opts, {
      resume,
      ...(ref.usageBaseline && !ref.forkHistory ? { usageBaseline: ref.usageBaseline } : {}),
      ...this.#extra(cli, ref.base),
    });
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
    try {
      return await this.#discoverModels(cli);
    } catch (error) {
      if (!cli && error instanceof Error && error.message.includes("exists but failed to launch")) {
        throw new WorkerDiagnostic("claudeBundledCli");
      }
      throw new WorkerDiagnostic("claudeDiscovery");
    }
  }

  /**
   * The account's plan windows, read by a throwaway `query()` like
   * {@link listModels}: the handshake, one `get_usage` control request, close.
   * No turn runs and nothing is persisted. Empty for an API-key account or a
   * CLI without the (experimental) request.
   */
  async readPlanUsage(): Promise<PlanWindow[]> {
    return await this.#probe(this.#resolveCli(), "readPlanUsage", async (q) => {
      await q.initializationResult();
      const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof fn !== "function") return [];
      const resp = (await fn.call(q)) as SdkGetUsageResponse;
      return planWindows(resp, Date.now());
    });
  }

  /** Run `read` against a metadata-only `query()` whose prompt never yields,
   *  bounded by {@link LIST_MODELS_TIMEOUT_MS}; the query is always closed.
   *
   *  The prompt stream stays open until the probe is done. The SDK ends the
   *  CLI's stdin as soon as the prompt stream ends, so a stream that ends at
   *  once closes stdin right after `initialize`, and a later control request
   *  (`get_usage`) would be written to a closed pipe. */
  async #probe<T>(cli: string | undefined, label: string, read: (q: Query) => Promise<T>) {
    const env = queryEnv({ configDir: this.#configDir });
    const { promise: done, resolve: finish } = Promise.withResolvers<void>();
    const q = sdk.query({
      prompt: {
        [Symbol.asyncIterator]: (): AsyncIterator<SDKUserMessage> => ({
          next: async () => {
            await done;
            return { done: true, value: undefined };
          },
        }),
      },
      options: {
        cwd: Deno.cwd(),
        settingSources: [],
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        // A metadata probe: no transcript, and none of the user's hooks.
        persistSession: false,
        settings: { disableAllHooks: true },
        ...(cli ? { pathToClaudeCodeExecutable: cli } : {}),
        env,
        stderr: (data) => log.debug(`${label} cli stderr`, { data: data.slice(0, 500) }),
      },
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        read(q),
        new Promise<never>((_, rej) => {
          timer = setTimeout(
            () => rej(new Error("timed out waiting for the Claude CLI")),
            LIST_MODELS_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // Close the query (killing the CLI) before the prompt ends, so the CLI
      // never sees an EOF it could take for a finished conversation.
      await Promise.resolve(q.close?.()).catch(() => {});
      finish();
    }
  }

  async #discoverModels(cli: string | undefined): Promise<DiscoveredModel[]> {
    return await this.#probe(cli, "listModels", async (q) => {
      const init = await q.initializationResult();
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
          ...(m.description ? { description: m.description } : {}),
          ...(ctx ? { context: ctx } : {}),
          ...(m.supportsEffort ? { supportsEffort: true } : {}),
          ...(m.supportedEffortLevels && m.supportedEffortLevels.length > 0
            ? { effortLevels: m.supportedEffortLevels }
            : {}),
        });
      }
      return out;
    });
  }
}
