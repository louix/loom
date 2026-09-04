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
  DiscoveredModel,
  ProviderCapabilities,
  SessionRef,
} from "@loom/core/types";
import { AisdkSession } from "./session.ts";
import { dropDanglingToolCalls } from "./transcript.ts";

export { dropDanglingToolCalls, repairMalformedToolInputs } from "./transcript.ts";

export interface AisdkProviderOptions {
  /** The provider id this instance serves. */
  id: string;
  /** Default model id for new sessions. */
  model: string;
  /** Model ids offered in the picker (M10e). */
  models: string[];
  /**
   * Known per-model context-window sizes in tokens — endpoint-reported
   * (`/models` metadata) or `model_context` config pins. Sessions prefer them
   * over the built-in prefix table.
   */
  modelContext?: Record<string, number>;
  /** Per-segment step ceiling for turns (`max_steps`); undefined → session default. */
  maxSteps?: number;
  /**
   * The `providerOptions` key the `@ai-sdk/*` provider reads its options under —
   * for `@ai-sdk/openai-compatible`, the name given to `createOpenAICompatible`
   * (the connector's id). A chosen reasoning effort rides to the request as
   * `reasoning_effort` under it. Omitted → effort is accepted but never sent.
   */
  providerOptionsName?: string;
  /**
   * Ask for a prompt-cache breakpoint on every request, as
   * `providerOptions.anthropic.cacheControl`. Native-Anthropic sessions only:
   * `@ai-sdk/anthropic` sets none by default, so without it the whole history
   * is re-read at full input price every turn. Omitted → no breakpoint.
   */
  cacheControl?: { type: "ephemeral"; ttl?: "5m" | "1h" };
  /** Resolve a model id to a live model — from {@link resolveModelFactory}, or a test stub. */
  makeModel: (id: string) => LanguageModel;
  /** Resolved `web_search` config, when a backend + key are set. */
  search?: SearchConfig;
  /** The repo's base branch, for the `status` tool's ahead/behind counts. */
  base?: string;
  /**
   * Tool surface the backend accepts. Codex's subscription endpoint only
   * accepts its predefined shell tool, unlike normal AI SDK backends.
   */
  toolMode?: "full" | "codex-shell" | ((model: string) => Promise<"full" | "codex-shell">);
  /** Whether Loom should advertise its `task` sub-agent capability. */
  subagents?: boolean;
  /** Optional authenticated catalog, e.g. Codex's subscription `/models` endpoint. */
  listModels?: () => Promise<DiscoveredModel[]>;
}

export class AisdkProvider implements AgentProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;

  readonly #defaultModel: string;
  readonly #store: TranscriptStore;
  readonly #makeModel: (id: string) => LanguageModel;
  readonly #search: SearchConfig | undefined;
  readonly #base: string | undefined;
  readonly #maxSteps: number | undefined;
  readonly #modelContext: Record<string, number> | undefined;
  readonly #providerOptionsName: string | undefined;
  readonly #cacheControl: AisdkProviderOptions["cacheControl"];
  readonly #toolMode: (model: string) => Promise<"full" | "codex-shell">;
  readonly #listModels: (() => Promise<DiscoveredModel[]>) | undefined;

  constructor(opts: AisdkProviderOptions, store: TranscriptStore) {
    this.id = opts.id;
    this.#defaultModel = opts.model;
    this.#store = store;
    this.#makeModel = opts.makeModel;
    this.#search = opts.search;
    this.#base = opts.base;
    this.#maxSteps = opts.maxSteps;
    this.#modelContext = opts.modelContext;
    this.#providerOptionsName = opts.providerOptionsName;
    this.#cacheControl = opts.cacheControl;
    const configuredToolMode = opts.toolMode;
    this.#toolMode =
      typeof configuredToolMode === "function"
        ? configuredToolMode
        : async () => configuredToolMode ?? "full";
    this.#listModels = opts.listModels;
    this.capabilities = {
      liveModeSwitch: false, // a model / mode change takes effect on the next turn
      forking: false,
      rewind: true, // Loom owns the ModelMessage[] — slicing it is exact
      subagents: opts.subagents ?? true, // the `task` tool spawns a depth-1 sub-agent
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
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(this.#providerOptionsName ? { providerOptionsName: this.#providerOptionsName } : {}),
        ...(this.#cacheControl ? { cacheControl: this.#cacheControl } : {}),
        ...(this.#modelContext ? { modelContext: this.#modelContext } : {}),
        makeModel: this.#makeModel,
        system: opts.systemPromptAppend,
        messages,
        mode: opts.mode,
        cwd: opts.cwd,
        mcpHandles: [],
        loomServer: false,
        toolMode: await this.#toolMode(modelId),
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
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(this.#providerOptionsName ? { providerOptionsName: this.#providerOptionsName } : {}),
      ...(this.#cacheControl ? { cacheControl: this.#cacheControl } : {}),
      ...(this.#modelContext ? { modelContext: this.#modelContext } : {}),
      makeModel: this.#makeModel,
      system: opts.systemPromptAppend,
      messages,
      mode: opts.mode,
      cwd: opts.cwd,
      mcpHandles: opts.mcpServers,
      loomServer: opts.loomServer ?? false,
      toolMode: await this.#toolMode(modelId),
      ...(this.#base ? { base: this.#base } : {}),
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
      ...(ref.effort ? { effort: ref.effort } : {}),
      ...(this.#providerOptionsName ? { providerOptionsName: this.#providerOptionsName } : {}),
      ...(this.#cacheControl ? { cacheControl: this.#cacheControl } : {}),
      ...(this.#modelContext ? { modelContext: this.#modelContext } : {}),
      makeModel: this.#makeModel,
      system: undefined,
      messages,
      mode: ref.mode ?? "default",
      cwd: ref.cwd,
      mcpHandles: ref.mcpServers ?? [],
      loomServer: true,
      toolMode: await this.#toolMode(ref.model || this.#defaultModel),
      ...(this.#base ? { base: this.#base } : {}),
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

  async listModels(): Promise<DiscoveredModel[]> {
    return (await this.#listModels?.()) ?? [];
  }
}

/**
 * Construct an aisdk provider. A connector calls this with the `makeModel`
 * factory it built from its own `@ai-sdk/*` import and the daemon's transcript
 * store.
 */
export const makeAisdkProvider = (
  opts: AisdkProviderOptions,
  store: TranscriptStore,
): AisdkProvider => {
  return new AisdkProvider(opts, store);
};
