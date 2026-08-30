/**
 * The shared Vercel-AI-SDK provider — one `AgentProvider` over any `@ai-sdk/*`
 * backend. It is SDK-agnostic: a connector package (`@loom/connector-generic`,
 * `@loom/connector-gemini`) supplies `makeModel`, the one `(id) => LanguageModel`
 * factory built from its own `@ai-sdk/*` import. Loom persists the transcript
 * itself — see {@link TranscriptStore}.
 */
import type { LanguageModel, ModelMessage } from "ai";
import type { SearchConfig } from "@loom/core/connector";
import type { TranscriptStore } from "@loom/core/transcript";
import type {
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  ProviderCapabilities,
  SessionRef,
} from "@loom/core/types";
import { AisdkSession } from "./session.ts";

export interface AisdkProviderOptions {
  /** The provider id this instance serves. */
  id: string;
  /** Default model id for new sessions. */
  model: string;
  /** Model ids offered in the picker (M10e). */
  models: string[];
  /** Per-segment step ceiling for turns (`max_steps`); undefined → session default. */
  maxSteps?: number;
  /** Resolve a model id to a live model — from {@link resolveModelFactory}, or a test stub. */
  makeModel: (id: string) => LanguageModel;
  /** Resolved `web_search` config, when a backend + key are set. */
  search?: SearchConfig;
}

export class AisdkProvider implements AgentProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;

  readonly #defaultModel: string;
  readonly #store: TranscriptStore;
  readonly #makeModel: (id: string) => LanguageModel;
  readonly #search: SearchConfig | undefined;
  readonly #maxSteps: number | undefined;

  constructor(opts: AisdkProviderOptions, store: TranscriptStore) {
    this.id = opts.id;
    this.#defaultModel = opts.model;
    this.#store = store;
    this.#makeModel = opts.makeModel;
    this.#search = opts.search;
    this.#maxSteps = opts.maxSteps;
    this.capabilities = {
      liveModeSwitch: false, // a model / mode change takes effect on the next turn
      forking: false,
      rewind: true, // Loom owns the ModelMessage[] — slicing it is exact
      subagents: true, // the `task` tool spawns a depth-1 sub-agent
      compaction: false, // Loom summarises + rebuilds history; not the provider's own /compact
      oneShot: true,
      partialTokens: true,
      permissionModes: ["default", "plan", "acceptEdits", "auto"],
      models: opts.models,
    };
  }

  async createSession(opts: CreateSessionOptions): Promise<AgentSession> {
    const modelId = opts.model || this.#defaultModel;
    const messages: ModelMessage[] = opts.prompt ? [{ role: "user", content: opts.prompt }] : [];

    if (opts.oneShot) {
      const s = new AisdkSession({
        sessionId: opts.sessionId,
        modelId,
        makeModel: this.#makeModel,
        system: opts.systemPromptAppend,
        messages,
        mode: opts.mode,
        cwd: opts.cwd,
        mcpHandles: [],
        loomServer: false,
        store: null,
        oneShot: true,
      });
      s.start(true);
      return s;
    }

    if (messages.length > 0) this.#store.append(opts.sessionId, messages);
    const s = new AisdkSession({
      sessionId: opts.sessionId,
      modelId,
      makeModel: this.#makeModel,
      system: opts.systemPromptAppend,
      messages,
      mode: opts.mode,
      cwd: opts.cwd,
      mcpHandles: opts.mcpServers,
      loomServer: opts.loomServer ?? false,
      ...(this.#search ? { search: this.#search } : {}),
      ...(this.#maxSteps != null ? { maxSteps: this.#maxSteps } : {}),
      store: this.#store,
      oneShot: false,
    });
    s.start(true);
    return s;
  }

  async resumeSession(ref: SessionRef): Promise<AgentSession> {
    // The transcript rows are opaque JSON to `@loom/core`; here they are the
    // `ModelMessage[]` this connector wrote — an unavoidable store boundary cast.
    const loaded = this.#store.load(ref.sessionId) as ModelMessage[];
    const messages = dropDanglingToolCalls(loaded);
    if (messages.length !== loaded.length) {
      this.#store.replaceFrom(ref.sessionId, messages.length, []);
    }
    const s = new AisdkSession({
      sessionId: ref.sessionId,
      modelId: ref.model || this.#defaultModel,
      makeModel: this.#makeModel,
      system: undefined,
      messages,
      mode: ref.mode ?? "default",
      cwd: ref.cwd,
      mcpHandles: ref.mcpServers ?? [],
      loomServer: true,
      ...(this.#search ? { search: this.#search } : {}),
      ...(this.#maxSteps != null ? { maxSteps: this.#maxSteps } : {}),
      store: this.#store,
      oneShot: false,
    });
    s.start(false); // wait for the next real turn via send()
    return s;
  }

  async listPersistedSessions(): Promise<SessionRef[]> {
    return [];
  }
}

/**
 * Construct an aisdk provider. A connector calls this with the `makeModel`
 * factory it built from its own `@ai-sdk/*` import and the daemon's transcript
 * store.
 */
export function makeAisdkProvider(opts: AisdkProviderOptions, store: TranscriptStore): AisdkProvider {
  return new AisdkProvider(opts, store);
}

/**
 * A turn that was killed mid-tool (daemon restart while a permission was
 * pending) leaves an assistant message whose `tool-call` parts have no matching
 * `tool-result` — most endpoints 400 on the next request. Drop that trailing
 * assistant message (and anything after it) so the resumed session is valid and
 * a fresh `send` re-runs from the last real user turn.
 */
export function dropDanglingToolCalls(messages: ModelMessage[]): ModelMessage[] {
  const partsOf = (m: ModelMessage | undefined): Array<{ type?: string; toolCallId?: string }> =>
    Array.isArray(m?.content) ? (m.content as Array<{ type?: string; toolCallId?: string }>) : [];

  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant === -1) return messages;

  const callIds = partsOf(messages[lastAssistant])
    .filter((p) => p.type === "tool-call" && typeof p.toolCallId === "string")
    .map((p) => p.toolCallId as string);
  if (callIds.length === 0) return messages;

  const answered = new Set<string>();
  for (let i = lastAssistant + 1; i < messages.length; i++) {
    for (const p of partsOf(messages[i])) {
      if (p.type === "tool-result" && typeof p.toolCallId === "string") answered.add(p.toolCallId);
    }
  }
  return callIds.every((id) => answered.has(id)) ? messages : messages.slice(0, lastAssistant);
}
