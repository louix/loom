/** ChatGPT subscription connector, authenticated by Codex's ~/.codex/auth.json. */
import type {
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  DiscoveredModel,
  SessionRef,
} from "@loom/core/types";
import type { ConnectorContext } from "@loom/core/connector";
import { loomInstructions } from "@loom/core/paths";
import { toolSteer } from "@loom/runtime/instructions";
import { makeAisdkProvider } from "@loom/aisdk/provider";
import { createChatGPTModels } from "./oauth.ts";
import { CodexAppServerSession } from "./app-server.ts";
import { resolveCodexHome, type CodexHome } from "./codex-home.ts";
import { discoverCodexModels } from "./discovery.ts";

/**
 * Code Mode sessions mount only `commit` (via `CodexAppServerSession`'s own
 * `loom-mcp-server.mjs`, when `loomServer` is on) — never `ask_user`/`status`.
 * The daemon's `systemPromptAppend` is written assuming the full Claude/aisdk
 * loom tool set, so it would tell the model about tools that don't exist here;
 * recompute the tool-steer for what's actually mounted instead of forwarding
 * it verbatim. Skips the daemon's repoRoot-fallback LOOM.md lookup (Code Mode
 * only has the worktree's own `cwd`), a narrow, acceptable gap versus a fully
 * plumbed-through repo root.
 */
export const codeModeInstructions = (cwd: string, mountsCommit: boolean): string =>
  [toolSteer(cwd, { askUser: false, commit: mountsCommit, status: false }), loomInstructions(cwd)]
    .filter((part): part is string => part !== null && part.length > 0)
    .join("\n\n");

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
  readonly #codexHome: CodexHome;
  readonly #codexCliPath: string;
  readonly #search: ConnectorContext["search"];
  readonly #codexBuiltinWebSearch: boolean;

  constructor(
    id: string,
    direct: AgentProvider,
    isCodeMode: (model: string) => Promise<boolean>,
    codexHome: CodexHome,
    codexCliPath: string,
    search?: ConnectorContext["search"],
    codexBuiltinWebSearch = true,
  ) {
    this.id = id;
    this.#direct = direct;
    this.#isCodeMode = isCodeMode;
    this.#codexHome = codexHome;
    this.#codexCliPath = codexCliPath;
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
      { ...opts, systemPromptAppend: codeModeInstructions(opts.cwd, opts.loomServer === true) },
      this.#codexHome,
      this.#codexCliPath,
      this.#search,
      this.#codexBuiltinWebSearch,
    );
  }
  async resumeSession(ref: SessionRef): Promise<AgentSession> {
    if (!(await this.#isCodeMode(ref.model ?? ""))) return this.#direct.resumeSession(ref);
    return CodexAppServerSession.resume(
      // Code Mode's own `resume()` always mounts the commit-only loom server
      // (its internal `opts.loomServer` is hardcoded `true`), independent of
      // whatever `ref` carries — `SessionRef` has no `loomServer` field.
      { ...ref, systemPromptAppend: codeModeInstructions(ref.cwd, true) },
      this.#codexHome,
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
  const codexHome = resolveCodexHome({
    ...(ctx.config.configDir ? { configDir: ctx.config.configDir } : {}),
    ...(ctx.config.authPath ? { authPath: ctx.config.authPath } : {}),
  });
  const codexCliPath = ctx.config.codexCliPath || "codex";
  const { catalog, makeModel } = createChatGPTModels({
    codexHome,
    ...(ctx.config.baseUrl ? { baseUrl: ctx.config.baseUrl } : {}),
  });
  // A curated `models` list restricts the picker to exactly those ids
  // (available even if the account marks them hidden); otherwise the picker
  // gets the account's own visible/default set.
  const restrictTo = ctx.config.models?.length ? new Set(ctx.config.models) : undefined;
  const listModels = async (): Promise<DiscoveredModel[]> => {
    // Reasoning-effort discovery goes through app-server (Phase 2); context
    // window sizes still come from the REST catalog, which is the only one of
    // the two that reports them — a config `model_context` pin wins over both.
    const [discovered, restCatalog] = await Promise.all([
      discoverCodexModels({ cliPath: codexCliPath, codexHome }),
      catalog.list(),
    ]);
    const contextById = new Map(
      restCatalog.map((m) => [m.slug, m.max_context_window ?? m.context_window] as const),
    );
    return discovered
      .filter((m) => (restrictTo ? restrictTo.has(m.id) : !m.hidden))
      .map(({ hidden: _hidden, ...model }) => {
        const context = ctx.config.modelContext?.[model.id] ?? contextById.get(model.id);
        return { ...model, ...(context ? { context } : {}) };
      });
  };
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
    codexHome,
    codexCliPath,
    ctx.search,
    ctx.config.codexBuiltinWebSearch,
  );
};
