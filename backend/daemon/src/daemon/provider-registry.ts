import { runSessionInit } from "../../../../core/src/session-init.ts";
import { matchGlob } from "./hooks.ts";
import type { CreateSessionOptions, SessionRef } from "@loom/core/types";
import { withVmSessions } from "./vm-provider.ts";
/**
 * Instantiates providers by id, on demand, from a {@link ConnectorManifest} of
 * lazy thunks the CLI supplies. Nothing in the daemon's graph imports a vendor
 * SDK or a connector package — a thunk is only invoked for a provider a session
 * actually uses, so a Claude-only daemon never evaluates `ai` / `@ai-sdk/*` and
 * an aisdk-only daemon never evaluates `@anthropic-ai/claude-agent-sdk`.
 *
 * `fake`/`mock` and the Claude profiles are always known (`[[claude_profiles]]`,
 * defaulting to a lone `~/.claude` → id `claude`); every `[providers.<id>]` /
 * `[custom-provider.<id>]` / `[google]` / `[anthropic]` profile adds an id.
 */
import {
  claudeProfileId,
  resolveApiKey,
  type ClaudeProfile,
  type LoomConfig,
} from "../config/config.ts";
import { isClaudeId } from "@loom/core/provider-id";
import type { AgentProvider } from "@loom/core/types";
import type {
  ConnectorConfig,
  ConnectorContext,
  ConnectorManifest,
  SearchConfig,
} from "@loom/core/connector";
import type { TranscriptStore } from "@loom/core/transcript";
import { makeLogger } from "@loom/core/logger";
import { withExternalMcp } from "./mcp-provider.ts";
import { preflightTools } from "./tool-preflight.ts";

const MOCK = "@loom/connector-mock";
const CLAUDE = "@loom/connector-claude";
const GEMINI = "@loom/connector-gemini";
const GENERIC = "@loom/connector-generic";
const CHATGPT = "@loom/connector-chatgpt";

export class ProviderRegistry {
  readonly #onVmStarted: ConnectorContext["onVmStarted"];
  readonly #onStartupProgress: ConnectorContext["onStartupProgress"];
  readonly #config: LoomConfig;
  readonly #repoRoot: string;
  readonly #transcript: TranscriptStore;
  readonly #manifest: ConnectorManifest;
  readonly #ids: Set<string>;
  /** id → in-flight or resolved provider; caching the promise dedupes concurrent `get`s. */
  readonly #cache = new Map<string, Promise<AgentProvider>>();
  /** Resolved providers, in construction order — for `live()` / shutdown. */
  readonly #live: AgentProvider[] = [];
  /** id → resolved provider, for sync capability reads once it's been built. */
  readonly #resolved = new Map<string, AgentProvider>();
  /** Connector packages whose `createProvider` has run at least once (for `daemon.doctor`). */
  readonly #loaded = new Set<string>();

