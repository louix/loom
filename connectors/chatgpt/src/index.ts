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
import { toolSteer } from "@loom/runtime/instructions";
import { ChatGPTCatalog } from "./catalog.ts";
import { CodexAppServerSession } from "./app-server.ts";
import { resolveCodexHome, type CodexHome } from "./codex-home.ts";
import { discoverCodexModels } from "./discovery.ts";
import { spawnCodex, type CodexLauncher } from "./launch.ts";
import { localToolDispatcher, type ToolDispatcher } from "./tool-dispatch.ts";

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
 * The dynamic tools `CodexAppServerSession` mounts (`commit`/`status`/
 * `ask_user`/`exit_plan`, see `app-server.ts`) are Loom's own; the daemon's
 * `systemPromptAppend` is written assuming Claude/aisdk's full loom-mcp/tool
 * set (a superset with different naming), so it would tell the model about
 * tools shaped differently than what's actually mounted here — recompute the
 * tool-steer for what's actually mounted instead of forwarding it verbatim.
 *
 * `repoInstructions` is the daemon's own pre-resolved `.loom/LOOM.md` text
 * (`repoInstructionsFor` in `backend/daemon/src/daemon/prompt.ts`, already
 * applying its `cwd`-then-`repoRoot` fallback) — this connector splices it
 * in rather than reading the file itself, since only the daemon knows the
 * repo root a worktree `cwd` falls back to. `workspaceRoot` is the directory
 * described to the model as "the workspace root" for tool-steer purposes;
 * kept distinct from the provider's own `cwd` (where Codex's process and
 * sandbox actually run), even though the daemon passes the same value for
 * both today.
 *
 * `askUserMounted` is deliberately **separate** from `mountsLoomTools`: a
 * resumed thread never gets its `dynamicTools` re-sent (no such field on
 * `thread/resume` — see `app-server.ts#resume`'s comment), so a thread
 * created before `ask_user` existed (pre-Phase-5) genuinely doesn't have it
 * registered. `commit`/`status` are safe to describe on every resumed
 * session (mounted unconditionally since Phase 4, and every currently-
 * resumable Codex thread postdates that); `ask_user` is not, so
 * `resumeSession` below always passes `askUserMounted: false` regardless of
 * `mountsLoomTools` — under-claiming a tool a newer thread might genuinely
 * have is safe, over-claiming one an older thread doesn't have is not (the
 * model's call would just error). A session that needs `ask_user` after a
 * daemon restart has to be started fresh; Phase 6's forced-restart-on-demand
 * is the eventual real fix. `exit_plan` needs no equivalent guard: its usage
 * guidance lives entirely in the tool's own `description`, visible only if
 * Codex actually has it registered — there's nothing here to over-claim.
 */
export const codeModeInstructions = (
  workspaceRoot: string,
  mountsLoomTools: boolean,
  askUserMounted: boolean,
  repoInstructions: string | null,
): string =>
  [
    toolSteer(workspaceRoot, {
      askUser: askUserMounted,
      commit: mountsLoomTools,
      status: mountsLoomTools,
    }),
    repoInstructions,
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
  readonly #listModelsImpl: (launch: CodexLauncher) => Promise<DiscoveredModel[]>;
  readonly #launch: CodexLauncher;
  readonly #dispatch: ToolDispatcher;

  constructor(
    id: string,
    models: string[],
    listModels: (launch: CodexLauncher) => Promise<DiscoveredModel[]>,
    codexHome: CodexHome,
    codexCliPath: string,
    base: string | undefined,
    search?: ConnectorContext["search"],
    codexBuiltinWebSearch = false,
    launch: CodexLauncher = spawnCodex,
    dispatch: ToolDispatcher = localToolDispatcher,
  ) {
    this.id = id;
    this.#listModelsImpl = listModels;
    this.#codexHome = codexHome;
    this.#codexCliPath = codexCliPath;
    this.#search = search;
    this.#base = base;
    this.#codexBuiltinWebSearch = codexBuiltinWebSearch;
    this.#launch = launch;
    this.#dispatch = dispatch;
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
    const workspaceRoot = opts.workspaceRoot ?? opts.cwd;
    const mounted = opts.loomServer === true;
    return CodexAppServerSession.start(
      {
        ...opts,
        // A fresh thread — `ask_user` really is registered whenever the
        // rest of the loom tool set is.
        systemPromptAppend: codeModeInstructions(
          workspaceRoot,
          mounted,
          mounted,
          opts.repoInstructions ?? null,
        ),
      },
      this.#codexHome,
      this.#codexCliPath,
      this.#search,
      this.#codexBuiltinWebSearch,
      this.#base,
      this.#launch,
      this.#dispatch,
    );
  }
  async resumeSession(ref: SessionRef): Promise<AgentSession> {
    const workspaceRoot = ref.workspaceRoot ?? ref.cwd;
    return CodexAppServerSession.resume(
      // Codex sessions always mount the loom dynamic tools on resume (the
      // daemon always resumes with `loomServer` semantics equivalent to
      // `true` for this provider — `SessionRef` has no `loomServer` field).
      // `askUserMounted: false` regardless — see `codeModeInstructions`'s
      // doc comment for why resume never claims `ask_user`.
      {
        ...ref,
        systemPromptAppend: codeModeInstructions(
          workspaceRoot,
          true,
          false,
          ref.repoInstructions ?? null,
        ),
      },
      this.#codexHome,
      this.#codexCliPath,
      this.#search,
      this.#codexBuiltinWebSearch,
      this.#base,
      this.#launch,
      this.#dispatch,
    );
  }
  listPersistedSessions(): Promise<SessionRef[]> {
    return Promise.resolve([]);
  }
  listModels(): Promise<DiscoveredModel[]> {
    return this.#listModelsImpl(this.#launch);
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
  const listModels = async (launch: CodexLauncher): Promise<DiscoveredModel[]> => {
    // Reasoning-effort discovery and the model list itself go through
    // app-server (Phase 2) — authoritative. Context-window sizes come from
    // the REST catalog, the only source that reports them; a config
    // `model_context` pin wins over both. The catalog is best-effort: app-
    // server's `model/list` has no context-window field at all, but a
    // catalog failure (expired credential, timeout, malformed response) must
    // not block model discovery or session creation.
    const [discovered, restCatalog] = await Promise.all([
      discoverCodexModels({ cliPath: codexCliPath, codexHome, launch }),
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
