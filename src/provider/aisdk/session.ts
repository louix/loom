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
import type { HarnessEvent } from "../../protocol/events.ts";
import { AsyncChannel } from "../../util/channel.ts";
import { makeLogger, type Logger } from "../../util/logger.ts";
import type {
  AdapterSnapshot,
  AgentSession,
  McpServerHandle,
  PermissionDecision,
  PlanDecision,
  SessionMode,
  UserInput,
} from "../types.ts";
import { AisdkEventMapper } from "./map.ts";
import { runTurn } from "./loop.ts";
import { McpHub } from "./mcp.ts";
import { buildLoomTools } from "./loom-tools.ts";
import { BuiltinTools } from "./tools/builtins.ts";
import type { SearchConfig } from "./tools/search.ts";
import { isReadonly, wrapToolSet } from "./gate.ts";
import type { ProviderMessageStore } from "./store.ts";
import { contextLimitFor, estimateTokens } from "./tokens.ts";

/** Hard ceiling on tool round-trips within one turn. */
const MAX_STEPS = 24;
/** Compact automatically once the estimated context exceeds this fraction. */
const AUTO_COMPACT_FRACTION = 0.85;

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
  /** null for a throwaway one-shot. */
  store: ProviderMessageStore | null;
  /** A one-shot ends its stream after the first turn (titling). */
  oneShot: boolean;
  log?: Logger;
}

export class AisdkSession implements AgentSession {
  readonly id: string;

  #modelId: string;
  #model: LanguageModel;
  readonly #makeModel: (id: string) => LanguageModel;
  readonly #system: string | undefined;
  #mode: SessionMode;
  readonly #cwd: string;
  readonly #search: SearchConfig | undefined;
  readonly #mcpHandles: McpServerHandle[];
  readonly #loomServer: boolean;
  readonly #store: ProviderMessageStore | null;
  readonly #oneShot: boolean;
  readonly #log: Logger;

  readonly #messages: ModelMessage[];
  readonly #outbox = new AsyncChannel<HarnessEvent>();
  readonly #mapper: AisdkEventMapper;
  #abort: AbortController | null = null;
  #turn: Promise<void> | null = null;
  /** True from `#kickTurn()` until the turn (and any chained turn) settles. */
  #turnRunning = false;
  /** User messages sent mid-turn, drained by the loop's `prepareStep`. */
  readonly #injections: string[] = [];
  #closing = false;
  #compacting = false;
  #implementAfterTurn: { plan: string; fresh: boolean } | null = null;
  #snap: AdapterSnapshot;

  #hub: McpHub | null = null;
  #builtins: BuiltinTools | null = null;
  #baseToolsPromise: Promise<ToolSet> | null = null;
  readonly #pendingPerms = new Map<string, (d: { allow: boolean; message?: string }) => void>();
  readonly #pendingQuestions = new Map<string, (answer: string) => void>();
  readonly #pendingPlans = new Map<string, (d: PlanDecision) => void>();

