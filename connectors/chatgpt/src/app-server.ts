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
import type {
  AdapterSnapshot,
  AgentSession,
  CreateSessionOptions,
  EffortLevel,
  McpServerHandle,
  PermissionDecision,
  PlanDecision,
  SessionMode,
  SessionRef,
} from "@loom/core/types";
import { CodexRpcClient } from "./rpc.ts";
import { verifyChatGptAccount } from "./account.ts";
import type { CodexHome } from "./codex-home.ts";
import { spawnCodex, type CodexLauncher } from "./launch.ts";
import { localToolDispatcher, type ToolDispatcher } from "./tool-dispatch.ts";

const zeroUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const now = (): number => Date.now();

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
          ...(spec.args?.length ? [`args = [${spec.args.map(value).join(", ")}]`] : []),
          ...(spec.env ? [`env = ${table(spec.env)}`] : []),
        ];
        return [s.name, `{ ${fields.join(", ")} }`] as const;
      }
      const spec = s.spec as Extract<McpServerHandle["spec"], { transport: "http" }>;
      const fields = [
        `url = ${value(spec.url)}`,
        ...(spec.headers ? [`http_headers = ${table(spec.headers)}`] : []),
      ];
      return [s.name, `{ ${fields.join(", ")} }`] as const;
    }),
  );
  return `{ ${[...entries.entries()].map(([name, config]) => `${value(name)} = ${config}`).join(", ")} }`;
};

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

const EXIT_PLAN_DESC =
  "Call this only in plan mode, once your plan is complete. Pass the full plan text; " +
  "the user reviews it and decides whether to implement, revise, or keep discussing.";

/**
 * Loom's own tools (`commit`, `status`, `ask_user`, `exit_plan`), mounted as
 * Codex dynamic tools (`thread/start`'s `dynamicTools`) rather than a
 * separate stdio MCP server — Codex calls them directly via a
 * server-initiated `item/tool/call` request (`#toolCall` below). Only ever
 * called from `start()` — `thread/resume` has no `dynamicTools` field at all
 * (see the comment on `resume()` below), so there is nothing to (re)send on
 * resume regardless of which tools a given call site wants.
 *
 * `exit_plan` has no native Codex equivalent (Codex's own "plan mode" is
 * just a read-only sandbox — there is no protocol concept of presenting a
 * plan for human review) — it's Loom's own emulation, the same shape as
 * aisdk's bespoke `exit_plan` tool (`aisdk/src/session.ts`), reusing its
 * description text for cross-provider consistency.
 */
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
  {
    type: "function",
    name: "exit_plan",
    description: EXIT_PLAN_DESC,
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "The complete implementation plan, in markdown." },
      },
      required: ["plan"],
      additionalProperties: false,
    },
  },
];

const policyFor = (mode: SessionMode): "untrusted" | "on-request" =>
  mode === "default" || mode === "plan" ? "untrusted" : "on-request";

const sandboxFor = (mode: SessionMode): "read-only" | "workspace-write" =>
  mode === "plan" ? "read-only" : "workspace-write";

export const approvalsReviewerFor = (mode: SessionMode): "user" | "auto_review" =>
  mode === "auto" ? "auto_review" : "user";

export class CodexAppServerSession implements AgentSession {
  readonly id: string;
  readonly #rpc: CodexRpcClient;
  #events = new AsyncChannel<HarnessEvent>();
  readonly #pending = new PendingInteractions<PermissionDecision, PlanDecision>();
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
   * hands it to `#askUser`/`#requestPlan`/`#requestApproval`, so any of
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
   * Bumped only by an *external* `interrupt()`/`close()` call — never by
   * `setMode`'s own internal turn-ending step (see `#endTurn`). A multi-step
   * transition that spans several `await`s (`respondToPlan`'s setMode-then-
   * send sequence) snapshots this before starting and rechecks it after each
   * await; if it has changed, something *outside* that transition decided to
   * stop the session while it was in flight, and the transition must not
   * finish implementing a plan (or report "approved") on the strength of
   * work that started before that decision. `#turnAbort` alone can't
   * distinguish this: `setMode` aborts it too, as an expected, internal part
   * of successfully completing the very same transition — a signal that's
   * "already aborted" doesn't say *why*.
   */
  #interruptGeneration = 0;
  #threadId: string | null = null;
  #turnId: string | null = null;
  #model: string;
  #effort: EffortLevel | null;
  #mode: SessionMode;
  #cwd: string;
  readonly #base: string | undefined;
  readonly #dispatch: ToolDispatcher;
  #closing = false;
  #status = stateRunning;
  #usage = zeroUsage();
  #usageBaseline: ReturnType<typeof zeroUsage> | null = zeroUsage();
  #startedUsageTurn = false;
  #startingUsageTurn = false;
  #pendingUsage: Record<string, unknown>[] = [];
  #contextUsed = 0;
  #contextLimit = 0;
  #turns = 0;