  constructor(
    config: LoomConfig,
    transcript: TranscriptStore,
    manifest: ConnectorManifest,
    repoRoot = Deno.cwd(),
    onStartupProgress?: ConnectorContext["onStartupProgress"],
    onVmStarted?: ConnectorContext["onVmStarted"],
  ) {
    this.#onVmStarted = onVmStarted;
    this.#repoRoot = repoRoot;
    this.#onStartupProgress = onStartupProgress;
    this.#config = config;
    this.#transcript = transcript;
    this.#manifest = manifest;
    this.#ids = new Set([
      // Both spellings resolve to the mock connector (see #packageFor); the
      // header comment promises both are always known.
      "fake",
      "mock",
      ...config.claudeProfiles.map(claudeProfileId),
      ...Object.keys(config.providers.aisdk),
    ]);
  }

  /** The `[[claude_profiles]]` entry an id serves. */
  #claudeProfile(id: string): ClaudeProfile {
    const p = this.#config.claudeProfiles.find((x) => claudeProfileId(x) === id);
    if (!p) throw new Error(`unknown provider: ${id}`);
    return p;
  }

  get defaultId(): string {
    const want = this.#config.defaultProvider;
    if (this.has(want)) return want;
    return [...this.#ids].find((id) => id !== "fake" && id !== "mock" && this.has(id)) ?? "";
  }

  has(id: string): boolean {
    return this.unavailableReason(id) === undefined;
  }

  unavailableReason(id: string): string | undefined {
    if (!this.#ids.has(id))
      return `Provider ${id} is no longer configured. Fork to an enabled provider to continue.`;
    const { only, disabled } = this.#config.providerAccess;
    if ((only && !only.includes(id)) || disabled.includes(id))
      return `Provider ${id} is disabled for this project. Fork to an enabled provider to continue.`;
    if (!this.#manifest[this.#packageFor(id)])
      return `Provider ${id}'s connector is missing from this build. Fork to an available provider to continue.`;
  }

  /** Capabilities of `id` if its provider has already been constructed this
   *  process — sync, for hot paths that can't await a lazy build. */
  capsOf(id: string): AgentProvider["capabilities"] | undefined {
    return this.#resolved.get(id)?.capabilities;
  }

  /** Construct (or return the cached) provider for `id`, loading its connector lazily. */
  get(id: string): Promise<AgentProvider> {
    const reason = this.unavailableReason(id);
    if (reason) return Promise.reject(new Error(reason));
    const cached = this.#cache.get(id);
    if (cached) return cached;
    if (!this.#ids.has(id)) return Promise.reject(new Error(`unknown provider: ${id}`));
    const built = this.#build(id).then((p) => {
      this.#live.push(p);
      this.#resolved.set(id, p);
      return p;
    });
    // Don't cache a rejected build forever — a later `get()` (after the env var
    // is set, the connector is installed, …) should be able to retry.
    built.catch(() => {
      if (this.#cache.get(id) === built) this.#cache.delete(id);
    });
    this.#cache.set(id, built);
    return built;
  }

  /** The connector package name that serves `id`. */
  #packageFor(id: string): string {
    if (id === "fake" || id === "mock") return MOCK;
    if (isClaudeId(id)) return CLAUDE;
    const profile = this.#config.providers.aisdk[id];
    if (!profile) throw new Error(`unknown provider: ${id}`);
    if (profile.connector) return profile.connector;
    if (profile.sdk === "google") return GEMINI;
    if (profile.sdk === "chatgpt") return CHATGPT;
    return GENERIC;
  }

  async #build(id: string): Promise<AgentProvider> {
    const pkg = this.#packageFor(id);
    const load = this.#manifest[pkg];
    if (!load) {
      throw new Error(
        `provider "${id}" needs connector ${pkg}, which isn't in this build's manifest`,
      );
    }
    const profile = this.#config.providers.aisdk[id];
    if (profile && !profile.model && !(profile.sdk === "chatgpt" && profile.autoModels)) {
      throw new Error(
        `provider "${id}" has no model — auto-detection from ${profile.baseUrl}/models ` +
          `failed or hasn't run; set \`model\` or \`models\` in the config`,
      );
    }
    const context = this.#contextFor(id);
    if (this.#onStartupProgress) context.onStartupProgress = this.#onStartupProgress;
    if (this.#onVmStarted) context.onVmStarted = this.#onVmStarted;
    if (context.config.sessionVm && ![CLAUDE, GENERIC, GEMINI, CHATGPT].includes(pkg))
      throw new Error(
        `Connector ${pkg} has no VM backend; choose a supported connector or disable its VM policy`,
      );
    const { createProvider } = await load();
    const provider = await withExternalMcp(
      async (ctx) => {
        const base = await createProvider(ctx);
        if (ctx.config.sessionVm && ctx.config.sdk === "chatgpt")
          return withVmSessions(base, ctx, "codex");
        return !isClaudeId(id) && ctx.config.sessionVm ? withVmSessions(base, ctx, "aisdk") : base;
      },
      context,
      undefined,
      undefined,
    );
    this.#loaded.add(pkg);
    const initStop = new AbortController();
    return new Proxy(provider, {
      get: (target, prop) => {
        if (prop === "close")
          return async () => {
            initStop.abort();
            await target.close?.();
          };
        if (prop === "createSession" || prop === "resumeSession")
          return async (options: CreateSessionOptions | SessionRef) => {
            if (!("oneShot" in options && options.oneShot)) await preflightTools(this.#config, id);
            if (prop === "resumeSession" && !options.initHooks)
              return target.resumeSession(options as SessionRef);
            const hooks =
              "oneShot" in options && options.oneShot
                ? []
                : this.#config.hooks.filter(
                    (h) =>
                      h.on.includes("init") && (!h.project || matchGlob(h.project, this.#repoRoot)),
                  );
            const configured = {
              ...options,
              initHooks: {
                hooks,
                env: {
                  LOOM_REPO_ROOT: this.#repoRoot,
                  LOOM_WORKTREE: options.cwd,
                  LOOM_SESSION_PROVIDER: id,
                  LOOM_SESSION_MODEL: options.model ?? "",
                  LOOM_SESSION_STATUS: "starting",
                  LOOM_FILES: "",
                  LOOM_FILE: "",
                },
              },
            };
            const ready = context.config.sessionVm
              ? configured
              : await runSessionInit(
                  configured,
                  (message) => context.onStartupProgress?.(options.sessionId, message),
                  initStop.signal,
                );
            return prop === "createSession"
              ? target.createSession(ready as CreateSessionOptions)
              : target.resumeSession(ready as SessionRef);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /**
   * Per-package view for `daemon.doctor`: which configured providers each
   * connector serves, and whether it's been constructed this process.
   */
  connectorReport(): Array<{ pkg: string; providerIds: string[]; loaded: boolean }> {
    const byPkg = new Map<string, string[]>();
    for (const pkg of Object.keys(this.#manifest)) byPkg.set(pkg, []);
    for (const id of this.#ids) {
      let pkg: string;
      try {
        pkg = this.#packageFor(id);
      } catch {
        continue; // an id with no resolvable package — leave it out
      }
      byPkg.set(pkg, [...(byPkg.get(pkg) ?? []), id]);
    }
    return [...byPkg].map(([pkg, providerIds]) => ({
      pkg,
      providerIds: [...providerIds].sort(),
      loaded: this.#loaded.has(pkg),
    }));
  }

  #contextFor(id: string): ConnectorContext {
    const logger = makeLogger("connector").child(id);
    const search = this.#resolveSearch();
    const baseBranch = this.#config.baseBranch;
    if (id === "fake" || id === "mock") {
      return { id, config: {}, logger, baseBranch, ...(search ? { search } : {}) };
    }
    if (isClaudeId(id)) {
      const c = this.#config.providers.claude;
      // The base `claude` id keeps the SDK's own default resolution untouched —
      // setting `CLAUDE_CONFIG_DIR` even to `~/.claude` would relocate where the
      // CLI keeps `.claude.json` (it moves inside the dir). A named profile
      // always scopes its own dir. `cli_path` / `prompt_cache_ttl` stay global.
      const configDir = id === "claude" ? "" : this.#claudeProfile(id).dir;
      return {
        id,
        config: {
          cliPath: c.cliPath,
          ...(this.#config.isolation.claude
            ? {
                sessionVm: {
                  ...this.#config.isolation.claude,
                  repoRoot: this.#repoRoot,
                  extraAllowedHosts: this.#config.isolation.extraAllowedHosts,
                  ...(this.#config.isolation.environment
                    ? { environment: this.#config.isolation.environment }
                    : {}),
                },
              }
            : {}),
          promptCacheTtl: c.promptCacheTtl,
          configDir,
          ...(c.workerAllowedHosts ? { workerAllowedHosts: c.workerAllowedHosts } : {}),
        },
        baseBranch,
        logger,
        ...(search ? { search } : {}),
      };
    }
    const p = this.#config.providers.aisdk[id];
    if (!p) throw new Error(`unknown provider: ${id}`);
    const vmPolicy =
      p.sdk === "chatgpt" ? this.#config.isolation.codex : this.#config.isolation.aisdk;
    const config: ConnectorConfig = {
      ...(vmPolicy
        ? {
            sessionVm: {
              ...vmPolicy,
              repoRoot: this.#repoRoot,
              extraAllowedHosts: this.#config.isolation.extraAllowedHosts,
              ...(this.#config.isolation.environment
                ? { environment: this.#config.isolation.environment }
                : {}),
            },
          }
        : {}),
      model: p.model,
      models: p.models,
      baseUrl: p.baseUrl,
      apiKey: resolveApiKey(p),
      sdk: p.sdk,
      ...(p.authPath ? { authPath: p.authPath } : {}),
      ...(p.configDir ? { configDir: p.configDir } : {}),
      ...(p.codexCliPath ? { codexCliPath: p.codexCliPath } : {}),
      ...(p.codexBuiltinWebSearch ? { codexBuiltinWebSearch: true } : {}),
      ...(Object.keys(p.modelContext).length > 0 ? { modelContext: p.modelContext } : {}),
      includeUsage: p.includeUsage,
      promptCacheTtl: p.promptCacheTtl,
      ...(p.maxSteps !== undefined ? { maxSteps: p.maxSteps } : {}),
    };
    return {
      id,
      config,
      transcript: this.#transcript,
      logger,
      baseBranch,
      ...(search ? { search } : {}),
    };
  }

  /** `[search]` → a resolved `web_search` config, or undefined when off / keyless. */
  #resolveSearch(): SearchConfig | undefined {
    const s = this.#config.search;
    if (s.backend === "none") return undefined;
    const apiKey = resolveApiKey(s);
    if (!apiKey) return undefined;
    return {
      backend: s.backend,
      apiKey,
      apiBase: s.apiBase,
      maxResults: s.maxResults,
    };
  }

  /** Providers that have actually been constructed (for shutdown / status). */
  live(): AgentProvider[] {
    return [...this.#live];
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(this.#live.map((provider) => provider.close?.()));
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Provider shutdown failed");
  }

  get config(): LoomConfig {
    return this.#config;
  }
}
