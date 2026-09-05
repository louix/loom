/** ChatGPT subscription connector, authenticated by Codex's ~/.codex/auth.json. */
import type {
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  DiscoveredModel,
  SessionRef,
} from "@loom/core/types";
import type { ConnectorContext } from "@loom/core/connector";
import { makeAisdkProvider } from "@loom/aisdk/provider";
import { createChatGPTModels } from "./oauth.ts";
import { CodexAppServerSession } from "./app-server.ts";

/**
 * ChatGPT's catalog has two tool protocols. Keep the AI SDK adapter for
 * regular Responses function tools, and route Code Mode-only models through
 * Codex's local app-server so they get Codex's full local host instead.
 */
class ChatGPTProvider implements AgentProvider {
  readonly id: string;
  readonly capabilities;
  readonly #direct: AgentProvider;
  readonly #isCodeMode: (model: string) => Promise<boolean>;
  readonly #codexCliPath: string;
  readonly #search: ConnectorContext["search"];
  readonly #codexBuiltinWebSearch: boolean;

  constructor(
    id: string,
    direct: AgentProvider,
    isCodeMode: (model: string) => Promise<boolean>,
    codexCliPath?: string,
    search?: ConnectorContext["search"],
    codexBuiltinWebSearch = true,
  ) {
    this.id = id;
    this.#direct = direct;
    this.#isCodeMode = isCodeMode;
    this.#codexCliPath = codexCliPath || "codex";
    this.#search = search;
    this.#codexBuiltinWebSearch = codexBuiltinWebSearch;
    // Conservative provider-level defaults: this one provider id spans a
    // transcript-owning aisdk backend and a thread-owning Code Mode backend
    // (see `#isCodeMode`), and there's no per-session signal yet to report
    // these more precisely for whichever one a given session actually runs on
    // (Phase 4 adds a persisted backend discriminator for that).
    this.capabilities = {
      ...direct.capabilities,
      liveModeSwitch: true,
      liveModelSwitch: false,
      forking: false,
      rewind: false,
      compaction: true,
      ownsTranscript: false,
    };
  }

  async createSession(opts: CreateSessionOptions): Promise<AgentSession> {
    if (opts.oneShot || !(await this.#isCodeMode(opts.model ?? "")))
      return this.#direct.createSession(opts);
    return CodexAppServerSession.start(
      opts,
      this.#codexCliPath,
      this.#search,
      this.#codexBuiltinWebSearch,
    );
  }
  async resumeSession(ref: SessionRef): Promise<AgentSession> {
    if (!(await this.#isCodeMode(ref.model ?? ""))) return this.#direct.resumeSession(ref);
    return CodexAppServerSession.resume(
      ref,
      this.#codexCliPath,
      this.#search,
      this.#codexBuiltinWebSearch,
    );
  }
  listPersistedSessions(): Promise<SessionRef[]> {
    return this.#direct.listPersistedSessions();
  }
  listModels(): Promise<DiscoveredModel[]> {
    return this.#direct.listModels?.() ?? Promise.resolve([]);
  }
}

export const createProvider = async (ctx: ConnectorContext): Promise<AgentProvider> => {
  if (!ctx.transcript)
    throw new Error(`connector ${JSON.stringify(ctx.id)} needs a transcript store`);
  const { catalog, makeModel } = createChatGPTModels({
    ...(ctx.config.authPath ? { authPath: ctx.config.authPath } : {}),
    ...(ctx.config.baseUrl ? { baseUrl: ctx.config.baseUrl } : {}),
  });
  const listModels = async (): Promise<DiscoveredModel[]> =>
    // Match Codex's picker: it has the full account catalog available for an
    // explicit model id, but offers only `visibility: list` models, ordered by
    // backend priority, as automatic choices.
    (await catalog.list())
      .filter((model) => model.visibility === "list")
      .sort(
        (a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
      )
      .map((model) => ({
        id: model.slug,
        ...(model.display_name ? { label: model.display_name } : {}),
        // The Codex catalog's `context_window` is its conservative operating
        // default (272k today); `max_context_window` is the account/model cap.
        // Loom needs the latter for its context meter and compaction guard.
        ...((model.max_context_window ?? model.context_window)
          ? { context: model.max_context_window ?? model.context_window }
          : {}),
        ...(model.supported_reasoning_levels?.length
          ? {
              supportsEffort: true,
              effortLevels: model.supported_reasoning_levels
                .map((level) => level.effort)
                .filter((level): level is string => typeof level === "string"),
              ...(model.default_reasoning_level
                ? { defaultEffort: model.default_reasoning_level }
                : {}),
            }
          : {}),
      }));
  const direct = makeAisdkProvider(
    {
      id: ctx.id,
      model: ctx.config.model ?? "",
      models: ctx.config.models ?? [],
      ...(ctx.config.modelContext ? { modelContext: ctx.config.modelContext } : {}),
      ...(ctx.config.maxSteps !== undefined ? { maxSteps: ctx.config.maxSteps } : {}),
      providerOptionsName: "chatgpt",
      makeModel,
      toolMode: async (model) =>
        (await catalog.get(model)).tool_mode === "code_mode_only" ? "codex-shell" : "full",
      subagents: true,
      listModels,
    },
    ctx.transcript,
  );
  return new ChatGPTProvider(
    ctx.id,
    direct,
    async (model) => (await catalog.get(model)).tool_mode === "code_mode_only",
    ctx.config.codexCliPath,
    ctx.search,
    ctx.config.codexBuiltinWebSearch,
  );
};
