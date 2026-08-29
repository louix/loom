/**
 * The aisdk adapter — one `AgentProvider` per configured `[providers.<id>]`
 * profile (`adapter = "aisdk"`). One session class over any Vercel AI SDK
 * backend; {@link resolveModelFactory} picks `@ai-sdk/openai-compatible`,
 * `@ai-sdk/google`, or `@ai-sdk/anthropic` from the profile's `sdk`. Loom
 * persists the transcript itself — see {@link ProviderMessageStore}.
 */
import type { LanguageModel, ModelMessage } from "ai";
import type { AisdkKind } from "../../config/config.ts";
import type {
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  ProviderCapabilities,
  SessionRef,
} from "../types.ts";
import { AisdkSession } from "./session.ts";
import type { ProviderMessageStore } from "./store.ts";

/**
 * Build a `(modelId) => LanguageModel` for a profile, dynamically importing
 * only the one `@ai-sdk/*` package its `sdk` needs — so a daemon that never
 * uses Gemini never evaluates `@ai-sdk/google` (and its dependency avalanche).
 */
export async function resolveModelFactory(
  sdk: AisdkKind,
  opts: { id: string; baseUrl: string; apiKey: string },
): Promise<(modelId: string) => LanguageModel> {
  const key = opts.apiKey ? { apiKey: opts.apiKey } : {};
  if (sdk === "google") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const g = createGoogleGenerativeAI({ ...key, ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}) });
    return (id) => g(id);
  }
  if (sdk === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const a = createAnthropic({ ...key, ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}) });
    return (id) => a(id);
  }
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const p = createOpenAICompatible({ name: opts.id, baseURL: opts.baseUrl, ...key });
  return (id) => p(id);
}

export interface AisdkProviderOptions {
  /** The `[providers.<id>]` table name — also this provider's `id`. */
  id: string;
  /** Default model id for new sessions. */
  model: string;
  /** Model ids offered in the picker (M10e). */
  models: string[];
  /** Resolve a model id to a live model — from {@link resolveModelFactory}, or a test stub. */
  makeModel: (id: string) => LanguageModel;
}

export class AisdkProvider implements AgentProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;

  readonly #defaultModel: string;
  readonly #store: ProviderMessageStore;
  readonly #makeModel: (id: string) => LanguageModel;

  constructor(opts: AisdkProviderOptions, store: ProviderMessageStore) {
    this.id = opts.id;
    this.#defaultModel = opts.model;
    this.#store = store;
    this.#makeModel = opts.makeModel;
    this.capabilities = {
      liveModeSwitch: false, // a model / mode change takes effect on the next turn
      forking: false,
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
      store: this.#store,
      oneShot: false,
    });
    s.start(true);
    return s;
  }

  async resumeSession(ref: SessionRef): Promise<AgentSession> {
    const messages = this.#store.load(ref.sessionId);
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
