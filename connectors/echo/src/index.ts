import { AsyncChannel } from "@loom/core/channel";
import type { ConnectorContext } from "@loom/core/connector";
import type { HarnessEvent } from "@loom/core/events";
import { stateIdle } from "@loom/core/session-state";
import type {
  AdapterSnapshot,
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  EffortLevel,
  ProviderCapabilities,
  SessionMode,
  SessionRef,
} from "@loom/core/types";

const capabilities: ProviderCapabilities = {
  liveModeSwitch: true,
  liveModelSwitch: false,
  forking: false,
  rewind: false,
  subagents: false,
  compaction: false,
  compactionInstructions: false,
  ownsTranscript: false,
  oneShot: true,
  partialTokens: false,
  permissionModes: ["default", "plan", "acceptEdits", "auto"],
  models: ["echo"],
};

class EchoSession implements AgentSession {
  readonly id: string;
  readonly providerRef: string;
  readonly #events = new AsyncChannel<HarnessEvent>();
  readonly #snapshot: AdapterSnapshot;

  constructor(id: string, mode: SessionMode) {
    this.id = id;
    this.providerRef = `echo-${id}`;
    this.#snapshot = {
      status: stateIdle,
      providerRef: this.providerRef,
      model: "echo",
      mode,
      effort: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextUsed: 0,
      contextLimit: 0,
      costUsd: 0,
      turns: 0,
    };
  }

  events(): AsyncIterable<HarnessEvent> {
    return this.#events;
  }

  async send(input: string): Promise<void> {
    if (this.#events.closed) throw new Error("Echo session is closed");
    const base = { sessionId: this.id, ts: Date.now() };
    const text = `Echo: ${input}`;
    // No background work: each send queues a complete turn, in order.
    this.#snapshot.turns++;
    this.#events.push({ ...base, type: "assistant_text", text });
    this.#events.push({
      ...base,
      type: "usage",
      tokens: { ...this.#snapshot.usage },
      costDeltaUsd: 0,
      contextUsed: 0,
      contextLimit: 0,
    });
    this.#events.push({ ...base, type: "result", kind: "ok", summary: text });
  }

  snapshot(): AdapterSnapshot {
    return { ...this.#snapshot, usage: { ...this.#snapshot.usage } };
  }
  async setMode(mode: SessionMode): Promise<void> {
    this.#snapshot.mode = mode;
  }
  async setModel(model: string): Promise<void> {
    if (model !== "echo") throw new Error("Echo only supports the echo model");
  }
  async setEffort(_effort: EffortLevel): Promise<void> {}
  async interrupt(): Promise<void> {} // Turns complete synchronously; nothing remains to cancel.
  async close(): Promise<void> {
    this.#events.close();
  }

  async compact(): Promise<void> {
    throw new Error("Echo does not support compaction");
  }
  async rewind(): Promise<void> {
    throw new Error("Echo does not support rewind");
  }
  async respondToPermission(): Promise<void> {
    throw new Error("Echo has no permission requests");
  }
  async answerQuestion(): Promise<void> {
    throw new Error("Echo has no pending questions");
  }
  async respondToPlan(): Promise<void> {
    throw new Error("Echo has no pending plans");
  }
}

/** Minimal connector: no SDK, network, credentials, or provider-side persistence. */
export const createProvider = (ctx: ConnectorContext): AgentProvider => ({
  id: ctx.id,
  capabilities,
  async createSession(opts: CreateSessionOptions) {
    const session = new EchoSession(opts.sessionId, opts.mode);
    await session.send(opts.prompt);
    if (opts.oneShot) await session.close();
    return session;
  },
  async resumeSession(ref: SessionRef) {
    // Echo is stateless; Loom retains the displayed conversation history.
    return new EchoSession(ref.sessionId, ref.mode ?? "default");
  },
  async listPersistedSessions() {
    return [];
  },
});
