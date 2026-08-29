/**
 * An `AgentSession` over an OpenAI-compatible model. Loom owns everything the
 * Claude CLI would otherwise own: the `ModelMessage[]`, its persistence, tool
 * wiring, the permission gate, and per-turn lifecycle. `events()` is a single
 * channel that stays open across turns and closes only on `close()`.
 *
 * M10b: multi-step turns with MCP + `loom` tools, each routed through the
 * permission gate. Still no compaction, plan review, or sub-agents (M10d).
 */
import { randomUUID } from "node:crypto";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
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
import { wrapToolSet } from "./gate.ts";
import type { ProviderMessageStore } from "./store.ts";
import { contextLimitFor } from "./tokens.ts";

/** Hard ceiling on tool round-trips within one turn. */
const MAX_STEPS = 24;

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
  /** Mount the `loom` tools (ask_user, commit). */
  loomServer: boolean;
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
  #closing = false;
  #snap: AdapterSnapshot;

  #hub: McpHub | null = null;
  #toolsPromise: Promise<ToolSet> | null = null;
  readonly #pendingPerms = new Map<string, (d: { allow: boolean; message?: string }) => void>();
  readonly #pendingQuestions = new Map<string, (answer: string) => void>();

  constructor(opts: AisdkSessionOptions) {
    this.id = opts.sessionId;
    this.#modelId = opts.modelId;
    this.#makeModel = opts.makeModel;
    this.#model = opts.makeModel(opts.modelId);
    this.#system = opts.system;
    this.#mode = opts.mode;
    this.#cwd = opts.cwd;
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
      this.#turn = this.#runTurn();
    } else {
      this.#snap.status = "idle";
    }
  }

  get providerRef(): string {
    return this.id;
  }

  events(): AsyncIterable<HarnessEvent> {
    return this.#outbox;
  }

  async send(input: UserInput): Promise<void> {
    if (this.#closing) throw new Error("session is closing");
    await this.#turn?.catch(() => {});
    const msg: ModelMessage = { role: "user", content: input };
    this.#messages.push(msg);
    this.#store?.append(this.id, [msg]);
    this.#turn = this.#runTurn();
  }

  async compact(_instructions?: string): Promise<void> {
    throw new Error("compaction for the aisdk provider lands in milestone 10d");
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

  async respondToPlan(_id: string, _decision: PlanDecision): Promise<void> {
    // No plan review until M10d.
  }

  async interrupt(): Promise<void> {
    this.#abort?.abort();
    await this.#turn?.catch(() => {});
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

  /** Connect MCP servers + assemble the gated tool set. Memoized. */
  #ensureTools(): Promise<ToolSet> {
    if (!this.#toolsPromise) {
      this.#toolsPromise = (async () => {
        const base: ToolSet = {};
        if (this.#mcpHandles.length > 0) {
          this.#hub = await McpHub.connect(this.#mcpHandles, this.#log);
          Object.assign(base, this.#hub.tools);
        }
        if (this.#loomServer) {
          Object.assign(
            base,
            buildLoomTools({
              cwd: this.#cwd,
              askUser: (q, c) => this.#askUser(q, c),
            }),
          );
        }
        return wrapToolSet(base, {
          mode: () => this.#mode,
          ask: (name, input, toolCallId) => this.#requestPermission(name, input, toolCallId),
        });
      })();
    }
    return this.#toolsPromise;
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

  async #runTurn(): Promise<void> {
    if (this.#closing) return;
    const tools = await this.#ensureTools();
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
      hooks: {
        emit: (ev) => this.#emit(ev),
        appendMessages: (msgs) => {
          this.#messages.push(...msgs);
          this.#store?.append(this.id, msgs);
        },
      },
    });

    this.#abort = null;

    if (!aborted && !errored) {
      this.#snap.turns += 1;
      this.#snap.status = "idle";
      this.#emit({ type: "result", sessionId: this.id, ts: Date.now(), ok: true });
    } else {
      this.#snap.status = aborted ? "interrupted" : "error";
    }

    if (this.#oneShot) this.#outbox.close();
  }
}