  private constructor(
    opts: CreateSessionOptions,
    proc: ChildProcessWithoutNullStreams,
    base: string | undefined,
    dispatch: ToolDispatcher,
  ) {
    this.id = opts.sessionId;
    this.#model = opts.model ?? "";
    this.#effort = opts.effort ?? null;
    this.#mode = opts.mode;
    this.#cwd = opts.cwd;
    this.#base = base;
    this.#dispatch = dispatch;
    this.#rpc = new CodexRpcClient(proc);
    this.#rpc.onServerRequest((method, params, id) => this.#serverRequest(method, params, id));
    this.#rpc.onNotification((method, params) => this.#notification(method, params));
    this.#rpc.onClose((err) => {
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
  ): Promise<CodexAppServerSession> {
    // Replacing the complete table prevents ~/.codex/config.toml MCP entries
    // from leaking into a Loom-controlled session.
    const built = launchOptions(opts.mcpServers, search, builtinWebSearch, codexHome);
    const proc = launch({ cliPath, args: built.args, cwd: opts.cwd, env: built.env, codexHome });
    const s = new CodexAppServerSession(opts, proc, base, dispatch);
    try {
      await s.#initialize();
      const started = await s.#rpc.requestStartup("thread/start", {
        ...(opts.model ? { model: opts.model } : {}),
        cwd: opts.cwd,
        approvalPolicy: policyFor(opts.mode),
        approvalsReviewer: approvalsReviewerFor(opts.mode),
        sandbox: sandboxFor(opts.mode),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.systemPromptAppend ? { developerInstructions: opts.systemPromptAppend } : {}),
        ...(opts.loomServer ? { dynamicTools: loomDynamicTools() } : {}),
      });
      s.#threadId = (started as any)?.thread?.id ?? null;
      if (!s.#threadId) throw new Error("codex app-server did not return a thread id");
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
    const s = new CodexAppServerSession(opts, proc, base, dispatch);
    try {
      await s.#initialize();
      s.#usageBaseline = null;
      s.#threadId = ref.providerRef;
      const resumed = await s.#rpc.requestStartup("thread/resume", {
        threadId: ref.providerRef,
        cwd: ref.cwd,
        approvalPolicy: policyFor(opts.mode),
        approvalsReviewer: approvalsReviewerFor(opts.mode),
        sandbox: sandboxFor(opts.mode),
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
      });
      s.#threadId = (resumed as any)?.thread?.id ?? ref.providerRef;
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
  }

  get providerRef(): string | null {
    return this.#threadId;
  }
  events(): AsyncIterable<HarnessEvent> {
    return this.#events;
  }

  async send(input: string): Promise<void> {
    if (!this.#threadId) throw new Error("Codex thread has not started");
    if (this.#turnId) {
      await this.#rpc.request("turn/steer", {
        threadId: this.#threadId,
        expectedTurnId: this.#turnId,
        input: [textInput(input)],
      });
      return;
    }
    await this.#startTurn(input);
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
  /** loom `exit_plan` handler: emit a `plan_review` event, block until
   *  decided. `id`/`signal`: see `#askUser`'s doc comment. */
  #requestPlan(plan: string, id: string, signal: AbortSignal | undefined): Promise<PlanDecision> {
    if (signal?.aborted)
      return Promise.resolve({ action: "discuss", message: "the turn was interrupted" });
    const decision = this.#pending.requestPlan(id);
    this.#events.push({ type: "plan_review", sessionId: this.id, ts: now(), id, plan });
    return decision;
  }
  /**
   * Codex has no native tool call to resolve/deny for `exit_plan` (unlike
   * Claude's SDK-native `ExitPlanMode`) — the dynamic tool call's own
   * response ("Plan approved...", see `tool-dispatch.ts`'s `exit_plan`
   * branch) is what tells the model it can stop waiting, so it must not go
   * out until the mode/turn transition below has actually succeeded — never
   * resolve `#requestPlan`'s pending promise *before* attempting it. A
   * `discuss`/`handoff` decision has no transition to make (the model was
   * already told to keep planning, or that implementation continues
   * elsewhere) — those resolve immediately.
   *
   * For `implement`/`revise`, and — for now — `implement_fresh` too (its
   * context-reset/compaction is explicitly Phase 6's job per the plan doc,
   * so it's treated as a plain `implement` here rather than half-built):
   * `setMode` unconditionally interrupts the still-running planning turn
   * (plan mode's turn was snapshotted read-only at its own `turn/start`, and
   * nothing short of a fresh turn can make it writable) and `send` starts a
   * genuinely new one carrying the revised instructions — both awaited, in
   * order, *before* the pending plan resolves. If either fails, the plan
   * resolves as a `discuss` instead (telling the model the transition
   * didn't happen, never "approved") and the error is rethrown so the
   * caller (the daemon) sees the failure too, rather than this method
   * quietly swallowing it after having already un-blocked the old turn.
   *
   * `detachPlan`, not `resolvePlan`, on this path: `setMode` interrupting the
   * planning turn (above) drains every *other* currently pending interaction
   * via `#pending.failAll` — including, if left tracked, this very plan
   * review, racing this method's own deliberate resolution and resolving it
   * first with a generic "the turn was interrupted" cancellation instead of
   * the real decision. Detaching removes it from that drain's reach for the
   * rest of this transition; the raw resolve function is invoked explicitly,
   * once, with whatever this method itself determines the outcome to be.
   *
   * `#interruptGeneration` is checked after *each* await, not just relied on
   * via `setMode`/`send` throwing: an external `interrupt()` (someone
   * stopping the session for reasons unrelated to this plan — e.g. mid-flight
   * while a held `thread/settings/update` response is still pending) doesn't
   * make `setMode`/`send` fail — by the time the held response arrives,
   * `this.#turnId` is already `null` (the external interrupt already ended
   * that turn), so `setMode` sees nothing left *it* needs to interrupt, and
   * `send` just starts a fresh turn as if nothing had happened. Without this
   * check, that fresh turn — and the "approved" report — would go out anyway,
   * silently overriding the very interrupt that was supposed to stop
   * everything. `generation` deliberately snapshots `#interruptGeneration`,
   * not `#turnAbort`'s signal: `setMode`'s own internal turn-ending step
   * (`#endTurn`) aborts that signal too, as an expected part of *this*
   * transition succeeding, so it can't tell "an external stop happened" from
   * "the planning turn was interrupted right on schedule."
   */
  async respondToPlan(id: string, decision: PlanDecision): Promise<void> {
    if (decision.action === "discuss" || decision.action === "handoff") {
      this.#pending.resolvePlan(id, decision);
      return;
    }
    const resolve = this.#pending.detachPlan(id);
    if (!resolve) return;
    const generation = this.#interruptGeneration;
    const ensureNotSuperseded = async (): Promise<void> => {
      if (generation === this.#interruptGeneration) return;
      // Something external ended the session while this transition was in
      // flight — clean up anything this transition itself already started
      // (best-effort; the session is being torn down or already idle either
      // way) and refuse to report success on its behalf.
      if (this.#turnId && !this.#closing) await this.#endTurn().catch(() => {});
      throw new Error("the session was interrupted before the plan could be implemented");
    };
    try {
      await this.setMode(decision.mode ?? "acceptEdits");
      await ensureNotSuperseded();
      const planText = decision.action === "revise" ? decision.plan : "the plan you just presented";
      await this.send(`The plan is approved. Implement it now:\n\n${planText}`);
      await ensureNotSuperseded();
      resolve(decision);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({ action: "discuss", message: `the plan could not be implemented — ${message}` });
      throw err;
    }
  }

  /**
   * The mechanical work of ending the current turn: `turn/interrupt` RPC,
   * `#turnId`/`#staleTurnIds`/`#turnAbort` bookkeeping, and draining every
   * parked interaction — always, even when the RPC itself throws (a
   * `try`/`finally`, not a bare `await`): a failed interrupt request must
   * not leave a permission/question/plan promise (or the caller waiting on
   * this method) hanging forever just because the underlying RPC call
   * failed. `this.#turnId` is captured and cleared *before* that RPC call,
   * and the old id is recorded in `#staleTurnIds` *and* `#turnAbort` is
   * aborted before anything else — so any request tagged with the old turn
   * is rejected by `#serverRequest`'s guard before it can even reach a
   * dispatcher, and any dispatch already admitted and running sees its
   * captured `signal` flip to aborted the moment it next calls
   * `#askUser`/`#requestPlan`/`#requestApproval`, rather than starting new
   * work under a turn Loom already considers over.
   *
   * Deliberately **not** public, and does **not** touch
   * `#interruptGeneration` — shared by the public `interrupt()` (an
   * external, unrelated-to-any-transition stop) and `setMode`'s own internal
   * turn-ending step (an expected part of successfully applying a mode
   * change, including `respondToPlan`'s own transition). Only the former
   * should ever invalidate an in-flight `respondToPlan` transition.
   */
  async #endTurn(): Promise<void> {
    const turnId = this.#turnId;
    this.#turnId = null;
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
      this.#idle();
    }
  }
  /**
   * The public, externally-triggered stop (a user hitting stop, the daemon
   * tearing down a session) — as opposed to `setMode`'s own internal,
   * expected turn-ending step. Bumps `#interruptGeneration` *before* doing
   * the actual work, so an in-flight `respondToPlan` transition that
   * snapshotted the generation earlier reliably observes the change as soon
   * as it next checks, regardless of how long `#endTurn`'s own RPC call
   * takes.
   */
  async interrupt(): Promise<void> {
    this.#interruptGeneration++;
    await this.#endTurn();
  }
  async rewind(): Promise<void> {
    throw new Error("Codex app-server rewind is not yet supported by Loom");
  }
  /**
   * `thread/settings/update` only ever takes effect "for subsequent turns"
   * (confirmed via the generated `ThreadSettingsUpdateParams` doc comments):
   * `approvalPolicy`, `sandboxPolicy` and `approvalsReviewer` are each
   * snapshotted once, at that turn's own `turn/start` (`#startTurn` passes
   * all three explicitly), and nothing about the currently running turn
   * changes when the thread's default changes underneath it. The protocol
   * also defines a `turn/settings/update` for exactly that live case, but it
   * is absent from the freshly-generated bindings for the actually-installed
   * `codex-cli` build (present only in the Rust source / an older/dev
   * binding set) — calling it unconditionally, as this method used to, is a
   * live compatibility risk, not a design choice.
   *
   * So: always set the thread-level default (safe, always available), then
   * — whenever a turn is actually running and the mode is genuinely
   * changing — interrupt that turn so the new mode is guaranteed to apply to
   * whatever runs next, rather than silently finishing the current turn
   * under the old settings. This is deliberately unconditional on
   * direction, not just tightening: every one of the three native axes is
   * turn-snapshotted, so even a pure relaxation (e.g. leaving `plan`'s
   * read-only sandbox for `acceptEdits`) needs a fresh turn to actually take
   * effect — a `turn/steer` on the still-running, still-read-only turn would
   * leave the model unable to write despite the "approved" mode change. This
   * ends the user's in-flight turn (the session goes idle); their next
   * message (or `respondToPlan`'s own follow-up `send()`) starts a fresh one
   * under the new mode.
   *
   * Calls `#endTurn` directly, not the public `interrupt()` — this is an
   * internal, expected part of applying the mode change itself, not an
   * external stop, and must not invalidate an in-flight `respondToPlan`
   * transition that's the very reason this call is happening (see
   * `#interruptGeneration`'s doc comment).
   */
  async setMode(mode: SessionMode): Promise<void> {
    if (!this.#threadId) throw new Error("Codex thread has not started");
    const changed = mode !== this.#mode;
    await this.#rpc.request("thread/settings/update", {
      threadId: this.#threadId,
      approvalPolicy: policyFor(mode),
      approvalsReviewer: approvalsReviewerFor(mode),
      sandboxPolicy: this.#sandboxPolicyFor(mode),
    });
    this.#mode = mode;
    if (this.#turnId && changed) await this.#endTurn();
  }
  async setModel(model: string): Promise<void> {
    this.#model = model;
  }
  async setEffort(effort: EffortLevel): Promise<void> {
    this.#effort = effort;
  }
  snapshot(): AdapterSnapshot {
    return {
      status: this.#status,
      providerRef: this.#threadId,
      model: this.#model || null,
      effort: this.#effort,
      mode: this.#mode,
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
    this.#turnAbort?.abort();
    this.#pending.failAll(
      { behavior: "deny", message: "the session was closed before this was answered" },
      "(the session was closed before this was answered)",
      { action: "discuss", message: "the session was closed before this was answered" },
    );
    this.#rpc.close();
    this.#events.close();
  }

  async #startTurn(input: string): Promise<void> {
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
    let result: unknown;
    try {
      result = await this.#rpc.request("turn/start", {
        threadId: this.#threadId,
        input: [textInput(input)],
        model: this.#model || undefined,
        effort: this.#effort ?? undefined,
        approvalPolicy: policyFor(this.#mode),
        approvalsReviewer: approvalsReviewerFor(this.#mode),
        sandboxPolicy: this.#sandboxPolicy(),
      });
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
  #sandboxPolicy(): Record<string, unknown> {
    return this.#sandboxPolicyFor(this.#mode);
  }
  #sandboxPolicyFor(mode: SessionMode): Record<string, unknown> {
    if (mode === "plan") return { type: "readOnly", networkAccess: false };
    return {
      type: "workspaceWrite",
      writableRoots: [this.#cwd],
      networkAccess: false,
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
   *  (`commit`/`status`/`ask_user`/`exit_plan`, see `loomDynamicTools`).
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
    // the id for any pending interaction this call raises (`ask_user`,
    // `exit_plan`, a `commit` approval wait) instead of minting a fresh one,
    // so a persisted-event-log replay can correlate "this question/plan/
    // approval was resolved" from the id alone, the same way it already can
    // for `ask_user`'s own `question`/`answer` pair.
    const callId = typeof p["callId"] === "string" && p["callId"] ? p["callId"] : randomUUID();
    // Captured now, at admission — the *this* turn's signal, not whatever
    // turn happens to be live by the time this dispatch actually reaches
    // `ctx.askUser`/etc. (see `#turnAbort`'s doc comment).
    const signal = this.#turnAbort?.signal;
    const respond = (text: string, success: boolean): void => {
      this.#rpc.respond(id, { contentItems: [{ type: "inputText", text }], success });
    };
    this.#dispatch(tool, args, {
      mode: this.#mode,
      cwd: this.#cwd,
      ...(this.#base ? { base: this.#base } : {}),
      ...(signal ? { signal } : {}),
      askUser: (q, c) => this.#askUser(q, c, callId, signal),
      requestPlan: (plan) => this.#requestPlan(plan, callId, signal),
      requestApproval: (t, a) => this.#requestApproval(t, a, callId, signal),
    }).then(
      (res) => respond(res.text, res.ok),
      (err: unknown) => respond(err instanceof Error ? err.message : String(err), false),
    );
  }
  #notification(method: string, p: Record<string, unknown>): void {
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
    const item = p["item"] as Record<string, unknown> | undefined;
    if (method === "item/completed" && item) this.#item(item);
    if (method === "item/agentMessage/delta") return; // final item is authoritative and avoids duplicate transcript text.
    if (method === "turn/started") this.#turnId = (p["turn"] as any)?.id ?? this.#turnId;
    if (method === "turn/completed") {
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
      this.#turnId = null;
      // Not added to `#staleTurnIds` (see above), but a dispatch still
      // mid-flight for this now-completed turn (e.g. a slow `ToolDispatcher`
      // not yet at its own `ctx.askUser` call) should still see this turn as
      // over rather than proceed to park a new interaction nothing will ever
      // answer — so the signal aborts here too, same as `interrupt()`.
      this.#turnAbort.abort();
      this.#turns++;
      if (turn?.status === "failed")
        this.#events.push({
          type: "error",
          sessionId: this.id,
          ts: now(),
          message: turn?.error?.message ?? "Codex turn failed",
          fatal: true,
        });
      else this.#events.push({ type: "result", sessionId: this.id, ts: now(), kind: "ok" });
      this.#idle();
    }
  }
  #item(item: Record<string, unknown>): void {
    const id = String(item["id"] ?? "");
    const type = item["type"];
    const ts = now();
    if (type === "agentMessage" && typeof item["text"] === "string")
      this.#events.push({ type: "assistant_text", sessionId: this.id, ts, text: item["text"] });
    else if (type === "reasoning")
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
      this.#events.push({
        type: "tool_call",
        sessionId: this.id,
        ts,
        id,
        name: "Bash",
        input: { command: item["command"], cwd: item["cwd"] },
      });
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
        ts,
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
      this.#events.push({
        type: "tool_call",
        sessionId: this.id,
        ts,
        id,
        name: `mcp__${item["server"]}__${item["tool"]}`,
        input: item["arguments"],
      });
      this.#events.push({
        type: "tool_result",
        sessionId: this.id,
        ts,
        id,
        ok: item["status"] === "completed",
        output: item["result"] ?? item["error"] ?? "",
      });
    } else if (type === "dynamicToolCall") {
      const contentItems = (item["contentItems"] as Array<Record<string, unknown>> | null) ?? [];
      const output = contentItems
        .map((c) => (c["type"] === "inputText" ? String(c["text"] ?? "") : ""))
        .filter(Boolean)
        .join("\n");
      this.#events.push({
        type: "tool_call",
        sessionId: this.id,
        ts,
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
