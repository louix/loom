/**
 * The aisdk adapter — one `AgentProvider` per configured `[providers.<id>]`
 * profile (`adapter = "aisdk"`). Wraps `@ai-sdk/openai-compatible` so any
 * OpenAI-compatible endpoint (OpenAI, GLM, DeepSeek, OpenRouter, vLLM, Ollama)
 * fits the seam. Loom persists the transcript itself — see {@link ProviderMessageStore}.
 *
 * M10a: streaming text + usage + cost + cancel + resume. No tools, no
 * compaction, no plan review — those are M10b–d.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel, ModelMessage } from "ai";
import type {
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  ProviderCapabilities,
  SessionRef,
} from "../types.ts";
import { AisdkSession } from "./session.ts";
import type { ProviderMessageStore } from "./store.ts";

export interface AisdkProviderOptions {
  /** The `[providers.<id>]` table name — also this provider's `id`. */
  id: string;
  baseUrl: string;
  /** Resolved bearer token ("" for a keyless local endpoint). */
  apiKey: string;
  /** Default model id for new sessions. */
  model: string;
  /** Model ids offered in the picker (M10e). */
  models: string[];
  /** Test seam: bypass `createOpenAICompatible` and resolve model ids directly. */
  makeModel?: (id: string) => LanguageModel;
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
    this.capabilities = {
      liveModeSwitch: false, // a model / mode change takes effect on the next turn
      forking: false,
      subagents: false, // M10d
      compaction: false, // Loom rebuilds history (M10d), not the provider
      oneShot: true,
      partialTokens: true,
      permissionModes: ["default", "plan", "acceptEdits", "auto"],
      models: opts.models,
    };

    if (opts.makeModel) {
      this.#makeModel = opts.makeModel;
    } else {
      const provider = createOpenAICompatible({
        name: opts.id,
        baseURL: opts.baseUrl,
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      });
      this.#makeModel = (id) => provider(id);
    }
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
      mcpHandles: [],
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
