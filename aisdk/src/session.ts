/**
 * An `AgentSession` over an OpenAI-compatible model. Loom owns everything the
 * Claude CLI would otherwise own: the `ModelMessage[]`, its persistence, tool
 * wiring, the permission gate, compaction, and per-turn lifecycle. `events()`
 * is a single channel that stays open across turns and closes only on `close()`.
 *
 * M10b–d: multi-step turns with MCP tools, the `loom` tools, a first-party
 * Bash/Edit/Grep suite, plan mode (`exit_plan` → `plan_review`), Loom-side
 * summarise-and-rebuild compaction, and `task` sub-agents.
 */
import { randomUUID } from "node:crypto";
import { stepCountIs, streamText, tool } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { z } from "zod";
import type { HarnessEvent } from "@loom/core/events";
import {
  stateError,
  stateIdle,
  stateInterrupted,
  stateRunning,
  stateStarting,
} from "@loom/core/session-state";
import { AsyncChannel } from "@loom/core/channel";
import { makeLogger, type Logger } from "@loom/core/logger";
import type {
  AdapterSnapshot,
  AgentSession,
  EffortLevel,
  McpServerHandle,
  PermissionDecision,
  PlanDecision,
  SessionMode,
  UserInput,
} from "@loom/core/types";
import { AisdkEventMapper } from "./map.ts";
import { runTurn, type VendorOptions } from "./loop.ts";
import { dropDanglingToolCalls } from "./transcript.ts";
import { McpHub } from "./mcp.ts";
import { buildLoomTools } from "./loom-tools.ts";
import { BuiltinTools } from "./tools/builtins.ts";
import type { SearchConfig } from "@loom/core/connector";
import { isReadonly, wrapToolSet } from "./gate.ts";
import type { TranscriptStore } from "@loom/core/transcript";
import { contextLimitFor, estimateTokens } from "@loom/core/tokens";
import { PendingInteractions } from "@loom/runtime/pending";

/**
 * Default per-*segment* ceiling on tool round-trips. It is not a hard turn
 * limit: when a segment hits it with the model still working (its last step
 * finished on tool calls), the turn auto-continues with a fresh budget, up to
 * `MAX_TURN_SEGMENTS` times — so a model that takes many small steps isn't cut
 * off mid-task. Override per provider with `max_steps` in the config.
 */
const DEFAULT_MAX_STEPS = 50;
/**
 * How many step-ceiling segments one turn may burn before Loom stops it and
 * flags the `result` with `stopReason: "step_limit"`. A turn that reaches this
 * is almost certainly looping; the session is left `idle` so a `send` can still
 * continue it.
 */
const MAX_TURN_SEGMENTS = 5;
/** Compact automatically once the estimated context exceeds this fraction. */
const AUTO_COMPACT_FRACTION = 0.85;
/**
 * Hard ceiling on one summariser call. Compaction rewrites the whole transcript
 * in a single completion, which scales with history length and can legitimately
 * run for minutes — so this is generous. Past it the call is aborted and the
 * compaction is abandoned (the transcript is left intact). Kept in step with the
 * client's `session.compact` RPC timeout in `src/client/client.ts`.
 */
const SUMMARISE_TIMEOUT_MS = 15 * 60_000;
/** First few heartbeats while summarising, then back off to keep the ring buffer sane. */
const COMPACT_BEAT_FAST_MS = 2_000;
const COMPACT_BEAT_SLOW_MS = 10_000;
const COMPACT_BEAT_BACKOFF_AFTER_MS = 30_000;

const COMPACT_PREAMBLE =
  "The earlier conversation was summarised to save context. Continue from this summary:\n\n";

const SUBAGENT_SYSTEM =
  "You are a sub-agent handling one focused task delegated by a parent agent. " +
  "You have the same tools but your own context and cannot ask questions. Do the " +
  "task, then end with a short report of what you did and what you found.";

export interface AisdkSessionOptions {
  sessionId: string;
  modelId: string;
  /** Resolve a model id (from config / `setModel`) to a live model. */
  makeModel: (id: string) => LanguageModel;
  /** Reasoning-effort level sent with each request — openai-compatible maps it
   *  to the `reasoning_effort` body field. Ignored when no options key is set. */
  effort?: EffortLevel;
  /** The `providerOptions` key the model's SDK reads under — the connector
   *  sets it for openai-compatible; native SDKs take no effort today. */
  providerOptionsName?: string;
  /**
   * Prompt-cache breakpoint to send with every request
   * (`providerOptions.anthropic.cacheControl`); omitted → none. Set by the
   * connector for native-Anthropic sessions.
   */
  cacheControl?: { type: "ephemeral"; ttl?: "5m" | "1h" };
  system: string | undefined;
  messages: ModelMessage[];
  mode: SessionMode;
  /** The session's worktree — `cwd` for the `commit` tool. */
  cwd: string;
  /** Vendor-neutral MCP servers to connect for this session. */
  mcpHandles: McpServerHandle[];
  /** Mount the `loom` tools + first-party Bash/Edit/Grep + plan/task tools. */
  loomServer: boolean;
  /** Resolved `web_search` config, when configured. */
  search?: SearchConfig;
  /** The repo's base branch, for the `status` tool's ahead/behind counts. */
  base?: string;
  /** null for a throwaway one-shot. */
  store: TranscriptStore | null;
  /** A one-shot ends its stream after the first turn (titling). */
  oneShot: boolean;
  /** Per-segment step ceiling. Defaults to {@link DEFAULT_MAX_STEPS}. */
  maxSteps?: number;
  /**
   * Known per-model context-window sizes (endpoint-reported `/models` metadata
   * or `model_context` pins). Consulted before the built-in prefix table.
   */
  modelContext?: Record<string, number>;
  log?: Logger;
}

