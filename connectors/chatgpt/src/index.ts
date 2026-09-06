/** ChatGPT subscription connector, authenticated by Codex's ~/.codex/auth.json. */
import type {
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  DiscoveredModel,
  ProviderCapabilities,
  SessionRef,
} from "@loom/core/types";
import type { ConnectorContext } from "@loom/core/connector";
import { loomInstructions } from "@loom/core/paths";
import { toolSteer } from "@loom/runtime/instructions";
import { ChatGPTCatalog } from "./catalog.ts";
import { CodexAppServerSession } from "./app-server.ts";
import { resolveCodexHome, type CodexHome } from "./codex-home.ts";
import { discoverCodexModels } from "./discovery.ts";

/** Model context-window enrichment is best-effort (see `listModels` below) —
 *  bound the *whole* operation explicitly, not just whatever internal timeout
 *  `ChatGPTCatalog` happens to use for its own network call — a credential
 *  read or a slow network hanging inside it must not stall model discovery
 *  indefinitely. */
const CATALOG_TIMEOUT_MS = 8_000;
const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      t.unref?.();
    }),
  ]);

/**
 * The dynamic tools `CodexAppServerSession` mounts (`commit`/`status`, see
 * `app-server.ts`) are a strict subset of the full Claude/aisdk loom tool set
 * — no `ask_user` yet (Phase 5 wires up Codex's own answer path first). The
 * daemon's `systemPromptAppend` is written assuming the full set, so it would
 * tell the model about tools that don't exist here; recompute the tool-steer
 * for what's actually mounted instead of forwarding it verbatim. Skips the
 * daemon's repoRoot-fallback LOOM.md lookup (this connector only has the
 * session's own `cwd`), a narrow, acceptable gap versus a fully plumbed-
 * through repo root.
 */
export const codeModeInstructions = (cwd: string, mountsLoomTools: boolean): string =>
  [
    toolSteer(cwd, { askUser: false, commit: mountsLoomTools, status: mountsLoomTools }),
    loomInstructions(cwd),
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join("\n\n");

class ChatGPTProvider implements AgentProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  readonly #codexHome: CodexHome;
  readonly #codexCliPath: string;
  readonly #search: ConnectorContext["search"];
  readonly #base: string | undefined;
  readonly #codexBuiltinWebSearch: boolean;
  readonly #listModelsImpl: () => Promise<DiscoveredModel[]>;

  constructor(
    id: string,
    models: string[],
    listModels: () => Promise<DiscoveredModel[]>,
    codexHome: CodexHome,
    codexCliPath: string,
    base: string | undefined,
    search?: ConnectorContext["search"],
    codexBuiltinWebSearch = false,
  ) {
    this.id = id;
    this.#listModelsImpl = listModels;
    this.#codexHome = codexHome;
    this.#codexCliPath = codexCliPath;
    this.#search = search;
    this.#base = base;
    this.#codexBuiltinWebSearch = codexBuiltinWebSearch;
    this.capabilities = {
      liveModeSwitch: true,
      liveModelSwitch: false,
      forking: false,
      rewind: false,
      // No Loom `task` tool is mounted for Codex sessions — Codex's own
      // multi-agent activity (`subAgentActivity` items) is a different,
      // natively-driven feature, observed passively, not this capability.
      subagents: false,
      compaction: true,
      // Code Mode's `thread/compact/start` currently accepts no instruction
      // payload (app-server.ts's `compact()` throws rather than silently drop
      // a caller's instructions).
      compactionInstructions: false,
      ownsTranscript: false,
      oneShot: true,
      partialTokens: true,
      permissionModes: ["default", "plan", "acceptEdits", "auto"],
      models,
    };
  }

  async createSession(opts: CreateSessionOptions): Promise<AgentSession> {
    return CodexAppServerSession.start(
      { ...opts, systemPromptAppend: codeModeInstructions(opts.cwd, opts.loomServer === true) },
      this.#codexHome,
      this.#codexCliPath,
      this.#search,
      this.#codexBuiltinWebSearch,
      this.#base,
    );
  }
  async resumeSession(ref: SessionRef): Promise<AgentSession> {
    return CodexAppServerSession.resume(
      // Codex sessions always mount the loom dynamic tools on resume (the
      // daemon always resumes with `loomServer` semantics equivalent to
      // `true` for this provider — `SessionRef` has no `loomServer` field).
      { ...ref, systemPromptAppend: codeModeInstructions(ref.cwd, true) },
      this.#codexHome,
      this.#codexCliPath,
      this.#search,
      this.#codexBuiltinWebSearch,
      this.#base,
    );
  }
  listPersistedSessions(): Promise<SessionRef[]> {
    return Promise.resolve([]);
  }
  listModels(): Promise<DiscoveredModel[]> {
    return this.#listModelsImpl();
  }
}

export const createProvider = (ctx: ConnectorContext): AgentProvider => {
  if (ctx.config.baseUrl) {
    throw new Error(
      `chatgpt provider ${JSON.stringify(ctx.id)}: \`base_url\` is not supported anymore — ` +
        "every ChatGPT model now runs through Codex's app-server, not a direct Responses API " +
        "endpoint. Remove `base_url` from this provider's config.",
    );
  }
  const codexHome = resolveCodexHome({
    ...(ctx.config.configDir ? { configDir: ctx.config.configDir } : {}),
    ...(ctx.config.authPath ? { authPath: ctx.config.authPath } : {}),
  });
  const codexCliPath = ctx.config.codexCliPath || "codex";
  const catalog = new ChatGPTCatalog(codexHome);
  // A curated `models` list restricts the picker to exactly those ids
  // (available even if the account marks them hidden); otherwise the picker
  // gets the account's own visible/default set.
  const restrictTo = ctx.config.models?.length ? new Set(ctx.config.models) : undefined;
  const listModels = async (): Promise<DiscoveredModel[]> => {
    // Reasoning-effort discovery and the model list itself go through
    // app-server (Phase 2) — authoritative. Context-window sizes come from
    // the REST catalog, the only source that reports them; a config
    // `model_context` pin wins over both. The catalog is best-effort: app-
    // server's `model/list` has no context-window field at all, but a
    // catalog failure (expired credential, timeout, malformed response) must
    // not block model discovery or session creation.
    const [discovered, restCatalog] = await Promise.all([
      discoverCodexModels({ cliPath: codexCliPath, codexHome }),
      withTimeout(catalog.list(), CATALOG_TIMEOUT_MS, "chatgpt model catalog fetch").catch((err) => {
        ctx.logger.warn("chatgpt model catalog fetch failed — context-window sizes may be unavailable", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }),
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
  return new ChatGPTProvider(
    ctx.id,
    ctx.config.models ?? [],
    listModels,
    codexHome,
    codexCliPath,
    ctx.baseBranch,
    ctx.search,
    ctx.config.codexBuiltinWebSearch,
  );
};
