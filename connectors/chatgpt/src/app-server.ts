/**
 * Thin JSONL client for `codex app-server`.
 *
 * The app server deliberately owns the Code Mode host; Loom owns the process,
 * its per-session MCP configuration, and the human approval surface. The wire
 * protocol itself (deadlines, diagnostics, cleanup) lives in `./rpc.ts`.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AsyncChannel } from "@loom/core/channel";
import type { HarnessEvent, TokenUsage } from "@loom/core/events";
import type { SearchConfig } from "@loom/core/connector";
import { stateIdle, stateRunning } from "@loom/core/session-state";
import { ASK_USER_DESC, COMMIT_DESC, STATUS_DESC } from "@loom/runtime/loom-tools";
import { PendingInteractions } from "@loom/runtime/pending";
import {
  AGENT_TOOL_NAMES,
  AGENT_TOOLS,
  AgentCalls,
  agentToolJsonSchema,
} from "@loom/runtime/agent-tools";
import type {
  AdapterSnapshot,
  AgentCallResult,
  AgentSession,
  CreateSessionOptions,
  EffortLevel,
  McpServerHandle,
  PermissionDecision,
  PlanDecision,
  SessionMode,
  SessionRef,
} from "@loom/core/types";
import type { SendOptions } from "@loom/core/message-queue";
import { CodexRpcClient } from "./rpc.ts";
import {
  CodexNativeModes,
  codexAgentMode,
  reviewerFor,
  type CodexAgentMode,
  type CodexExecutionMode,
} from "./agent-modes.ts";
import { verifyChatGptAccount } from "./account.ts";
import { rateLimitEvents } from "./rate-limits.ts";
import { turnErrorReason } from "./turn-error.ts";
import type { CodexHome } from "./codex-home.ts";
import { spawnCodex, type CodexLauncher } from "./launch.ts";
import {
  localToolDispatcher,
  type ToolDispatcher,
  type ToolDispatchResult,
} from "./tool-dispatch.ts";

const zeroUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const now = (): number => Date.now();
/** A Codex epoch-ms timestamp (`startedAtMs` / `completedAtMs`), if it is one. */
const epochMs = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;

/** Serialize Loom's MCP mounts as a TOML inline table for `codex -c`. */
export const mcpConfig = (servers: McpServerHandle[]): string => {
  const value = (v: string): string => JSON.stringify(v); // JSON strings are TOML basic strings.
  const table = (entries: Record<string, string>): string =>
    `{ ${Object.entries(entries)
      .map(([key, val]) => `${value(key)} = ${value(val)}`)
      .join(", ")} }`;
  const entries = new Map(
    servers.map((s) => {
      if (s.spec.transport === "runtime")
        throw new Error("Packaged MCP was not mounted by the daemon");
      if (s.spec.transport === "stdio") {
        const spec = s.spec as Extract<McpServerHandle["spec"], { transport: "stdio" }>;
        const fields = [
          `command = ${value(spec.command)}`,
          ...(s.required ? ["required = true"] : []),
          ...(spec.args?.length ? [`args = [${spec.args.map(value).join(", ")}]`] : []),
          ...(spec.env ? [`env = ${table(spec.env)}`] : []),
        ];
        return [s.name, `{ ${fields.join(", ")} }`] as const;
      }
      const spec = s.spec as Extract<McpServerHandle["spec"], { transport: "http" }>;
      const fields = [
        `url = ${value(spec.url)}`,
        ...(s.required ? ["required = true"] : []),
        ...(spec.headers ? [`http_headers = ${table(spec.headers)}`] : []),
      ];
      return [s.name, `{ ${fields.join(", ")} }`] as const;
    }),
  );
  return `{ ${[...entries.entries()].map(([name, config]) => `${value(name)} = ${config}`).join(", ")} }`;
};

/**
 * Codex feature switches that withdraw its native sub-agents. `multi_agent`
 * gates the v1 collaboration tools (`spawn_agent`, `send_input`, `wait`,
 * `close_agent`, …) and is on by default; `multi_agent_v2` the v2 team tools
 * (`followup_task`, `send_message`, `wait_agent`, …). A model whose catalogue
 * entry declares `multi_agent_version: v2` keeps the v2 tools whatever
 * `multi_agent_v2` says (upstream openai/codex#50880). The workaround reported
 * there, a cap of one thread per session (its own), refuses a spawn; the
 * tools stay listed, so the developer instructions also rule them out
 * (`subAgentInstructions`). The table form disables v2 as `=false` did. See
 * docs/loom-agents.md, Open.
 */
export const NATIVE_SUBAGENT_FLAGS = [
  "features.multi_agent=false",
  "features.multi_agent_v2={enabled=false, max_concurrent_threads_per_session=1}",
] as const;

/** Preserve the existing native environment, but omit upstream MCP credentials.
 *  Relay tokens arrive in the MCP mount configuration. Native host authority remains
 *  until the ChatGPT connector migration and VM isolation. */
const launchOptions = (
  servers: McpServerHandle[],
  _search: SearchConfig | undefined,
  builtinWebSearch: boolean,
  codexHome: CodexHome,
): { args: string[]; env: NodeJS.ProcessEnv } => ({
  args: [
    "app-server",
    "-c",
    // Pin file-based credential storage so this process reads the same
    // auth.json the REST catalog does, regardless of what a keyring/auto
    // `cli_auth_credentials_store` setting in the user's own config.toml
    // would otherwise select — the two credential paths must agree.
    'cli_auth_credentials_store="file"',
    "-c",
    `mcp_servers=${mcpConfig(servers)}`,
    // Codex's own multi-agent tools (`spawn_agent` and the collaboration tools
    // around it) are off for every thread this process serves — start, resume
    // and fork alike: a Loom session delegates through `loom-agents`. Both
    // generations are pinned, over whatever the user's config.toml enables.
    ...NATIVE_SUBAGENT_FLAGS.flatMap((flag) => ["-c", flag]),
    // Keep the activated project environment instead of rebuilding it from login profiles.
    ...(Deno.env.get("LOOM_PROJECT_ENVIRONMENT") === "1"
      ? [
          "-c",
          "allow_login_shell=false",
          "-c",
          "features.shell_snapshot=false",
          "-c",
          "shell_environment_policy.experimental_use_profile=false",
        ]
      : []),
    // MCP search defaults are independent of the native web-search setting.
    ...(builtinWebSearch ? [] : ["-c", 'web_search = "disabled"']),
  ],
  env: {
    ...Object.fromEntries(
      Object.entries(Deno.env.toObject()).filter(
        ([name]) => !servers.some((s) => s.credentialEnv === name),
      ),
    ),
    CODEX_HOME: codexHome.dir,
  },
});

/**
 * Loom's own tools (`commit`, `status`, `ask_user`), mounted as Codex dynamic
 * tools (`thread/start`'s `dynamicTools`) rather than a separate stdio MCP
 * server — Codex calls them directly via a server-initiated `item/tool/call`
 * request (`#toolCall` below). Only ever called from `start()` —
 * `thread/resume` has no `dynamicTools` field at all (see the comment on
 * `resume()` below), so there is nothing to (re)send on resume regardless of
 * which tools a given call site wants.
 *
 * No `exit_plan`: Plan is Codex's native collaboration mode, whose own
 * instructions end a planning turn with a `<proposed_plan>` block that Codex
 * reports as a `plan` item. Loom reviews that item (`#offerPlan`). Threads
 * created before this keep their registered `exit_plan`; the dispatcher
 * redirects such calls to the native flow.
 */
/**
 * The `loom-agents` tools, for a session that may start children. Like the
 * rest, registered only at `thread/start`: a thread started without them
 * never gains them on resume.
 */
const agentDynamicTools = (): Record<string, unknown>[] =>
  AGENT_TOOL_NAMES.map((name) => ({
    type: "function",
    name,
    description: AGENT_TOOLS[name].description,
    inputSchema: agentToolJsonSchema(name),
  }));

