/**
 * An `AgentSession` over an OpenAI-compatible model. Loom owns everything the
 * Claude CLI would otherwise own: the `ModelMessage[]`, its persistence, and
 * per-turn lifecycle. `events()` is a single channel that stays open across
 * turns and closes only on `close()`.
 *
 * M10a scope: single tool-free step per turn, no compaction, no plan review.
 * Those arrive in M10b–d.
 */
import type { LanguageModel, ModelMessage } from "ai";
import type { HarnessEvent } from "../../protocol/events.ts";
import { AsyncChannel } from "../../util/channel.ts";
import type {
  AdapterSnapshot,
  AgentSession,
  PermissionDecision,
  PlanDecision,
  SessionMode,
  UserInput,
} from "../types.ts";
import { AisdkEventMapper } from "./map.ts";
import { runTurn } from "./loop.ts";
import type { ProviderMessageStore } from "./store.ts";
import { contextLimitFor } from "./tokens.ts";

const MAX_STEPS_M10A = 1;

export interface AisdkSessionOptions {
  sessionId: string;
  modelId: string;
  /** Resolve a model id (from config / `setModel`) to a live model. */
  makeModel: (id: string) => LanguageModel;
  system: string | undefined;
  messages: ModelMessage[];
  mode: SessionMode;
  /** null for a throwaway one-shot. */
  store: ProviderMessageStore | null;
  /** A one-shot ends its stream after the first turn (titling). */
  oneShot: boolean;
}

export class AisdkSession implements AgentSession {
  readonly id: string;

  #modelId: string;
  #model: LanguageModel;
  readonly #makeModel: (id: string) => LanguageModel;
  readonly #system: string | undefined;
  #mode: SessionMode;
  readonly #store: ProviderMessageStore | null;
  readonly #oneShot: boolean;

  readonly #messages: ModelMessage[];
  readonly #outbox = new AsyncChannel<HarnessEvent>();
  readonly #mapper: AisdkEventMapper;
  #abort: AbortController | null = null;
  #turn: Promise<void> | null = null;
  #closing = false;
  #snap: AdapterSnapshot;

  constructor(opts: AisdkSessionOptions) {
    this.id = opts.sessionId;
    this.#modelId = opts.modelId;
    this.#makeModel = opts.makeModel;
    this.#model = opts.makeModel(opts.modelId);
    this.#system = opts.system;
    this.#mode = opts.mode;
    this.#store = opts.store;
    this.#oneShot = opts.oneShot;
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

  async respondToPermission(_id: string, _decision: PermissionDecision): Promise<void> {
    // No tools in M10a — nothing is ever pending.
  }

  async answerQuestion(_id: string, _text: string): Promise<void> {
    // No `ask_user` tool in M10a.
  }

  async respondToPlan(_id: string, _decision: PlanDecision): Promise<void> {
    // No plan review in M10a.
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

  async #runTurn(): Promise<void> {
    if (this.#closing) return;
    const abort = new AbortController();
    this.#abort = abort;
    this.#snap.status = "running";

    const { aborted, errored } = await runTurn({
      sessionId: this.id,
      model: this.#model,
      system: this.#system,
      messages: this.#messages,
      maxSteps: MAX_STEPS_M10A,
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