  constructor(opts: AisdkSessionOptions) {
    this.id = opts.sessionId;
    this.#modelId = opts.modelId;
    this.#makeModel = opts.makeModel;
    this.#model = opts.makeModel(opts.modelId);
    this.#system = opts.system;
    this.#mode = opts.mode;
    this.#cwd = opts.cwd;
    this.#search = opts.search;
    this.#mcpHandles = opts.mcpHandles;
    this.#loomServer = opts.loomServer;
    this.#store = opts.store;
    this.#oneShot = opts.oneShot;
    this.#log = opts.log ?? makeLogger("aisdk").child(opts.sessionId.slice(0, 8));
    this.#messages = [...opts.messages];
    this.#mapper = new AisdkEventMapper(opts.sessionId, opts.modelId);
    this.#snap = {
      status: "starting",
      providerRef: opts.sessionId,
      model: opts.modelId,
      mode: opts.mode,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextUsed: 0,
      contextLimit: contextLimitFor(opts.modelId),
      costUsd: 0,
      turns: 0,
    };
  }

  /** Start the session. `run` kicks the first turn (create / one-shot); resume passes false. */
  start(run: boolean): void {
    if (run && this.#lastRole() === "user") {
      this.#kickTurn();
    } else {
      this.#snap.status = "idle";
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
    await this.#turn?.catch(() => {});
    const msg: ModelMessage = { role: "user", content: input };
    this.#messages.push(msg);
    this.#store?.append(this.id, [msg]);
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
    await this.#doCompact(instructions, "manual");
  }

  async respondToPermission(id: string, decision: PermissionDecision): Promise<void> {
    const resolve = this.#pendingPerms.get(id);
    if (!resolve) return; // already resolved / unknown — first writer won
    this.#pendingPerms.delete(id);
    resolve(
      decision.behavior === "allow"
        ? { allow: true }
        : { allow: false, ...(decision.message ? { message: decision.message } : {}) },
    );
  }

  async answerQuestion(id: string, text: string): Promise<void> {
    const resolve = this.#pendingQuestions.get(id);
    if (!resolve) return;
    this.#pendingQuestions.delete(id);
    this.#emit({ type: "answer", sessionId: this.id, ts: Date.now(), id, text });
    resolve(text);
  }

  async respondToPlan(id: string, decision: PlanDecision): Promise<void> {
    const resolve = this.#pendingPlans.get(id);
    if (!resolve) return;
    this.#pendingPlans.delete(id);
    resolve(decision);
  }

  async interrupt(): Promise<void> {
    this.#abort?.abort();
    await this.#turn?.catch(() => {});
  }

  /** Undo: keep the first `keep` messages, discard the rest (in memory + store). */
  async rewind(keep: number): Promise<void> {
    if (this.#closing) throw new Error("session is closing");
    await this.#turn?.catch(() => {});
    const n = Math.max(0, Math.min(this.#messages.length, keep));
    this.#messages.length = n;
    this.#store?.replaceFrom(this.id, n, []);
    this.#snap.status = "idle";
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
    this.#snap.contextLimit = contextLimitFor(model);
  }

  snapshot(): AdapterSnapshot {
    return { ...this.#snap, usage: { ...this.#snap.usage } };
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#abort?.abort();
    await this.#turn?.catch(() => {});
    for (const [, r] of this.#pendingPerms) r({ allow: false, message: "the session was closed" });
    this.#pendingPerms.clear();
    for (const [, r] of this.#pendingQuestions) r("(the session was closed before the user answered)");
    this.#pendingQuestions.clear();
    for (const [, r] of this.#pendingPlans) r({ action: "discuss", message: "the session was closed" });
    this.#pendingPlans.clear();
    this.#builtins?.close();
    await this.#hub?.close().catch(() => {});
    this.#outbox.close();
  }

  // --- internals -----------------------------------------------------------

  #lastRole(): string | undefined {
    return this.#messages[this.#messages.length - 1]?.role;
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
        if (this.#mcpHandles.length > 0) {
          this.#hub = await McpHub.connect(this.#mcpHandles, this.#log);
          Object.assign(base, this.#hub.tools);
        }
        if (this.#loomServer) {
          Object.assign(base, buildLoomTools({ cwd: this.#cwd, askUser: (q, c) => this.#askUser(q, c) }));
          this.#builtins = new BuiltinTools(this.#cwd, this.#search);
          Object.assign(base, this.#builtins.tools);
          Object.assign(base, this.#planAndTaskTools());
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
        if (name === "exit_plan" || name === "ask_user" || isReadonly(name)) picked[name] = src[name];
      } else if (name !== "exit_plan") {
        picked[name] = src[name];
      }
    }
    return wrapToolSet(picked as ToolSet, {
      mode: () => this.#mode,
      ask: (name, input, toolCallId) => this.#requestPermission(name, input, toolCallId),
    });
  }

  #planAndTaskTools(): ToolSet {
    return {
      exit_plan: tool({
        description:
          "Call this only in plan mode, once your plan is complete. Pass the full plan text; " +
          "the user reviews it and decides whether to implement, revise, or keep discussing.",
        inputSchema: z.object({ plan: z.string().describe("The complete implementation plan, in markdown.") }),
        execute: async ({ plan }) => {
          const decision = await this.#requestPlan(plan);
          switch (decision.action) {
            case "discuss":
              return `The user is not ready to implement. Their note:\n\n${decision.message}\n\nStay in planning, address this, and call exit_plan again when ready.`;
            case "revise":
              this.#implementAfterTurn = { plan: decision.plan, fresh: false };
              return "The user edited and approved the plan. Implementation begins now.";
            case "implement_fresh":
              this.#implementAfterTurn = { plan, fresh: true };
              return "Plan approved. The context will be compacted to the plan and goal, then implementation begins.";
            default:
              this.#implementAfterTurn = { plan, fresh: false };
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
    return new Promise<string>((resolve) => {
      this.#pendingQuestions.set(id, resolve);
      this.#emit({
        type: "question",
        sessionId: this.id,
        ts: Date.now(),
        id,
        question,
        ...(context ? { context } : {}),
      });
    });
  }

  #requestPlan(plan: string): Promise<PlanDecision> {
    const id = randomUUID();
    return new Promise<PlanDecision>((resolve) => {
      this.#pendingPlans.set(id, resolve);
      this.#emit({ type: "plan_review", sessionId: this.id, ts: Date.now(), id, plan });
    });
  }

  #requestPermission(
    toolName: string,
    input: unknown,
    toolCallId: string,
  ): Promise<{ allow: boolean; message?: string }> {
    const id = toolCallId || randomUUID();
    return new Promise((resolve) => {
      this.#pendingPerms.set(id, resolve);
      this.#emit({
        type: "permission_request",
        sessionId: this.id,
        ts: Date.now(),
        id,
        tool: toolName,
        input,
      });
    });
  }

  async #runSubagent(name: string, prompt: string): Promise<string> {
    const subId = randomUUID();
    this.#emit({ type: "subagent_started", sessionId: this.id, ts: Date.now(), subagentId: subId, name });

    const base = await this.#ensureBaseTools();
    const src = base as Record<string, unknown>;
    const subPicked: Record<string, unknown> = {};
    for (const n of Object.keys(src)) if (n !== "task" && n !== "exit_plan") subPicked[n] = src[n];
    const effectiveMode: SessionMode = this.#mode === "plan" ? "default" : this.#mode;
    const subTools = wrapToolSet(subPicked as ToolSet, {
      mode: () => effectiveMode,
      ask: (nm, input, id) => this.#requestPermission(`${name} › ${nm}`, input, id),
    });
    const subMapper = new AisdkEventMapper(this.id, this.#modelId);

    let report = "";
    try {
      const res = streamText({
        model: this.#model,
        system: SUBAGENT_SYSTEM,
        messages: [{ role: "user", content: prompt }],
        tools: subTools,
        stopWhen: stepCountIs(MAX_STEPS),
        abortSignal: this.#abort?.signal ?? AbortSignal.timeout(300_000),
      });
      for await (const part of res.fullStream) {
        if (part.type === "abort") break;
        for (const ev of subMapper.map(part)) this.#emit({ ...ev, agentId: subId } as HarnessEvent);
        if (part.type === "text-delta") report += part.text;
      }
    } catch (err) {
      report = report || `sub-agent failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    this.#emit({ type: "subagent_stopped", sessionId: this.id, ts: Date.now(), subagentId: subId });
    return report.trim() || "(the sub-agent produced no output)";
  }

  async #doCompact(instructions: string | undefined, trigger: "manual" | "auto"): Promise<void> {
    if (this.#compacting || this.#messages.length === 0) return;
    this.#compacting = true;
    try {
      const before = estimateTokens(this.#messages);
      const summary = await this.#summarize(instructions);
      if (!summary) return;
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
      this.#compacting = false;
    }
  }

  async #summarize(instructions: string | undefined): Promise<string | null> {
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
        abortSignal: AbortSignal.timeout(60_000),
      });
      for await (const part of res.fullStream) if (part.type === "text-delta") text += part.text;
    } catch {
      return null;
    }
    return text.trim() || null;
  }

  async #runTurn(): Promise<void> {
    // `chained` = this turn kicked a follow-up that now owns `#turnRunning`.
    let chained = false;
    try {
      if (this.#closing) return;

      if (
        !this.#oneShot &&
        this.#snap.contextLimit > 0 &&
        estimateTokens(this.#messages) > this.#snap.contextLimit * AUTO_COMPACT_FRACTION
      ) {
        await this.#doCompact(undefined, "auto");
      }

      const tools = await this.#turnToolSet();
      if (this.#closing) return;

      const abort = new AbortController();
      this.#abort = abort;
      this.#snap.status = "running";

      const { aborted, errored } = await runTurn({
        sessionId: this.id,
        model: this.#model,
        system: this.#system,
        messages: this.#messages,
        ...(Object.keys(tools).length > 0 ? { tools } : {}),
        maxSteps: MAX_STEPS,
        abortSignal: abort.signal,
        mapper: this.#mapper,
        drainInjections: () =>
          this.#injections.splice(0).map((content) => ({ role: "user", content }) as ModelMessage),
        hooks: {
          emit: (ev) => this.#emit(ev),
          appendMessages: (msgs) => {
            this.#messages.push(...msgs);
            this.#store?.append(this.id, msgs);
          },
        },
      });

      this.#abort = null;

      if (aborted || errored) {
        if (aborted) {
          // The user interrupted — drop anything queued but not yet acted on
          // rather than persisting it as a dangling unanswered user message.
          this.#injections.length = 0;
        } else {
          // An errored turn may be resumed; keep a late injection for that.
          this.#flushInjections();
        }
        this.#snap.status = aborted ? "interrupted" : "error";
        if (this.#oneShot) this.#outbox.close();
        return;
      }

      // A plan was approved this turn → chain straight into implementation
      // (the exploration turn emits no `result`).
      const impl = this.#implementAfterTurn;
      this.#implementAfterTurn = null;
      if (impl) {
        this.#mode = "acceptEdits";
        this.#snap.mode = "acceptEdits";
        if (impl.fresh) {
          await this.#doCompact(
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
        chained = true;
        this.#kickTurn();
        return;
      }

      // A message injected past the last `prepareStep` folds into this same
      // turn — continue it rather than emitting a `result` and flapping idle.
      if (!this.#oneShot && this.#flushInjections().length > 0) {
        chained = true;
        this.#kickTurn();
        return;
      }

      this.#snap.turns += 1;
      this.#emit({ type: "result", sessionId: this.id, ts: Date.now(), ok: true });
      this.#snap.status = "idle";
      if (this.#oneShot) this.#outbox.close();
    } catch (err) {
      this.#snap.status = "error";
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