const loomDynamicTools = (): Record<string, unknown>[] => [
  {
    type: "function",
    name: "commit",
    description: COMMIT_DESC,
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Commit message. First line is the subject; keep it under ~72 chars.",
        },
        stage_all: {
          type: "boolean",
          description:
            "Stage all changes first (git add -A). Default true; set false to commit only what is already staged.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "status",
    description: STATUS_DESC,
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "boolean",
          description:
            "Include the working diff against HEAD (clamped; untracked files are not included).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "ask_user",
    description: ASK_USER_DESC,
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to put to the user. Be specific and self-contained.",
        },
        context: {
          type: "string",
          description:
            "Optional background: what you were doing, why you're blocked, the options you see.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
];

/** A native plan Loom is holding the planning turn open on, for review. */
interface PlanReview {
  id: string;
  text: string;
}

export class CodexAppServerSession implements AgentSession {
  readonly id: string;
  readonly #networkAccess: boolean;
  readonly #rpc: CodexRpcClient;
  #events = new AsyncChannel<HarnessEvent>();
  readonly #pending = new PendingInteractions<PermissionDecision, PlanDecision>();
  readonly #agentCalls = new AgentCalls();
  // Dispatch owns both execution and transcript state for locally handled tools.
  // Provider item notifications are only mirrors, never a second completion source.
  readonly #dynamicCalls = new Map<
    string,
    { phase: "running" } | { phase: "settled"; result: ToolDispatchResult }
  >();
  /** Sub-agent thread ids observed via `subAgentActivity` items — together
   *  with `#threadId`, the set of threads this session recognizes requests
   *  from (see `#serverRequest`'s guard). This only fixes *routing* once a
   *  sub-agent's request arrives on this connection; whether Codex's
   *  transport actually delivers one without an explicit subscribe call
   *  (its `subscribed_connection_ids` gate, per the Rust source, is never
   *  populated by anything this session does) is a separate, unverified
   *  protocol question this phase does not attempt to answer. */
  #subagentThreadIds = new Set<string>();
  /** Turn ids this session has itself deliberately abandoned via
   *  `interrupt()` (not turns that merely completed naturally — see
   *  `#notification`'s `turn/completed` handler) — a request tagged with one
   *  of these arrives too late to act on (e.g. a dynamic tool call from a
   *  turn that was interrupted before Codex finished tearing it down
   *  server-side) and is rejected in `#serverRequest` rather than
   *  dispatched. A blocklist rather than an `=== this.#turnId` equality
   *  check deliberately, so a brand-new turn's very first request — which
   *  can legitimately arrive in the same buffered read as `turn/start`'s own
   *  response, before the `await` that assigns `this.#turnId` has actually
   *  run — is never mistaken for stale just because `this.#turnId` isn't set
   *  yet. */
  #staleTurnIds = new Set<string>();
  /**
   * Aborted whenever the current turn ends — `interrupt()`, `close()`, or a
   * natural `turn/completed` — and replaced with a fresh one the next time a
   * turn actually starts. The stale-turn blocklist above only stops a *new*
   * request from entering dispatch — it does nothing for a dispatch already
   * admitted and now running (possibly paused on its own async work, e.g. a
   * slow external call inside an injected `ToolDispatcher`) when the turn
   * ends. `#toolCall` captures this turn's `.signal` at admission time and
   * hands it to `#askUser`/`#requestApproval`, so either of
   * those — called at any point during that dispatch's execution, not just
   * at its start — refuses to park a new, never-to-be-answered interaction
   * once the turn is gone.
   *
   * Seeded here (not left `null` until `#startTurn` first runs) specifically
   * so a dynamic tool call for the *first* turn — which can legitimately
   * arrive before `#startTurn` itself has run, in the same startup race
   * `#serverRequest`'s threadId guard already accounts for — still captures
   * a real, live signal that the eventual `interrupt()`/`turn/completed`
   * will actually abort, rather than capturing `undefined` and never
   * observing the turn end at all. `#startTurn` only replaces it once it's
   * already been spent (aborted) by a previous turn — never while it's
   * still the live signal for the turn currently being started.
   */
  #turnAbort = new AbortController();
  /**
   * Bumped only by an *external* `interrupt()`/`close()` call. A multi-step
   * transition that spans several `await`s (`respondToPlan`'s mode-change-
   * then-send sequence) snapshots this before starting and rechecks it after
   * each await; if it has changed, something *outside* that transition
   * decided to stop the session while it was in flight, and the transition
   * must not go on to start implementing a plan on the strength of work that
   * started before that decision.
   */
  #interruptGeneration = 0;
  #threadId: string | null = null;
  #turnId: string | null = null;
  /**
   * Queued messages steered into a live turn, by their `clientUserMessageId`,
   * that Codex has not yet been seen taking up. Its `userMessage` item echoes
   * the id as `clientId`; a turn that completes has taken the rest.
   */
  readonly #steered = new Set<string>();
  /** Commands and MCP calls reported running at `item/started`: their
   *  `item/completed` adds only the result. */
  readonly #runningTools = new Set<string>();
  /** When Codex says an item of the current turn started (`item/started`'s
   *  `startedAtMs`), for a call reported only at its completion. */
  readonly #itemStartedAt = new Map<string, number>();
  #model: string;
  #effort: EffortLevel | null;
  /** Effective native settings, as Codex last reported them. */
  readonly #modes = new CodexNativeModes();
  /** Loom's saved or last selected mode. Reported only while Codex has never
   *  named one (a server without collaboration modes, or a resume whose mode
   *  could not be confirmed); any report from Codex supersedes it. */
  #requestedMode: CodexAgentMode;
  /** The mode the running turn started under. Settings changes apply to
   *  subsequent turns, so until it ends a newer selection is pending. */
  #turnMode: CodexAgentMode | null = null;
  /** Serializes mode changes, so each one waits for its own observation. */
  #modeChange: Promise<void> = Promise.resolve();
  /** The current turn's native proposed plan, if it produced one. */
  #proposedPlan: PlanReview | null = null;
  /** A completed planning turn held open on the user's review. */
  #planReview: PlanReview | null = null;
  #cwd: string;
  #base: string | undefined;
  readonly #dispatch: ToolDispatcher;
  #closing = false;
  #status = stateRunning;
  #usage = zeroUsage();
  #usageBaseline: ReturnType<typeof zeroUsage> | null = zeroUsage();
  #startedUsageTurn = false;
  #startingUsageTurn = false;
  #pendingUsage: Record<string, unknown>[] = [];
  #deferredTurnCompletions: Record<string, unknown>[] = [];
  #contextUsed = 0;
  #contextLimit = 0;
  #turns = 0;

  readonly #oneShot: boolean;

  private constructor(
    opts: CreateSessionOptions,
    proc: ChildProcessWithoutNullStreams,
    base: string | undefined,
    dispatch: ToolDispatcher,
    networkAccess: boolean,
  ) {
    this.#oneShot = opts.oneShot === true;
    this.id = opts.sessionId;
    this.#networkAccess = networkAccess;
    this.#model = opts.model ?? "";
    this.#effort = opts.effort ?? null;
    this.#requestedMode = codexAgentMode(opts.mode);
    this.#cwd = opts.cwd;
    this.#base = base;
    this.#dispatch = dispatch;
    this.#rpc = new CodexRpcClient(proc);
    this.#rpc.onServerRequest((method, params, id) => this.#serverRequest(method, params, id));
    this.#rpc.onNotification((method, params) => this.#notification(method, params));
    this.#rpc.onClose((err) => {
      this.#turnAbort.abort();
      this.#modes.close(
        new Error("the provider connection closed before Codex reported the agent mode"),
      );
      this.#pending.failAll(
        { behavior: "deny", message: "the provider connection closed" },
        "(the provider connection closed before this was answered)",
        { action: "discuss", message: "the provider connection closed" },
      );
      this.#agentCalls.failAll("(the provider connection closed before this was answered)");
      if (!this.#closing)
        this.#events.push({
          type: "error",
          sessionId: this.id,
          ts: now(),
          message: err.message,
          fatal: true,
        });
      this.#events.close();
    });
  }

  static async start(
    opts: CreateSessionOptions,
    codexHome: CodexHome,
    cliPath = "codex",
    search?: SearchConfig,
    builtinWebSearch = false,
    base?: string,
    launch: CodexLauncher = spawnCodex,
    dispatch: ToolDispatcher = localToolDispatcher,
    networkAccess = false,
  ): Promise<CodexAppServerSession> {
    // Replacing the complete table prevents ~/.codex/config.toml MCP entries
    // from leaking into a Loom-controlled session.
    const built = launchOptions(
      opts.oneShot ? [] : opts.mcpServers,
      search,
      opts.oneShot ? false : builtinWebSearch,
      codexHome,
    );
    const proc = launch({ cliPath, args: built.args, cwd: opts.cwd, env: built.env, codexHome });
    const s = new CodexAppServerSession(opts, proc, base, dispatch, networkAccess);
    try {
      await s.#initialize();
      // A fresh Plan session has no earlier reviewer to keep; it exits to Manual.
      const target = s.#requestedMode;
      const started = await s.#rpc.requestStartup("thread/start", {
        ...(opts.model ? { model: opts.model } : {}),
        cwd: opts.cwd,
        approvalPolicy: opts.oneShot ? "never" : "on-request",
        ...(opts.oneShot
          ? {}
          : { approvalsReviewer: reviewerFor(target === "plan" ? "default" : target) }),
        sandbox: opts.oneShot ? "read-only" : "workspace-write",
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.oneShot
          ? {
              ephemeral: true,
              baseInstructions: opts.systemPromptAppend ?? "",
              developerInstructions: "",
              config: {
                "sandbox_workspace_write.network_access": false,
                project_doc_max_bytes: 0,
                features: {
                  shell_tool: false,
                  multi_agent: false,
                  plugins: false,
                  apps: false,
                  hooks: false,
                },
              },
            }
          : {
              config: { "sandbox_workspace_write.network_access": networkAccess },
              ...(opts.systemPromptAppend
                ? { developerInstructions: opts.systemPromptAppend }
                : {}),
              ...(opts.loomServer
                ? {
                    dynamicTools: [
                      ...loomDynamicTools(),
                      ...(opts.agentTools ? agentDynamicTools() : []),
                    ],
                  }
                : {}),
            }),
      });
      s.#threadId = (started as any)?.thread?.id ?? null;
      if (!s.#threadId) throw new Error("codex app-server did not return a thread id");
      if (!opts.oneShot) await s.#establishMode(started, true);
      if (opts.prompt) await s.#startTurn(opts.prompt);
      else s.#idle();
      return s;
    } catch (err) {
      // Startup failed after the process was already spawned — close it (which
      // kills the process) rather than leaving an orphaned `codex app-server`
      // with a pending request no caller can ever reach.
      s.close();
      throw err;
    }
  }

  static async resume(
    ref: SessionRef,
    codexHome: CodexHome,
    cliPath = "codex",
    search?: SearchConfig,
    builtinWebSearch = false,
    base?: string,
    launch: CodexLauncher = spawnCodex,
    dispatch: ToolDispatcher = localToolDispatcher,
    networkAccess = false,
  ): Promise<CodexAppServerSession> {
    if (!ref.providerRef) throw new Error("Codex session has no app-server thread id to resume");
    const opts: CreateSessionOptions = {
      sessionId: ref.sessionId,
      cwd: ref.cwd,
      prompt: "",
      mode: ref.mode ?? "default",
      mcpServers: ref.mcpServers ?? [],
      loomServer: true,
      ...(ref.model ? { model: ref.model } : {}),
      ...(ref.effort ? { effort: ref.effort } : {}),
    };
    const built = launchOptions(opts.mcpServers, search, builtinWebSearch, codexHome);
    const proc = launch({ cliPath, args: built.args, cwd: opts.cwd, env: built.env, codexHome });
    const s = new CodexAppServerSession(opts, proc, base, dispatch, networkAccess);
    try {
      await s.#initialize();
      // A forked thread replays its copied cumulative usage like a resumed
      // one, so both seed the baseline from that replay rather than charge it.
      s.#usageBaseline = null;
      s.#threadId = ref.providerRef;
      // `thread/fork` copies the source thread's rollout into a new thread
      // (Codex's own native fork) and loads it like `thread/resume` does; the
      // source thread is left as it was.
      const resumed = await s.#rpc.requestStartup(
        ref.forkHistory ? "thread/fork" : "thread/resume",
        {
          threadId: ref.providerRef,
          cwd: ref.cwd,
          // No reviewer: Codex restores the saved one, which is also the
          // execution choice a saved Plan session exits to.
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
          config: { "sandbox_workspace_write.network_access": networkAccess },
          excludeTurns: true,
          ...(ref.systemPromptAppend ? { developerInstructions: ref.systemPromptAppend } : {}),
          // No `dynamicTools` here: the generated `ThreadResumeParams` binding
          // (Codex 0.153.2) has no such field — `thread/resume` cannot register
          // or refresh a thread's dynamic tools at all. Codex restores whatever
          // was registered at `thread/start` from the thread's own rollout
          // history. A schema/description change to `commit`/`status` (see
          // `loomDynamicTools`) therefore only reaches *new* threads; an
          // already-persisted thread keeps serving its original registration
          // until a fresh thread starts (Phase 6's summarize-and-restart).
          //
          // This also means a thread created before `ask_user`/`exit_plan`
          // existed (pre-Phase-5) genuinely does not have them registered —
          // Codex has no way to gain a tool it was never given at `thread/
          // start`. `index.ts`'s `codeModeInstructions` is deliberately
          // conservative about this on resume: it never tells the model
          // `ask_user` is available here, even for a thread that actually does
          // have it, because Loom has no persisted way to tell the two cases
          // apart. Under-claiming a tool that exists is safe; over-claiming
          // one that doesn't (and watching the model's call error) is not.
        },
      );
      const threadId = (resumed as any)?.thread?.id;
      // A fork that names no new thread must not carry on as the source.
      if (ref.forkHistory && (typeof threadId !== "string" || threadId === ref.providerRef))
        throw new Error("codex app-server did not return a new thread id for the fork");
      s.#threadId = threadId ?? ref.providerRef;
      await s.#establishMode(resumed, false);
      s.#idle();
      return s;
    } catch (err) {
      s.close();
      throw err;
    }
  }

  async #initialize(): Promise<void> {
    await this.#rpc.requestStartup("initialize", {
      clientInfo: { name: "loom", title: "Loom", version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    this.#rpc.notify("initialized", {});
    await verifyChatGptAccount(this.#rpc);
    // Limits are optional telemetry: unavailable usage must not prevent a session.
    try {
      const limits = await this.#rpc.request("account/rateLimits/read", {}, { timeoutMs: 3000 });
      for (const event of rateLimitEvents(limits, this.id, now(), "read")) this.#events.push(event);
    } catch {
      // Older servers and temporarily unavailable usage endpoints still support chat.
    }
  }

  /**
   * Learn the thread's effective native settings and bring them to Loom's
   * requested mode — the creation request, or on resume the saved session
   * mode (mapped by `codexAgentMode`: a saved `acceptEdits` becomes Manual).
   * Loom's saved mode wins over what Codex restored because it is the user's
   * last confirmed choice: a Plan selected after the thread's last turn, or a
   * thread from before native modes (whose "plan" was only a read-only
   * sandbox), resumes in native Plan with the restored reviewer as its exit.
   *
   * A resume reply may omit the collaboration mode; applying the saved mode
   * then doubles as the settings refresh. None of this is fatal: Codex
   * without collaboration modes, or a change it rejects or never confirms,
   * leaves the session on whatever Codex last reported, with a diagnostic.
   */
  async #establishMode(reply: unknown, fresh: boolean): Promise<void> {
    this.#modes.initialize(reply, fresh);
    const problem = await this.#modes.discover((method, params) =>
      this.#rpc.request(method, params, { timeoutMs: 5000 }),
    );
    if (problem) this.#diagnose(problem);
    const target = this.#requestedMode;
    if (this.#modes.mode === target) return;
    try {
      await this.#selectMode(target);
    } catch (err) {
      if (this.#rpc.closed) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      this.#diagnose(
        this.#modes.mode
          ? `Codex did not switch this session to ${modeName(target)} (${reason}); it remains in ${modeName(this.#modes.mode)}.`
          : `Codex did not report this session's agent mode (${reason}); Loom shows the saved ${modeName(target)} mode until Codex confirms a change.`,
      );
    }
  }

  #diagnose(message: string): void {
    this.#events.push({ type: "error", sessionId: this.id, ts: now(), message, fatal: false });
  }

  get providerRef(): string | null {
    return this.#threadId;
  }
  events(): AsyncIterable<HarnessEvent> {
    return this.#events;
  }

  /**
   * Mid-turn input is steered into the live turn (`expectedTurnId` makes a
   * steer that lost the race with the turn's end fail, so the caller can start
   * the next turn with it instead); otherwise it starts a turn. A queued
   * message's `inputId` rides as `clientUserMessageId`.
   */
  async send(input: string, opts: SendOptions = {}): Promise<void> {
    if (!this.#threadId) throw new Error("Codex thread has not started");
    const id = opts.inputId;
    if (this.#turnId) {
      // Watched for before the request: its `userMessage` item can be read
      // ahead of the reply's continuation.
      if (id !== undefined) this.#steered.add(id);
      try {
        await this.#rpc.request("turn/steer", {
          threadId: this.#threadId,
          expectedTurnId: this.#turnId,
          input: [textInput(input)],
          ...(id !== undefined ? { clientUserMessageId: id } : {}),
        });
      } catch (err) {
        if (id !== undefined) this.#steered.delete(id);
        throw err;
      }
      return;
    }
    await this.#startTurn(input, id);
    // The turn runs on it: taken up now.
    if (id !== undefined) this.#consumed(id, false);
  }

  #consumed(inputId: string, midTurn: boolean): void {
    this.#events.push({ type: "input_consumed", sessionId: this.id, ts: now(), inputId, midTurn });
  }

  /** A `userMessage` item: Codex put steered input into the conversation. */
  #userMessageItem(item: Record<string, unknown>): void {
    const id = item["clientId"];
    if (typeof id === "string" && this.#steered.delete(id)) this.#consumed(id, true);
  }

  async compact(instructions?: string): Promise<void> {
    if (!this.#threadId) throw new Error("Codex thread has not started");
    // `thread/compact/start` accepts no instruction payload — reject rather
    // than silently run plain compaction and drop what the caller asked for
    // (capabilities.compactionInstructions is false; the daemon should already
    // have rejected this, this is the adapter's own defensive check).
    if (instructions?.trim()) {
      throw new Error("Codex Code Mode compaction does not support custom instructions");
    }
    this.#startedUsageTurn = true;
    await this.#rpc.request("thread/compact/start", { threadId: this.#threadId });
  }

  /** Fire-and-forget: the `.then()` attached where the request first arrived
   *  (see `#serverRequest`) does the actual RPC response, since only there
   *  is the request's own kind/shape (and, for a native question, its
   *  original per-question ids) in scope. */
  async respondToPermission(id: string, decision: PermissionDecision): Promise<void> {
    this.#pending.resolvePermission(id, decision);
  }
  /** loom `ask_user` handler: emit a `question` event, block until answered.
   *  `id` is the dynamic tool call's own `callId` (see `#toolCall`) — not a
   *  freshly minted one — so a persisted-event-log replay can correlate this
   *  question with the same call's `tool_call`/`tool_result` pair rather
   *  than two unrelated ids that happen to describe the same interaction.
   *  `signal` is the *admitting* turn's abort signal (also captured at
   *  `#toolCall` time) — if the turn has already been interrupted by the
   *  time a paused/async dispatcher gets around to calling this (the
   *  stale-turn blocklist in `#serverRequest` only protects *entry* into
   *  dispatch, not a dispatch already admitted and running), this must not
   *  park a new, never-to-be-answered question — it resolves immediately
   *  with the same sentinel `interrupt()`'s own drain would have produced. */
  #askUser(
    question: string,
    context: string | undefined,
    id: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (signal?.aborted) return Promise.resolve("(the turn was interrupted)");
    const answer = this.#pending.requestQuestion(id);
    this.#events.push({
      type: "question",
      sessionId: this.id,
      ts: now(),
      id,
      question,
      ...(context ? { context } : {}),
    });
    return answer;
  }
  async answerQuestion(id: string, text: string): Promise<void> {
    if (!this.#pending.resolveQuestion(id, text)) return;
    this.#events.push({ type: "answer", sessionId: this.id, ts: now(), id, text });
  }
  /** `loom-agents` handler: hand the call to the daemon, block until answered.
   *  `signal`: see `#askUser`'s doc comment. */
  #agentCall(
    tool: string,
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<AgentCallResult> {
    if (signal?.aborted || this.#closing)
      return Promise.resolve({ ok: false, text: "(the turn was interrupted)" });
    return this.#agentCalls.call((id) =>
      this.#events.push({ type: "agent_call", sessionId: this.id, ts: now(), id, tool, input }),
    );
  }
  async respondToAgentCall(id: string, result: AgentCallResult): Promise<void> {
    this.#agentCalls.resolve(id, result);
  }
  async setBase(base: string): Promise<void> {
    // Read per dynamic tool call.
    this.#base = base;
  }
  /** Re-read the account's plan windows; they arrive as `rate_limit` events.
   *  Not awaited: a slow usage endpoint must not hold the request. */
  async refreshPlanUsage(): Promise<void> {
    void this.#rpc
      .request("account/rateLimits/read", {}, { timeoutMs: 10_000 })
      .then((limits) => {
        for (const event of rateLimitEvents(limits, this.id, now(), "read"))
          this.#events.push(event);
      })
      .catch(() => {
        // Optional telemetry, as at start-up.
      });
  }
  /** loom `commit` handler for the case `@loom/runtime/policy`'s `policy()`
   *  says "ask" rather than "allow": raise a real `permission_request` and
   *  block on a human decision, the same as a native command/file approval,
   *  instead of denying outright. `id`/`signal`: see `#askUser`'s doc comment. */
  #requestApproval(
    tool: string,
    args: Record<string, unknown>,
    id: string,
    signal: AbortSignal | undefined,
  ): Promise<PermissionDecision> {
    if (signal?.aborted)
      return Promise.resolve({ behavior: "deny", message: "the turn was interrupted" });
    const decision = this.#pending.requestPermission(id);
    this.#events.push({
      type: "permission_request",
      sessionId: this.id,
      ts: now(),
      id,
      tool,
      input: args,
    });
    return decision;
  }
  /**
   * A planning turn ended with a native proposed plan while Plan is still
   * selected. Hold the turn open on a `plan_review` — its `result` is deferred
   * to `respondToPlan` — offering the reviewer Plan kept (the execution
   * choice) as the implementation mode.
   */
  #offerPlan(plan: PlanReview): void {
    this.#planReview = plan;
    this.#events.push({
      type: "plan_review",
      sessionId: this.id,
      ts: now(),
      id: plan.id,
      plan: plan.text,
      implementMode: this.#modes.executionMode ?? "default",
    });
  }
  /** End a planning turn held for review: the result it deferred, then idle. */
  #settlePlanTurn(): void {
    this.#events.push({ type: "result", sessionId: this.id, ts: now(), kind: "ok" });
    this.#idle();
  }
  /**
   * Answer a held native plan review (`#offerPlan`). The planning turn has
   * already ended, and Plan is a collaboration mode rather than a read-only
   * sandbox, so implementing needs no interrupt — only what the user could do
   * by hand: change mode, then send a message.
   *
   * - `implement` / `revise` / `implement_fresh`: select the decision's mode
   *   (`acceptEdits` is Manual, see `codexAgentMode`), else the execution
   *   choice Plan kept; wait until Codex reports it effective; then send the
   *   implementation request. `revise` sends the user's edited plan text. A
   *   Codex thread cannot shed its context, so `implement_fresh` implements
   *   in place.
   * - `discuss`: stay in Plan and send the note as the next message.
   * - `handoff`: implementation moved to another session; end the turn.
   *
   * A failed transition settles the turn (Plan stays effective) and rethrows.
   * An external `interrupt()`/`close()` while it is in flight
   * (`#interruptGeneration`) stops it before any implementation request goes
   * out, and ends a turn whose start was already on the wire.
   */
  async respondToPlan(id: string, decision: PlanDecision): Promise<void> {
    if (this.#planReview?.id !== id) return;
    this.#planReview = null;
    if (
      decision.action === "handoff" ||
      (decision.action === "discuss" && !decision.message.trim())
    ) {
      this.#settlePlanTurn();
      return;
    }
    const generation = this.#interruptGeneration;
    const ensureNotSuperseded = async (): Promise<void> => {
      if (generation === this.#interruptGeneration) return;
      if (this.#turnId && !this.#closing) await this.#endTurn().catch(() => {});
      throw new Error("the session was interrupted before the plan could be implemented");
    };
    try {
      if (decision.action === "discuss") {
        await this.send(decision.message);
      } else {
        const chosen = decision.mode ? codexAgentMode(decision.mode) : "plan";
        const execution: CodexExecutionMode =
          chosen === "plan" ? (this.#modes.executionMode ?? "default") : chosen;
        await this.#selectMode(execution);
        await ensureNotSuperseded();
        const planText =
          decision.action === "revise" ? decision.plan : "the plan you just presented";
        await this.send(`The plan is approved. Implement it now:\n\n${planText}`);
      }
      await ensureNotSuperseded();
    } catch (err) {
      if (generation === this.#interruptGeneration && !this.#turnId) this.#settlePlanTurn();
      throw err;
    }
  }

  /**
   * The mechanical work of ending the current turn: `turn/interrupt` RPC,
   * `#turnId`/`#staleTurnIds`/`#turnAbort` bookkeeping, and draining every
   * parked interaction — always, even when the RPC itself throws (a
   * `try`/`finally`, not a bare `await`): a failed interrupt request must
   * not leave a permission/question promise (or the caller waiting on
   * this method) hanging forever just because the underlying RPC call
   * failed. `this.#turnId` is captured and cleared *before* that RPC call,
   * and the old id is recorded in `#staleTurnIds` *and* `#turnAbort` is
   * aborted before anything else — so any request tagged with the old turn
   * is rejected by `#serverRequest`'s guard before it can even reach a
   * dispatcher, and any dispatch already admitted and running sees its
   * captured `signal` flip to aborted the moment it next calls
   * `#askUser`/`#requestApproval`, rather than starting new
   * work under a turn Loom already considers over. A plan review held on
   * the turn ends with it.
   *
   * Deliberately **not** public, and does **not** touch
   * `#interruptGeneration` — shared by the public `interrupt()` (an
   * external, unrelated-to-any-transition stop) and `respondToPlan`'s cleanup
   * of an implementation turn that started after such a stop.
   */
  async #endTurn(): Promise<void> {
    const turnId = this.#turnId;
    this.#turnId = null;
    this.#turnMode = null;
    this.#proposedPlan = null;
    this.#planReview = null;
    if (turnId) this.#staleTurnIds.add(turnId);
    this.#turnAbort.abort();
    try {
      if (this.#threadId && turnId) {
        await this.#rpc.request("turn/interrupt", { threadId: this.#threadId, turnId });
      }
    } finally {
      this.#pending.failAll(
        { behavior: "deny", message: "the turn was interrupted" },
        "(the turn was interrupted)",
        { action: "discuss", message: "the turn was interrupted" },
      );
      this.#agentCalls.failAll("(the turn was interrupted)");
      this.#idle();
    }
  }
  /**
   * The public, externally-triggered stop (a user hitting stop, the daemon
   * tearing down a session). Bumps `#interruptGeneration` *before* doing
   * the actual work, so an in-flight `respondToPlan` transition that
   * snapshotted the generation earlier reliably observes the change as soon
   * as it next checks, regardless of how long `#endTurn`'s own RPC call
   * takes.
   */
  async interrupt(): Promise<void> {
    this.#interruptGeneration++;
    // Codex drops steered input with the turn and reports none of it: what
    // is still unconfirmed stays unknown to the daemon (uncertain).
    this.#steered.clear();
    this.#runningTools.clear();
    this.#itemStartedAt.clear();
    await this.#endTurn();
  }
  async rewind(): Promise<void> {
    throw new Error("Codex app-server rewind is not yet supported by Loom");
  }
  /**
   * Select an agent mode for subsequent turns without interrupting current
   * work. Resolves once Codex reports the mode effective; a rejected or
   * unconfirmed change throws and leaves the reported mode alone. A change
   * made during a turn is reported as pending until the next turn starts.
   */
  async setMode(mode: SessionMode): Promise<void> {
    if (!this.#threadId) throw new Error("Codex thread has not started");
    if (this.#oneShot) throw new Error("a one-shot Codex session has no agent mode");
    await this.#selectMode(codexAgentMode(mode));
  }
  /** One native settings change at a time, each settled by its own observation. */
  #selectMode(target: CodexAgentMode): Promise<void> {
    const change = this.#modeChange.then(async () => {
      const params = this.#modes.updateFor(target, this.#model || null, this.#effort);
      if (params) {
        const observed = this.#modes.until(target);
        try {
          await this.#rpc.request("thread/settings/update", {
            threadId: this.#threadId,
            ...params,
          });
        } catch (err) {
          observed.cancel();
          throw err;
        }
        await observed.wait();
      }
      this.#requestedMode = target;
    });
    this.#modeChange = change.catch(() => {});
    return change;
  }
  /** The thread's mode: what Codex reports, else the saved selection. */
  #currentMode(): CodexAgentMode {
    return this.#modes.mode ?? this.#requestedMode;
  }
  async setModel(model: string): Promise<void> {
    this.#model = model;
  }
  async setEffort(effort: EffortLevel): Promise<void> {
    this.#effort = effort;
  }
  snapshot(): AdapterSnapshot {
    const mode = this.#currentMode();
    return {
      status: this.#status,
      providerRef: this.#threadId,
      model: this.#model || null,
      effort: this.#effort,
      mode,
      ...(this.#turnMode !== null && this.#turnMode !== mode ? { pendingMode: mode } : {}),
      usage: this.#usage,
      contextUsed: this.#contextUsed,
      contextLimit: this.#contextLimit,
      costUsd: 0,
      turns: this.#turns,
    };
  }
  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#interruptGeneration++; // see the doc comment on the field
    this.#planReview = null;
    this.#turnAbort?.abort();
    this.#pending.failAll(
      { behavior: "deny", message: "the session was closed before this was answered" },
      "(the session was closed before this was answered)",
      { action: "discuss", message: "the session was closed before this was answered" },
    );
    this.#agentCalls.failAll("(the session was closed before this was answered)");
    this.#rpc.close();
    this.#events.close();
  }

  async #startTurn(input: string, clientUserMessageId?: string): Promise<void> {
    // A turn runs under the settings Codex holds when it starts, so it never
    // overtakes a mode change still waiting for its observation.
    await this.#modeChange;
    this.#startedUsageTurn = true;
    // Replace only an already-spent controller (aborted by a *previous*
    // turn's end) — never one that's still live, which is exactly the case
    // for this turn's own controller when a dynamic tool call for it
    // arrived early enough to have already captured it (see `#turnAbort`'s
    // doc comment). A dispatch admitted under a genuinely previous turn must
    // never observe this new turn's live signal as a reason to proceed —
    // which "only replace once spent" also guarantees, since that previous
    // turn's dispatch captured the now-aborted controller, not this one.
    if (this.#turnAbort.signal.aborted) this.#turnAbort = new AbortController();
    this.#startingUsageTurn = true;
    this.#turnMode = this.#currentMode();
    this.#proposedPlan = null;
    let result: unknown;
    try {
      result = await this.#rpc.request("turn/start", {
        threadId: this.#threadId,
        input: [textInput(input)],
        ...(clientUserMessageId !== undefined ? { clientUserMessageId } : {}),
        model: this.#model || undefined,
        effort: this.#effort ?? undefined,
        // Approvals and collaboration are thread settings (`setMode`). Only
        // the sandbox is restated, and it never depends on the agent mode.
        ...(this.#oneShot ? { approvalPolicy: "never" } : {}),
        sandboxPolicy: this.#sandboxPolicy(),
      });
    } catch (err) {
      this.#startingUsageTurn = false;
      if (!this.#turnId) this.#turnMode = null;
      this.#completeDeferredTurns();
      throw err;
    } finally {
      this.#startingUsageTurn = false;
    }
    this.#turnId = (result as any)?.turn?.id ?? this.#turnId;
    for (const update of this.#pendingUsage.splice(0))
      this.#notification("thread/tokenUsage/updated", update);
    this.#status = stateRunning;
    this.#events.push({
      type: "status_changed",
      sessionId: this.id,
      ts: now(),
      status: this.#status,
    });
    this.#completeDeferredTurns();
  }
  /** Ends, now that `#turnId` names it, a turn whose `turn/completed` was
   *  read while `turn/start` was still in flight (see `#notification`). */
  #completeDeferredTurns(): void {
    for (const completion of this.#deferredTurnCompletions.splice(0))
      this.#notification("turn/completed", completion);
  }
  #idle(): void {
    this.#status = stateIdle;
    this.#events.push({
      type: "status_changed",
      sessionId: this.id,
      ts: now(),
      status: this.#status,
    });
  }
  /** Fixed by the isolation configuration, never by the agent mode. */
  #sandboxPolicy(): Record<string, unknown> {
    if (this.#oneShot) return { type: "readOnly", networkAccess: false };
    return {
      type: "workspaceWrite",
      writableRoots: [this.#cwd],
      networkAccess: this.#networkAccess,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  /**
   * A request tagged with a `threadId` this session doesn't recognize (not
   * its own root thread, not a sub-agent thread it has observed via
   * `subAgentActivity`) is rejected outright rather than actioned — "route
   * through the same handler, reject unknown requests" applies to every
   * request kind below, not just approvals. Requests with no `threadId` at
   * all (the legacy `execCommandApproval`/`applyPatchApproval` methods)
   * aren't checked; there's nothing to check them against.
   *
   * Skipped entirely while `this.#threadId` is still `null`: `thread/start`'s
   * *response* (which assigns it) and a request the new thread fires
   * immediately (e.g. an `item/tool/call` for a dynamic tool called on the
   * very first turn) can arrive in the same buffered read and get processed
   * synchronously in that order by `readline`'s `line` events — but the
   * `await` that assigns `this.#threadId` from the response is a queued
   * microtask, so it hasn't actually run yet by the time the immediately-
   * following request is dispatched here. Nothing else could plausibly be
   * sending a request this early, so trusting it during that narrow startup
   * window is safe.
   */
  #serverRequest(method: string, p: Record<string, unknown>, id: number | string): void {
    const threadId = typeof p["threadId"] === "string" ? p["threadId"] : undefined;
    if (
      threadId &&
      this.#threadId !== null &&
      threadId !== this.#threadId &&
      !this.#subagentThreadIds.has(threadId)
    ) {
      this.#rpc.respondError(id, `request for unrecognized thread: ${threadId}`);
      return;
    }
    // A request for a turn `interrupt()` already ended — see `#staleTurnIds`'
    // doc comment for why this is a blocklist, not an `=== this.#turnId`
    // equality check.
    const turnId = typeof p["turnId"] === "string" ? p["turnId"] : undefined;
    if (turnId && this.#staleTurnIds.has(turnId)) {
      this.#rpc.respondError(id, `request for a turn that is no longer active: ${turnId}`);
      return;
    }
    if (method === "item/tool/call") {
      this.#toolCall(p, id);
      return;
    }
    if (method === "item/tool/requestUserInput") {
      this.#requestUserInput(p, id);
      return;
    }
    const pid = String(p["approvalId"] ?? p["itemId"] ?? p["callId"] ?? id);
    if (method === "item/commandExecution/requestApproval") {
      this.#pending.requestPermission(pid).then((d) => this.#respondApproval(id, "command", d));
      this.#events.push({
        type: "permission_request",
        sessionId: this.id,
        ts: now(),
        id: pid,
        tool: "Bash",
        input: { command: p["command"], cwd: p["cwd"], reason: p["reason"] },
      });
    } else if (method === "item/fileChange/requestApproval") {
      this.#pending.requestPermission(pid).then((d) => this.#respondApproval(id, "file", d));
      this.#events.push({
        type: "permission_request",
        sessionId: this.id,
        ts: now(),
        id: pid,
        tool: "apply_patch",
        input: { reason: p["reason"] },
      });
    } else if (method === "execCommandApproval" || method === "applyPatchApproval") {
      this.#pending.requestPermission(pid).then((d) => this.#respondApproval(id, "legacy", d));
      this.#events.push({
        type: "permission_request",
        sessionId: this.id,
        ts: now(),
        id: pid,
        tool: method === "execCommandApproval" ? "Bash" : "apply_patch",
        input: p,
      });
    } else {
      this.#rpc.respondError(id, `unsupported request: ${method}`);
    }
  }
  /** Translates a resolved `PermissionDecision` into the wire shape each
   *  approval kind expects — the counterpart of the `.then()`s attached in
   *  `#serverRequest`, moved out of `respondToPermission` itself so both a
   *  live answer and the interrupt/close drain's synthesized deny go through
   *  the exact same translation. */
  #respondApproval(
    rpcId: number | string,
    kind: "command" | "file" | "legacy",
    decision: PermissionDecision,
  ): void {
    const allow = decision.behavior === "allow";
    const result =
      kind === "command" || kind === "file"
        ? { decision: allow ? "accept" : "decline" }
        : { decision: allow ? "approved" : "denied" };
    this.#rpc.respond(rpcId, result);
  }
  /** `item/tool/requestUserInput` — Codex's own native `request_user_input`
   *  tool, distinct from Loom's `ask_user` dynamic tool. Surfaced as the same
   *  `permission_request`/`AskUserQuestion` shape the TUI already renders for
   *  Claude's native multi-choice question tool (`frontend/tui/src/
   *  model.ts#parseAskUserQuestions`) — no wire/TUI change needed, only this
   *  translation. Answered via `respondToPermission`'s `updatedInput.answers`
   *  (keyed by question *text*, the existing TUI convention — see
   *  `frontend/tui/src/fleet-handle.ts`), zipped back onto each question's
   *  own `id` for Codex's response. */
  #requestUserInput(p: Record<string, unknown>, id: number | string): void {
    const questions = (
      (p["questions"] as
        | Array<{
            id: string;
            header: string;
            question: string;
            options: Array<{ label: string; description: string }> | null;
          }>
        | undefined) ?? []
    ).filter((q) => typeof q?.id === "string" && typeof q.question === "string");
    const pid = String(p["itemId"] ?? id);
    this.#pending.requestPermission(pid).then((d) => this.#respondUserInput(id, questions, d));
    this.#events.push({
      type: "permission_request",
      sessionId: this.id,
      ts: now(),
      id: pid,
      tool: "AskUserQuestion",
      input: {
        questions: questions.map((q) => ({
          question: q.question,
          header: q.header ?? "",
          options: q.options ?? [],
        })),
      },
    });
  }
  #respondUserInput(
    rpcId: number | string,
    questions: Array<{ id: string; question: string }>,
    decision: PermissionDecision,
  ): void {
    const updated =
      decision.behavior === "allow" && decision.updatedInput ? decision.updatedInput : undefined;
    const chosen =
      updated && typeof updated["answers"] === "object" && updated["answers"] !== null
        ? (updated["answers"] as Record<string, string>)
        : {};
    // A deny (including the interrupt/close drain's synthesized one) still
    // needs a structurally valid response — `ToolRequestUserInputAnswer` has
    // no "declined" concept, so every question gets an empty-string answer
    // rather than leaving the RPC unanswered.
    const answers = Object.fromEntries(
      questions.map((q) => [q.id, { answers: [chosen[q.question] ?? ""] }]),
    );
    this.#rpc.respond(rpcId, { answers });
  }
  /** `item/tool/call` — Codex invoking one of Loom's own dynamic tools
   *  (`commit`/`status`/`ask_user`, see `loomDynamicTools`; older threads
   *  may still call `exit_plan`).
   *  Reply on the envelope `id`, not `params.callId` — they're different
   *  fields in the protocol. The actual gating/execution lives in
   *  `#dispatch` (see `tool-dispatch.ts`) — this is just the RPC adapter:
   *  build the call context, await the dispatcher, and turn its result (or a
   *  thrown error) into a response. */
  #toolCall(p: Record<string, unknown>, id: number | string): void {
    const tool = String(p["tool"] ?? "");
    const args = (p["arguments"] as Record<string, unknown> | null) ?? {};
    // Codex's own `callId` for this specific call, confirmed (via the
    // generated bindings and `codex-rs`'s own test suite, which asserts
    // `ThreadItem::DynamicToolCall.id == call_id`) to be the exact id the
    // eventual `dynamicToolCall` item — and therefore this call's own
    // `tool_call`/`tool_result` events (`#item()`) — will carry. Reused as
    // the id for any pending interaction this call raises (`ask_user`, a
    // `commit` approval wait) instead of minting a fresh one, so a
    // persisted-event-log replay can correlate "this question/approval was
    // resolved" from the id alone, the same way it already can
    // for `ask_user`'s own `question`/`answer` pair.
    const callId = typeof p["callId"] === "string" && p["callId"] ? p["callId"] : randomUUID();
    // Captured now, at admission — the *this* turn's signal, not whatever
    // turn happens to be live by the time this dispatch actually reaches
    // `ctx.askUser`/etc. (see `#turnAbort`'s doc comment).
    const signal = this.#turnAbort?.signal;
    if (this.#dynamicCalls.has(callId)) {
      this.#rpc.respondError(id, `duplicate dynamic tool call: ${callId}`);
      return;
    }
    this.#dynamicCalls.set(callId, { phase: "running" });
    this.#events.push({
      type: "tool_call",
      sessionId: this.id,
      ts: now(),
      id: callId,
      name: tool,
      input: args,
    });
    const respond = (text: string, success: boolean): void => {
      const call = this.#dynamicCalls.get(callId);
      if (call?.phase !== "running") return;
      const result = { text, ok: success };
      this.#dynamicCalls.set(callId, { phase: "settled", result });
      this.#events.push({
        type: "tool_result",
        sessionId: this.id,
        ts: now(),
        id: callId,
        ok: result.ok,
        output: result.text,
      });
      this.#rpc.respond(id, { contentItems: [{ type: "inputText", text }], success });
    };
    this.#dispatch(tool, args, {
      // Loom's own tool policy follows the Loom mode this turn runs under —
      // independent of Codex's reviewer, which never sees these calls.
      mode: this.#turnMode ?? this.#currentMode(),
      cwd: this.#cwd,
      ...(this.#base ? { base: this.#base } : {}),
      ...(signal ? { signal } : {}),
      askUser: (q, c) => this.#askUser(q, c, callId, signal),
      requestApproval: (t, a) => this.#requestApproval(t, a, callId, signal),
      agentCall: (t, a) => this.#agentCall(t, a, signal),
    }).then(
      (res) => respond(res.text, res.ok),
      (err: unknown) => respond(err instanceof Error ? err.message : String(err), false),
    );
  }
  #notification(method: string, p: Record<string, unknown>): void {
    if (method === "account/rateLimits/updated") {
      for (const event of rateLimitEvents(p, this.id, now(), "update")) this.#events.push(event);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      if (this.#startingUsageTurn) {
        this.#pendingUsage.push(p);
        return;
      }
      if (p["threadId"] !== this.#threadId) return;
      const usage = p["tokenUsage"] as Record<string, unknown> | undefined;
      const limit = usage?.["modelContextWindow"];
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 0)
        this.#contextLimit = limit;
      const total = usage?.["total"] as Record<string, unknown> | undefined;
      if (!total) return;
      const num = (v: unknown): number =>
        typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
      const normalize = (u: Record<string, unknown>) => ({
        input: Math.max(
          0,
          num(u["inputTokens"]) - num(u["cachedInputTokens"]) - num(u["cacheWriteInputTokens"]),
        ),
        output: num(u["outputTokens"]), // already includes reasoning
        cacheRead: num(u["cachedInputTokens"]),
        cacheWrite: num(u["cacheWriteInputTokens"]),
      });
      const last = usage?.["last"] as Record<string, unknown> | undefined;
      if (last) this.#contextUsed = num(last["totalTokens"]);
      const current = normalize(total);
      const replay =
        !this.#startedUsageTurn ||
        (this.#turnId !== null && typeof p["turnId"] === "string" && p["turnId"] !== this.#turnId);
      if (replay && this.#usageBaseline !== null) return;
      // A resumed thread replays its historical cumulative before any new
      // turn. Seed the baseline without charging that history a second time.
      let previous = this.#usageBaseline;
      if (previous === null && !replay && last) {
        // Older servers may not replay usage on resume. In that case only
        // the last request is safely attributable to this new runtime.
        const step = normalize(last);
        previous = {
          input: Math.max(0, current.input - step.input),
          output: Math.max(0, current.output - step.output),
          cacheRead: Math.max(0, current.cacheRead - step.cacheRead),
          cacheWrite: Math.max(0, current.cacheWrite - step.cacheWrite),
        };
      }
      this.#usageBaseline = current;
      if (previous === null) {
        this.#events.push({
          type: "context",
          sessionId: this.id,
          ts: now(),
          contextUsed: this.#contextUsed,
          contextLimit: this.#contextLimit,
        });
        return;
      }
      const tokens = zeroUsage();
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        tokens[key] = Math.max(0, current[key] - previous[key]);
        this.#usageBaseline[key] = Math.max(current[key], previous[key]);
        this.#usage[key] += tokens[key];
      }
      if (Object.values(tokens).some((n) => n > 0)) {
        this.#events.push({
          type: "usage",
          sessionId: this.id,
          ts: now(),
          tokens,
          contextUsed: this.#contextUsed,
          contextLimit: this.#contextLimit,
        });
      }
      return;
    }
    if (method === "thread/settings/updated") {
      if (p["threadId"] === this.#threadId) this.#modes.observe(p["threadSettings"]);
      return;
    }
    const item = p["item"] as Record<string, unknown> | undefined;
    // Codex stamps an item's lifecycle; its own times beat when Loom read them.
    if (method === "item/started" && item) this.#itemStarted(item, epochMs(p["startedAtMs"]));
    if (method === "item/completed" && item) this.#item(item, epochMs(p["completedAtMs"]));
    if (method === "item/agentMessage/delta") return; // final item is authoritative and avoids duplicate transcript text.
    if (method === "turn/started") this.#turnId = (p["turn"] as any)?.id ?? this.#turnId;
    if (method === "turn/completed") {
      // `turn/start`'s reply and the turn's completion can arrive in one
      // read, and then this line is handled before the awaited reply names
      // the turn: it would be dropped below as another turn's, or end a turn
      // the reply then revives. `#startTurn` replays it once the turn is named.
      if (this.#startingUsageTurn) {
        this.#deferredTurnCompletions.push(p);
        return;
      }
      const turn = p["turn"] as any;
      const completedId = typeof turn?.id === "string" ? turn.id : undefined;
      // A late notification for a turn already superseded by `interrupt()`
      // (or, in principle, an even-newer turn) — `this.#turnId` has already
      // moved on; acting on it here would wrongly clobber whatever turn is
      // now actually live (or re-emit a `result`/`idle` for one that isn't
      // running anymore). Deliberately *not* added to `#staleTurnIds` here
      // the way `interrupt()` adds its own turn id: a normal completion
      // doesn't invalidate anything still legitimately in flight for that
      // turn the way Loom's own deliberate interrupt does — only requests
      // for a turn Loom itself chose to abandon early are presumptively
      // stale.
      if (completedId && completedId !== this.#turnId) return;
      // A planning turn that proposed a plan, with Plan still selected, is
      // offered for review; one the user already switched away from is not.
      const plan =
        turn?.status === "completed" && this.#turnMode === "plan" && this.#modes.mode === "plan"
          ? this.#proposedPlan
          : null;
      this.#proposedPlan = null;
      this.#turnMode = null;
      this.#turnId = null;
      this.#runningTools.clear();
      this.#itemStartedAt.clear();
      // Codex reads steered input before its next sampling, so a turn that
      // completed took all of it; a server that does not echo `clientId` on
      // the `userMessage` item is confirmed here. A failed turn says nothing.
      if (turn?.status === "completed") for (const id of this.#steered) this.#consumed(id, true);
      this.#steered.clear();
      // Not added to `#staleTurnIds` (see above), but a dispatch still
      // mid-flight for this now-completed turn (e.g. a slow `ToolDispatcher`
      // not yet at its own `ctx.askUser` call) should still see this turn as
      // over rather than proceed to park a new interaction nothing will ever
      // answer — so the signal aborts here too, same as `interrupt()`.
      this.#turnAbort.abort();
      // A completed turn cannot own an unanswered interaction. Drain through
      // the same dispatch completion path used for answers and interrupts.
      this.#pending.failAll(
        { behavior: "deny", message: "the turn ended before this was answered" },
        "(the turn ended before this was answered)",
        { action: "discuss", message: "the turn ended before this was answered" },
      );
      this.#agentCalls.failAll("(the turn ended before this was answered)");
      this.#turns++;
      const { reason, message } = turnErrorReason(turn?.error);
      if (turn?.status === "failed")
        this.#events.push({
          type: "error",
          sessionId: this.id,
          ts: now(),
          message:
            reason && message
              ? `${reason}: ${message}`
              : (reason ?? message ?? "Codex turn failed"),
          fatal: true,
        });
      // Codex stopped the turn itself (Loom's own interrupt cleared `#turnId`
      // and never gets here): e.g. its auto-review denied too many requests.
      else if (turn?.status === "interrupted")
        this.#events.push({
          type: "result",
          sessionId: this.id,
          ts: now(),
          kind: "interrupted",
          ...(reason ? { reason } : {}),
          ...(message ? { message } : {}),
        });
      else if (plan) return this.#offerPlan(plan);
      else this.#events.push({ type: "result", sessionId: this.id, ts: now(), kind: "ok" });
      this.#idle();
    }
  }
  /**
   * The call of a command or MCP tool as it starts, so the daemon sees a tool
   * running (the queue folds messages in at its boundary); its completion
   * adds only the result. Steered input appears here as a `userMessage`.
   */
  #itemStarted(item: Record<string, unknown>, startedAt: number | undefined): void {
    const id = String(item["id"] ?? "");
    if (id && startedAt !== undefined) this.#itemStartedAt.set(id, startedAt);
    const call = this.#toolCallOf(item, startedAt ?? now());
    if (item["type"] === "userMessage") this.#userMessageItem(item);
    else if (call && id && !this.#runningTools.has(id)) {
      this.#runningTools.add(id);
      this.#events.push(call);
    }
  }

  /** The `tool_call` a command / MCP item reports, or null for other items. */
  #toolCallOf(
    item: Record<string, unknown>,
    ts: number,
  ): Extract<HarnessEvent, { type: "tool_call" }> | null {
    const base = {
      type: "tool_call" as const,
      sessionId: this.id,
      ts,
      id: String(item["id"] ?? ""),
    };
    if (item["type"] === "commandExecution")
      return { ...base, name: "Bash", input: { command: item["command"], cwd: item["cwd"] } };
    if (item["type"] === "mcpToolCall")
      return {
        ...base,
        name: `mcp__${item["server"]}__${item["tool"]}`,
        input: item["arguments"],
      };
    return null;
  }

  #item(item: Record<string, unknown>, completedAt: number | undefined): void {
    const id = String(item["id"] ?? "");
    const type = item["type"];
    const ts = completedAt ?? now();
    // A call first reported here still started when Codex said it did.
    const startedAt = this.#itemStartedAt.get(id) ?? ts;
    this.#itemStartedAt.delete(id);
    if (type === "userMessage") this.#userMessageItem(item);
    else if (type === "agentMessage" && typeof item["text"] === "string")
      this.#events.push({ type: "assistant_text", sessionId: this.id, ts, text: item["text"] });
    else if (type === "plan" && typeof item["text"] === "string") {
      // Native Plan's `<proposed_plan>`, split out of the agent message. It is
      // transcript text either way; at turn end it may also be offered for review.
      this.#events.push({ type: "assistant_text", sessionId: this.id, ts, text: item["text"] });
      if (id) this.#proposedPlan = { id, text: item["text"] };
    } else if (type === "reasoning")
      this.#events.push({
        type: "thinking",
        sessionId: this.id,
        ts,
        text: [
          ...((item["summary"] as string[] | undefined) ?? []),
          ...((item["content"] as string[] | undefined) ?? []),
        ].join("\n"),
      });
    else if (type === "commandExecution") {
      const call = this.#toolCallOf(item, startedAt);
      if (!this.#runningTools.delete(id) && call) this.#events.push(call);
      this.#events.push({
        type: "tool_result",
        sessionId: this.id,
        ts,
        id,
        ok: item["status"] === "completed",
        output: item["aggregatedOutput"] ?? "",
      });
    } else if (type === "fileChange") {
      this.#events.push({
        type: "tool_call",
        sessionId: this.id,
        ts: startedAt,
        id,
        name: "apply_patch",
        input: { changes: item["changes"] },
      });
      this.#events.push({
        type: "tool_result",
        sessionId: this.id,
        ts,
        id,
        ok: item["status"] === "completed",
        output: item["status"] ?? "unknown",
      });
    } else if (type === "mcpToolCall") {
      const call = this.#toolCallOf(item, startedAt);
      if (!this.#runningTools.delete(id) && call) this.#events.push(call);
      this.#events.push({
        type: "tool_result",
        sessionId: this.id,
        ts,
        id,
        ok: item["status"] === "completed",
        output: item["result"] ?? item["error"] ?? "",
      });
    } else if (type === "dynamicToolCall") {
      if (this.#dynamicCalls.has(id)) return;
      // Items without a local dispatch (e.g. replay) must still carry an
      // explicit terminal outcome. null means unknown, not failure.
      if (
        (item["status"] !== "completed" && item["status"] !== "failed") ||
        typeof item["success"] !== "boolean"
      )
        return;
      const contentItems = (item["contentItems"] as Array<Record<string, unknown>> | null) ?? [];
      const output = contentItems
        .map((c) => (c["type"] === "inputText" ? String(c["text"] ?? "") : ""))
        .filter(Boolean)
        .join("\n");
      this.#events.push({
        type: "tool_call",
        sessionId: this.id,
        ts: startedAt,
        id,
        name: String(item["tool"] ?? ""),
        input: item["arguments"],
      });
      this.#events.push({
        type: "tool_result",
        sessionId: this.id,
        ts,
        id,
        ok: item["success"] === true,
        output,
      });
    } else if (type === "subAgentActivity") {
      const subagentId = String(item["agentThreadId"] ?? id);
      if (item["kind"] === "started") {
        // Recognize this thread id for `#serverRequest`'s guard — a
        // sub-agent's own approval/tool requests (if delivered at all; see
        // the comment on `#subagentThreadIds`) carry its own distinct
        // `threadId`, not the parent's.
        this.#subagentThreadIds.add(subagentId);
        this.#events.push({
          type: "subagent_started",
          sessionId: this.id,
          ts,
          subagentId,
          name: String(item["agentPath"] ?? subagentId),
        });
      } else {
        this.#subagentThreadIds.delete(subagentId);
        this.#events.push({ type: "subagent_stopped", sessionId: this.id, ts, subagentId });
      }
    } else if (type === "contextCompaction")
      this.#events.push({
        type: "compact",
        sessionId: this.id,
        ts,
        trigger: "auto",
        before: this.#contextUsed,
        after: 0,
      });
  }
}

const textInput = (text: string): Record<string, unknown> => ({
  type: "text",
  text,
  text_elements: [],
});

const MODE_NAMES: Record<CodexAgentMode, string> = {
  auto: "Auto",
  default: "Manual",
  plan: "Plan",
};
const modeName = (mode: CodexAgentMode): string => MODE_NAMES[mode];