export class AisdkSession implements AgentSession {
  readonly id: string;

  #modelId: string;
  #model: LanguageModel;
  readonly #makeModel: (id: string) => LanguageModel;
  /** Reasoning effort sent with every request, when the connector supports one. */
  #effort: EffortLevel | null = null;
  readonly #providerOptionsName: string | undefined;
  readonly #cacheControl: { type: "ephemeral"; ttl?: "5m" | "1h" } | undefined;
  readonly #system: string | undefined;
  #mode: SessionMode;
  readonly #cwd: string;
  readonly #search: SearchConfig | undefined;
  readonly #base: string | undefined;
  readonly #mcpHandles: McpServerHandle[];
  readonly #loomServer: boolean;
  readonly #store: TranscriptStore | null;
  readonly #oneShot: boolean;
  readonly #maxSteps: number;
  readonly #modelContext: Record<string, number>;
  /** Consecutive step-ceiling continuations in the current user turn. */
  #segmentsRun = 0;
  readonly #log: Logger;

  readonly #messages: ModelMessage[];
  readonly #outbox = new AsyncChannel<HarnessEvent>();
  readonly #mapper: AisdkEventMapper;
  #abort: AbortController | null = null;
  #turn: Promise<void> | null = null;
  /** True from `#kickTurn()` until the turn (and any chained turn) settles. */
  #turnRunning = false;
  /**
   * Set by `interrupt()`, cleared by the next `send()`. `#abort` only reaches
   * the *currently* live segment; between the chained segments of a step-limit
   * turn it is briefly null, so this flag is what stops the next segment (and
   * the impl / injection re-chains) from kicking off after an interrupt.
   */
  #interrupted = false;
  /** User messages sent mid-turn, drained by the loop's `prepareStep`. */
  readonly #injections: string[] = [];
  #closing = false;
  #compacting = false;
  /** The in-flight `#doCompact`, tracked so `interrupt()` / `close()` can await
   *  its unwind after aborting it. Null between compactions. */
  #compaction: Promise<void> | null = null;
  /** Aborts the current summariser stream on `interrupt()` / `close()`. */
  #compactAbort: AbortController | null = null;
  #implementAfterTurn: {
    plan: string;
    fresh: boolean;
    mode?: SessionMode;
    model?: string;
    effort?: EffortLevel;
  } | null = null;
  #snap: AdapterSnapshot;

  #hub: McpHub | null = null;
  /** MCP `readOnlyHint` declarations for the mounted names, from `#hub` —
   *  minus names a first-party tool took over, since the hint describes the
   *  server's tool, not ours. Read by the gate instead of the name heuristics. */
  #declaredReadonly: ReadonlyMap<string, boolean> = new Map();
  #builtins: BuiltinTools | null = null;
  #baseToolsPromise: Promise<ToolSet> | null = null;
  readonly #pending = new PendingInteractions<{ allow: boolean; message?: string }, PlanDecision>();

  constructor(opts: AisdkSessionOptions) {
    this.id = opts.sessionId;
    this.#modelId = opts.modelId;
    this.#modelContext = opts.modelContext ?? {};
    this.#providerOptionsName = opts.providerOptionsName;
    this.#cacheControl = opts.cacheControl;
    this.#effort = opts.effort ?? null;
    this.#makeModel = opts.makeModel;
    this.#model = opts.makeModel(opts.modelId);
    this.#system = opts.system;
    this.#mode = opts.mode;
    this.#cwd = opts.cwd;
    this.#search = opts.search;
    this.#base = opts.base;
    this.#mcpHandles = opts.mcpHandles;
    this.#loomServer = opts.loomServer;
    this.#store = opts.store;
    this.#oneShot = opts.oneShot;
    this.#maxSteps = Math.max(1, Math.trunc(opts.maxSteps ?? DEFAULT_MAX_STEPS));
    this.#log = opts.log ?? makeLogger("aisdk").child(opts.sessionId.slice(0, 8));
    this.#messages = [...opts.messages];
    this.#mapper = new AisdkEventMapper(opts.sessionId, opts.modelId, (m) => this.#limitFor(m));
    this.#snap = {
      status: stateStarting,
      providerRef: opts.sessionId,
      model: opts.modelId,
      effort: opts.effort ?? null,
      mode: opts.mode,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextUsed: 0,
      contextLimit: this.#limitFor(opts.modelId),
      costUsd: 0,
      turns: 0,
    };
  }

  /** Start the session. `run` kicks the first turn (create / one-shot); resume passes false. */
  start(run: boolean): void {
    if (run && this.#lastRole() === "user") {
      this.#kickTurn();
    } else {
      this.#snap.status = stateIdle;
    }
  }

  /** Run a turn, tracking `#turnRunning` across it (and any turn it chains). */
  #kickTurn(): void {
    this.#turnRunning = true;
    this.#turn = this.#runTurn();
  }

  get providerRef(): string {
    return this.id;
  }

  events(): AsyncIterable<HarnessEvent> {
    return this.#outbox;
  }

  async send(input: UserInput): Promise<void> {
    if (this.#closing) throw new Error("session is closing");
    // Mid-turn: hand the message to the running loop's `prepareStep`, which
    // splices it in after the current tool result. The daemon emits the
    // `user_message` event so every client sees it land.
    if (this.#turnRunning) {
      this.#injections.push(input);
      return;
    }
    // Claim the turn *synchronously* — a second send() that arrives before the
    // await below resolves must see `#turnRunning` and queue as an injection,
    // not race a second overlapping #runTurn().
    this.#turnRunning = true;
    try {
      await this.#turn?.catch(() => {});
      await this.#compaction?.catch(() => {});
      const msg: ModelMessage = { role: "user", content: input };
      this.#messages.push(msg);
      this.#store?.append(this.id, [msg]);
    } catch (err) {
      // A throw before #kickTurn() (a DB write failing on a shutdown race, …)
      // must release the claim — nothing else would clear it and every later
      // send() would silently queue forever.
      this.#turnRunning = false;
      throw err;
    }
    this.#segmentsRun = 0; // a fresh user turn — reset the step-ceiling counter
    this.#interrupted = false; // a new turn supersedes any prior interrupt
    this.#kickTurn();
  }

  /** Move any queued mid-turn messages into the transcript; returns what moved. */
  #flushInjections(): ModelMessage[] {
    if (this.#injections.length === 0) return [];
    const msgs: ModelMessage[] = this.#injections.splice(0).map((content) => ({
      role: "user",
      content,
    }));
    this.#messages.push(...msgs);
    this.#store?.append(this.id, msgs);
    return msgs;
  }

  async compact(instructions?: string): Promise<void> {
    if (this.#closing) throw new Error("session is closing");
    await this.#turn?.catch(() => {});
    await this.#compactTracked(instructions, "manual");
  }

  /**
   * Run `#doCompact` under a tracked promise + abort controller so `interrupt()`
   * / `close()` can cancel an in-flight summarise — which legitimately runs for
   * minutes on a long transcript — and await its unwind.
   */
  async #compactTracked(
    instructions: string | undefined,
    trigger: "manual" | "auto",
  ): Promise<void> {
    this.#compactAbort = new AbortController();
    this.#compaction = this.#doCompact(instructions, trigger);
    try {
      await this.#compaction;
    } finally {
      this.#compaction = null;
      this.#compactAbort = null;
    }
  }

  async respondToPermission(id: string, decision: PermissionDecision): Promise<void> {
    this.#pending.resolvePermission(
      id,
      decision.behavior === "allow"
        ? { allow: true }
        : { allow: false, ...(decision.message ? { message: decision.message } : {}) },
    );
  }

  async answerQuestion(id: string, text: string): Promise<void> {
    if (!this.#pending.resolveQuestion(id, text)) return;
    this.#emit({ type: "answer", sessionId: this.id, ts: Date.now(), id, text });
  }

  async respondToPlan(id: string, decision: PlanDecision): Promise<void> {
    // An implementing decision picks the mode the implementation runs in. Apply
    // it now, not when the exploration turn unwinds into the chained implement
    // turn: the session manager reads `snapshot()` straight after this call to
    // refresh the registry, and a mode still reporting "plan" there is never
    // revisited — the TUI's mode chip would stay on [plan] for the whole
    // implementation. Mirrors the Claude adapter, which syncs its mode before
    // resolving the ExitPlanMode allow. The chain re-applies the same value;
    // `discuss` / `handoff` deliberately stay in plan mode.
    if (!this.#pending.resolvePlan(id, decision)) return;
    if (
      decision.action === "implement" ||
      decision.action === "implement_fresh" ||
      decision.action === "revise"
    ) {
      const mode = decision.mode ?? "acceptEdits"; // the chain-time fallback
      this.#mode = mode;
      this.#snap.mode = mode;
    }
  }

  async interrupt(): Promise<void> {
    this.#interrupted = true;
    this.#abort?.abort();
    // Abort a compaction too — a manual one is tracked by `#compaction`, an
    // in-`#runTurn` auto-compaction is awaited via `#turn`. Order the abort
    // before both awaits.
    this.#compactAbort?.abort();
    // A turn parked in the permission gate won't see the abort until its tool
    // `execute` returns — resolve the parked gate(s) so `#turn` can settle.
    this.#failPendingGates("the turn was interrupted");
    await this.#turn?.catch(() => {});
    await this.#compaction?.catch(() => {});
  }

  /** Undo: keep the first `keep` messages, discard the rest (in memory + store). */
  async rewind(keep: number): Promise<void> {
    if (this.#closing) throw new Error("session is closing");
    await this.#turn?.catch(() => {});
    await this.#compaction?.catch(() => {});
    const n = Math.max(0, Math.min(this.#messages.length, keep));
    this.#messages.length = n;
    this.#store?.replaceFrom(this.id, n, []);
    this.#snap.status = stateIdle;
  }

  async setMode(mode: SessionMode): Promise<void> {
    this.#mode = mode;
    this.#snap.mode = mode;
  }

  async setModel(model: string): Promise<void> {
    this.#modelId = model;
    this.#model = this.#makeModel(model);
    this.#mapper.setModel(model);
    this.#snap.model = model;
    this.#snap.contextLimit = this.#limitFor(model);
  }

  /** Reasoning effort rides into `streamText` as `providerOptions` —
   *  `@ai-sdk/openai-compatible` maps it to the OpenAI `reasoning_effort`
   *  request field. Takes effect from the next turn on. A connector that gave
   *  no provider-options name (native Gemini / Anthropic SDKs) never sends it. */
  async setEffort(effort: EffortLevel): Promise<void> {
    this.#effort = effort;
    this.#snap.effort = effort;
  }

  snapshot(): AdapterSnapshot {
    return { ...this.#snap, usage: { ...this.#snap.usage } };
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#abort?.abort();
    this.#compactAbort?.abort();
    await this.#turn?.catch(() => {});
    await this.#compaction?.catch(() => {});
    this.#failPendingGates("the session was closed");
    this.#builtins?.close();
    await this.#hub?.close().catch(() => {});
    this.#outbox.close();
  }

  // --- internals -----------------------------------------------------------

  /**
   * `streamText` providerOptions: the chosen reasoning effort under the
   * connector's options key, and/or a prompt-cache breakpoint for Anthropic.
   * Undefined when there is nothing to send.
   */
  #providerOptions(): VendorOptions | undefined {
    const out: VendorOptions = {};
    // One breakpoint per request, auto-placed by the API on the last cacheable
    // block: this turn caches the conversation so far, the next turn reads it
    // back. Sent on every request, not just the first — the prefix grows each
    // turn, so a single breakpoint written once would go stale immediately.
    if (this.#cacheControl) out["anthropic"] = { cacheControl: this.#cacheControl };
    if (this.#effort != null && this.#providerOptionsName) {
      out[this.#providerOptionsName] = {
        ...out[this.#providerOptionsName],
        reasoningEffort: this.#effort,
      };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** Context limit for a model id: endpoint-reported / pinned sizes first,
   *  then the built-in prefix table. */
  #limitFor(model: string | null): number {
    return contextLimitFor(model, this.#modelContext);
  }

  #lastRole(): string | undefined {
    return this.#messages[this.#messages.length - 1]?.role;
  }

  /**
   * Resolve every parked permission / question / plan so a gated tool `execute`
   * stops awaiting and the turn can unwind. Used by `interrupt()` and `close()`.
   */
  #failPendingGates(why: string): void {
    this.#pending.failAll({ allow: false, message: why }, `(${why})`, {
      action: "discuss",
      message: why,
    });
  }

  /**
   * A turn stopped mid-tool (interrupt / provider error) leaves the transcript
   * ending on an assistant `tool-call` with no result — the next `send` would
   * ship that to the endpoint and 400 (or hang). Trim it here too, not only on
   * cold `resumeSession`, since a live session continues in place.
   */
  #healDanglingToolCalls(): void {
    const trimmed = dropDanglingToolCalls(this.#messages);
    if (trimmed.length === this.#messages.length) return;
    this.#messages.length = trimmed.length;
    this.#store?.replaceFrom(this.id, trimmed.length, []);
  }

  #emit(ev: HarnessEvent): void {
    if (ev.type === "usage") {
      this.#snap.usage.input += ev.tokens.input;
      this.#snap.usage.output += ev.tokens.output;
      this.#snap.usage.cacheRead += ev.tokens.cacheRead;
      this.#snap.usage.cacheWrite += ev.tokens.cacheWrite;
      this.#snap.contextUsed = ev.contextUsed;
      this.#snap.contextLimit = ev.contextLimit;
    }
    this.#outbox.push(ev);
  }

  /** Connect MCP servers + build the *unwrapped* base tool set. Memoized. */
  #ensureBaseTools(): Promise<ToolSet> {
    if (!this.#baseToolsPromise) {
      this.#baseToolsPromise = (async () => {
        const base: ToolSet = {};
        // MCP servers claim their names first: a configured server offering a
        // builtin's name (fff's `grep`) replaces it — the tool steer points
        // the model at those servers, so it must see their tools, not ours.
        if (this.#mcpHandles.length > 0) {
          this.#hub = await McpHub.connect(this.#mcpHandles, this.#log, this.#cwd);
          Object.assign(base, this.#hub.tools);
        }
        if (this.#loomServer) {
          // Session-control tools are unconditional — they wire into the
          // daemon's permission / question / plan / subagent plumbing and
          // must not be shadowed by a same-named MCP tool.
          Object.assign(
            base,
            buildLoomTools({
              cwd: this.#cwd,
              ...(this.#base ? { base: this.#base } : {}),
              askUser: (q, c) => this.#askUser(q, c),
            }),
          );
          Object.assign(base, this.#planAndTaskTools());
          // Builtins fill only the names no MCP server claimed.
          this.#builtins = new BuiltinTools(this.#cwd, this.#search);
          for (const [name, t] of Object.entries(this.#builtins.tools)) {
            if (!(name in base)) base[name] = t;
          }
        }
        // Annotate the mounted set with the servers' readOnlyHint declarations,
        // dropping any whose name a first-party tool replaced.
        if (this.#hub) {
          const hub = this.#hub;
          this.#declaredReadonly = new Map(
            [...hub.readOnlyHints].filter(
              ([name]) =>
                (base as Record<string, unknown>)[name] ===
                (hub.tools as Record<string, unknown>)[name],
            ),
          );
        }
        return base;
      })();
    }
    return this.#baseToolsPromise;
  }

  /** The gated tool set for a turn — plan mode withholds mutators, other modes drop `exit_plan`. */
  async #turnToolSet(): Promise<ToolSet> {
    const base = await this.#ensureBaseTools();
    const picked: Record<string, unknown> = {};
    const src = base as Record<string, unknown>;
    for (const name of Object.keys(src)) {
      if (this.#mode === "plan") {
        if (
          name === "exit_plan" ||
          name === "ask_user" ||
          isReadonly(name, this.#declaredReadonly.get(name))
        )
          picked[name] = src[name];
      } else if (name !== "exit_plan") {
        picked[name] = src[name];
      }
    }
    return wrapToolSet(picked as ToolSet, {
      mode: () => this.#mode,
      ask: (name, input, toolCallId) => this.#requestPermission(name, input, toolCallId),
      readonlyHints: this.#declaredReadonly,
    });
  }

  #planAndTaskTools(): ToolSet {
    return {
      exit_plan: tool({
        description:
          "Call this only in plan mode, once your plan is complete. Pass the full plan text; " +
          "the user reviews it and decides whether to implement, revise, or keep discussing.",
        inputSchema: z.object({
          plan: z.string().describe("The complete implementation plan, in markdown."),
        }),
        execute: async ({ plan }, { toolCallId }) => {
          const decision = await this.#requestPlan(plan, toolCallId);
          switch (decision.action) {
            case "discuss":
              return `The user is not ready to implement. Their note:\n\n${decision.message}\n\nStay in planning, address this, and call exit_plan again when ready.`;
            case "revise":
              this.#implementAfterTurn = {
                plan: decision.plan,
                fresh: false,
                ...(decision.mode ? { mode: decision.mode } : {}),
              };
              return "The user edited and approved the plan. Implementation begins now.";
            case "implement_fresh":
              this.#implementAfterTurn = {
                plan,
                fresh: true,
                ...(decision.mode ? { mode: decision.mode } : {}),
                ...(decision.model ? { model: decision.model } : {}),
                ...(decision.effort ? { effort: decision.effort } : {}),
              };
              return "Plan approved. The context will be compacted to the plan and goal, then implementation begins.";
            case "handoff":
              // The daemon has already spawned a fresh session (an `⌥p` retarget
              // onto a different provider) to carry the implementation. Leave
              // `#implementAfterTurn` null — this turn just ends and the session
              // goes idle.
              return "Plan approved. Implementation continues in a separate session.";
            default:
              this.#implementAfterTurn = {
                plan,
                fresh: false,
                ...(decision.mode ? { mode: decision.mode } : {}),
              };
              return "Plan approved. Implementation begins now.";
          }
        },
      }),
      task: tool({
        description:
          "Delegate a focused, self-contained sub-task to a fresh sub-agent that has the same " +
          "tools but its own context. Good for a search sweep or an isolated change, so your own " +
          "context stays lean. The sub-agent cannot ask questions. Returns its final report.",
        inputSchema: z.object({
          description: z.string().describe("A 3–6 word label for the sub-task."),
          prompt: z.string().describe("Full, self-contained instructions for the sub-agent."),
        }),
        execute: async ({ description, prompt }) => {
          const report = await this.#runSubagent(description, prompt);
          return { report };
        },
      }),
    };
  }

  #askUser(question: string, context: string | undefined): Promise<string> {
    const id = randomUUID();
    const answer = this.#pending.requestQuestion(id);
    this.#emit({
      type: "question",
      sessionId: this.id,
      ts: Date.now(),
      id,
      question,
      ...(context ? { context } : {}),
    });
    return answer;
  }

  #requestPlan(plan: string, toolCallId?: string): Promise<PlanDecision> {
    // Keyed on the tool-call id (like `#requestPermission`) so the resolving
    // `tool_result` matches the `plan_review` — the only durable mark, in the
    // event log a client backfills from, that the plan was decided.
    const id = toolCallId || randomUUID();
    const decision = this.#pending.requestPlan(id);
    this.#emit({ type: "plan_review", sessionId: this.id, ts: Date.now(), id, plan });
    return decision;
  }

  #requestPermission(
    toolName: string,
    input: unknown,
    _toolCallId: string,
  ): Promise<{ allow: boolean; message?: string }> {
    // A5: key the gate on a fresh id, never the provider's `toolCallId` — under
    // concurrent `task` sub-agents two calls can share one id, and the second
    // would overwrite the first's resolver in `#pending` → orphaned await.
    const id = randomUUID();
    const decision = this.#pending.requestPermission(id);
    this.#emit({
      type: "permission_request",
      sessionId: this.id,
      ts: Date.now(),
      id,
      tool: toolName,
      input,
    });
    return decision;
  }

  async #runSubagent(name: string, prompt: string): Promise<string> {
    const subId = randomUUID();
    this.#emit({
      type: "subagent_started",
      sessionId: this.id,
      ts: Date.now(),
      subagentId: subId,
      name,
    });

    const base = await this.#ensureBaseTools();
    const src = base as Record<string, unknown>;
    const subPicked: Record<string, unknown> = {};
    for (const n of Object.keys(src)) if (n !== "task" && n !== "exit_plan") subPicked[n] = src[n];
    const effectiveMode: SessionMode = this.#mode === "plan" ? "default" : this.#mode;
    const subTools = wrapToolSet(subPicked as ToolSet, {
      mode: () => effectiveMode,
      ask: (nm, input, id) => this.#requestPermission(`${name} › ${nm}`, input, id),
    });
    const subMapper = new AisdkEventMapper(this.id, this.#modelId, (m) => this.#limitFor(m));

    let report = "";
    let failure: string | null = null;
    let lastStepReason: string | undefined;
    const po = this.#providerOptions();
    try {
      const res = streamText({
        model: this.#model,
        // Sub-agents run the same model for the same session — carry the effort.
        ...(po ? { providerOptions: po } : {}),
        system: SUBAGENT_SYSTEM,
        messages: [{ role: "user", content: prompt }],
        tools: subTools,
        stopWhen: stepCountIs(this.#maxSteps),
        abortSignal: this.#abort?.signal ?? AbortSignal.timeout(300_000),
      });
      for await (const part of res.fullStream) {
        for (const ev of subMapper.map(part)) this.#emit({ ...ev, agentId: subId } as HarnessEvent);
        if (part.type === "text-delta") report += part.text;
        if (part.type === "error") failure = "the sub-agent's model stream errored";
        if (part.type === "finish-step") {
          const r = (part as { finishReason?: string }).finishReason;
          if (r) lastStepReason = r;
        }
        if (part.type === "abort") break;
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    // The step ceiling cut the sub-agent off mid-work (unlike the main loop it
    // has no continuation) — tell the parent turn so it doesn't treat a
    // truncated report as a complete answer.
    const truncated = failure == null && lastStepReason === "tool-calls";
    if (failure != null || truncated) {
      this.#emit({
        type: "error",
        sessionId: this.id,
        ts: Date.now(),
        message: truncated
          ? `sub-agent "${name}" hit its ${this.#maxSteps}-step limit; report is partial`
          : `sub-agent "${name}": ${failure}`,
        fatal: false,
        agentId: subId,
      } as HarnessEvent);
      if (failure != null) report = report || `sub-agent failed: ${failure}`;
      else report += "\n\n[sub-agent truncated at its step limit — result may be incomplete]";
    }

    this.#emit({ type: "subagent_stopped", sessionId: this.id, ts: Date.now(), subagentId: subId });
    return report.trim() || "(the sub-agent produced no output)";
  }

  async #doCompact(instructions: string | undefined, trigger: "manual" | "auto"): Promise<void> {
    if (this.#compacting || this.#messages.length === 0) return;
    this.#compacting = true;
    const startedAt = Date.now();
    const before = estimateTokens(this.#messages);
    let generated = 0;
    // A heartbeat so clients can show "compacting… 42s" instead of staring at a
    // frozen UI (or hitting an arbitrary RPC timeout) during a multi-minute
    // summarise. `generated` is a liveness proxy, not a percentage.
    const beat = (): void =>
      this.#emit({
        type: "compact_progress",
        sessionId: this.id,
        ts: Date.now(),
        elapsedMs: Date.now() - startedAt,
        generated,
        before,
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      const slow = Date.now() - startedAt > COMPACT_BEAT_BACKOFF_AFTER_MS;
      timer = setTimeout(
        () => {
          beat();
          schedule();
        },
        slow ? COMPACT_BEAT_SLOW_MS : COMPACT_BEAT_FAST_MS,
      );
      if (typeof timer.unref === "function") timer.unref();
    };
    beat();
    schedule();
    try {
      const summary = await this.#summarize(
        instructions,
        (n) => {
          generated = n;
        },
        this.#compactAbort?.signal,
      );
      if (!summary) {
        // Timed out or errored inside the summariser. Nothing was rewritten —
        // the transcript is intact. Emit a non-fatal error so clients can clear
        // the "compacting…" indicator and log the miss (status is unaffected).
        this.#emit({
          type: "error",
          sessionId: this.id,
          ts: Date.now(),
          message: "compaction failed — the transcript was left as-is",
          fatal: false,
        });
        return;
      }
      // A1/A2: bail before the destructive rewrite if the session was
      // interrupted / closed while the summariser ran (a partial or complete
      // summary must not replace the live transcript out from under a caller).
      if (this.#closing || this.#interrupted || this.#compactAbort?.signal.aborted) {
        this.#emit({
          type: "error",
          sessionId: this.id,
          ts: Date.now(),
          message: "compaction was cancelled — the transcript was left as-is",
          fatal: false,
        });
        return;
      }
      const rebuilt: ModelMessage[] = [{ role: "user", content: COMPACT_PREAMBLE + summary }];
      this.#messages.length = 0;
      this.#messages.push(...rebuilt);
      this.#store?.replaceFrom(this.id, 0, rebuilt);
      this.#emit({
        type: "compact",
        sessionId: this.id,
        ts: Date.now(),
        trigger,
        before,
        after: estimateTokens(rebuilt),
        summary,
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.#compacting = false;
    }
  }

  async #summarize(
    instructions: string | undefined,
    onProgress?: (chars: number) => void,
    cancel?: AbortSignal,
  ): Promise<string | null> {
    const ask =
      instructions?.trim() ||
      "Preserve the goal, the decisions made, the files touched, and anything still open.";
    let text = "";
    try {
      const res = streamText({
        model: this.#model,
        ...(this.#system ? { system: this.#system } : {}),
        messages: [
          ...this.#messages,
          {
            role: "user",
            content: `Summarise this conversation so work can continue with the summary standing in for the full history. ${ask} Respond with only the summary.`,
          },
        ],
        abortSignal: cancel
          ? AbortSignal.any([AbortSignal.timeout(SUMMARISE_TIMEOUT_MS), cancel])
          : AbortSignal.timeout(SUMMARISE_TIMEOUT_MS),
      });
      for await (const part of res.fullStream) {
        if (part.type === "text-delta") {
          text += part.text;
          onProgress?.(text.length);
        } else if (part.type === "finish-step") {
          // Meter the summariser call — otherwise a frequently-compacting long
          // session under-reports cost / tokens (and budget enforcement drifts).
          for (const ev of this.#mapper.mapUsage(part.usage, part.providerMetadata)) this.#emit(ev);
        } else if (part.type === "error" || part.type === "abort") {
          // A partial summary replaces the *entire* transcript — a mid-stream
          // provider error or an abort must abandon the compaction, not commit
          // whatever text arrived so far.
          return null;
        }
      }
    } catch {
      return null;
    }
    return text.trim() || null;
  }

  async #runTurn(): Promise<void> {
    // `chained` = this turn kicked a follow-up that now owns `#turnRunning`.
    let chained = false;
    try {
      // A8: interrupt / close during pre-turn setup (MCP connect, auto-compact)
      // still lands a settled status — set it here, emit nothing (the daemon
      // derives its own state; a synthetic `result` would corrupt turn counts).
      if (this.#closing || this.#interrupted) {
        this.#snap.status = this.#interrupted ? stateInterrupted("user") : stateIdle;
        return;
      }

      if (
        !this.#oneShot &&
        this.#snap.contextLimit > 0 &&
        estimateTokens(this.#messages) > this.#snap.contextLimit * AUTO_COMPACT_FRACTION
      ) {
        await this.#compactTracked(undefined, "auto");
      }

      const tools = await this.#turnToolSet();
      if (this.#closing || this.#interrupted) {
        this.#snap.status = this.#interrupted ? stateInterrupted("user") : stateIdle;
        return;
      }

      const abort = new AbortController();
      this.#abort = abort;
      this.#snap.status = stateRunning;

      const po = this.#providerOptions();
      const { aborted, errored, hitStepLimit, hitContextLimit } = await runTurn({
        sessionId: this.id,
        model: this.#model,
        ...(po ? { providerOptions: po } : {}),
        system: this.#system,
        messages: this.#messages,
        ...(Object.keys(tools).length > 0 ? { tools } : {}),
        maxSteps: this.#maxSteps,
        abortSignal: abort.signal,
        mapper: this.#mapper,
        drainInjections: () =>
          this.#injections.splice(0).map((content) => ({ role: "user", content }) as ModelMessage),
        // A9: end the segment early if a run of big tool reads pushes the
        // transcript near the window — the next segment compacts at its top.
        shouldStopForContext: () =>
          !this.#oneShot &&
          this.#snap.contextLimit > 0 &&
          estimateTokens(this.#messages) > this.#snap.contextLimit * AUTO_COMPACT_FRACTION,
        // A plan approval must end the turn: the tool set was built while the
        // session was still in plan mode (mutators withheld) and can't be
        // swapped mid-flight. The chained turn below re-reads the mode and
        // rebuilds the tools, so implementation gets edit access.
        shouldStop: () => this.#implementAfterTurn !== null,
        hooks: {
          emit: (ev) => this.#emit(ev),
          appendMessages: (msgs) => {
            this.#messages.push(...msgs);
            this.#store?.append(this.id, msgs);
          },
        },
      });

      this.#abort = null;

      // `#interrupted` without `aborted` = the interrupt landed in the gap
      // between two step-limit segments, after `#abort` was cleared.
      const stopped = aborted || this.#interrupted;
      if (stopped || errored) {
        this.#segmentsRun = 0;
        // A4: a stream error while a tool sat parked in the permission gate —
        // `runTurn` now breaks the read loop on an `error` part, but the gate's
        // `execute` is still awaiting. Release it so the transcript heal below
        // sees the real tail. (`stopped` already went through `interrupt()`.)
        if (errored && !stopped) this.#failPendingGates("the turn errored");
        // Whether the turn stopped in the gate or on a provider error, the
        // transcript may now end on an unanswered tool-call — trim it (before
        // re-attaching any injection) so the next `send` starts from valid
        // history, not only after a cold `resumeSession`.
        this.#healDanglingToolCalls();
        if (stopped) {
          // The user interrupted — drop anything queued but not yet acted on
          // rather than persisting it as a dangling unanswered user message.
          this.#injections.length = 0;
        } else {
          // An errored turn may be resumed; keep a late injection for that.
          this.#flushInjections();
        }
        this.#snap.status = stopped ? stateInterrupted("user") : stateError("turn failed");
        if (this.#oneShot) this.#outbox.close();
        return;
      }

      // A plan was approved this turn → chain straight into implementation
      // (the exploration turn emits no `result`).
      const impl = this.#implementAfterTurn;
      this.#implementAfterTurn = null;
      if (impl) {
        // The approved plan's implement mode (the plan review's `⇧⇥` cycle);
        // `acceptEdits` when the caller left it off — the long-standing default.
        const mode = impl.mode ?? "acceptEdits";
        this.#mode = mode;
        this.#snap.mode = mode;
        // An `⌥p` retarget on the plain-fresh path (a different provider forks
        // instead, and never reaches here). `setEffort` is a no-op for aisdk.
        if (impl.model) await this.setModel(impl.model);
        if (impl.effort) await this.setEffort(impl.effort);
        if (impl.fresh) {
          await this.#compactTracked(
            "Keep the approved plan and the original goal verbatim; drop the exploration transcript.",
            "auto",
          );
        }
        const msg: ModelMessage = {
          role: "user",
          content: `The plan is approved. Implement it now:\n\n${impl.plan}`,
        };
        this.#messages.push(msg);
        this.#store?.append(this.id, [msg]);
        this.#segmentsRun = 0;
        chained = true;
        this.#kickTurn();
        return;
      }

      // A message injected past the last `prepareStep` folds into this same
      // turn — continue it rather than emitting a `result` and flapping idle.
      if (!this.#oneShot && this.#flushInjections().length > 0) {
        this.#segmentsRun = 0;
        chained = true;
        this.#kickTurn();
        return;
      }

      // The per-segment step ceiling stopped the loop while the model was still
      // working (its last step ended on tool calls). Continue the same turn with
      // a fresh budget rather than emitting `result` and flapping to idle
      // mid-task — the transcript already ends with the tool results it needs to
      // react to. `MAX_TURN_SEGMENTS` is the runaway-loop backstop.
      if (!this.#oneShot && (hitStepLimit || hitContextLimit)) {
        this.#segmentsRun += 1;
        if (this.#segmentsRun < MAX_TURN_SEGMENTS) {
          chained = true;
          this.#kickTurn();
          return;
        }
        this.#emit({
          type: "error",
          sessionId: this.id,
          ts: Date.now(),
          message:
            `turn stopped after ${this.#segmentsRun} segments of up to ${this.#maxSteps} steps ` +
            `without completing — likely a loop. The session is idle; send a message to continue it.`,
          fatal: false,
        });
        this.#segmentsRun = 0;
        this.#snap.turns += 1;
        this.#emit({
          type: "result",
          sessionId: this.id,
          ts: Date.now(),
          kind: "ok",
          stopReason: "step_limit",
        });
        this.#snap.status = stateIdle;
        return;
      }

      this.#segmentsRun = 0;
      this.#snap.turns += 1;
      this.#emit({ type: "result", sessionId: this.id, ts: Date.now(), kind: "ok" });
      this.#snap.status = stateIdle;
      if (this.#oneShot) this.#outbox.close();
    } catch (err) {
      this.#snap.status = stateError("turn failed");
      this.#emit({
        type: "error",
        sessionId: this.id,
        ts: Date.now(),
        message: err instanceof Error ? err.message : String(err),
        fatal: true,
      });
      if (this.#oneShot) this.#outbox.close();
    } finally {
      // Guarantee the gate is released unless a follow-up turn took over —
      // otherwise a throw before a terminal branch wedges every future send().
      if (!chained) this.#turnRunning = false;
    }
  }
}
