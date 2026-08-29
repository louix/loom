/**
 * Instantiates provider adapters by id, on demand. The provider is picked per
 * session (design spec §2), and each adapter's vendor SDK is loaded with a
 * dynamic `import()` inside its factory — so a Claude-only daemon never
 * evaluates `ai` / `@ai-sdk/*`, and an aisdk-only daemon never evaluates
 * `@anthropic-ai/claude-agent-sdk`. Nothing in the daemon's eager graph
 * imports a vendor SDK; the seam (`../types.ts`) is enough.
 *
 * `claude` and `fake` are always available; every `[providers.<id>]` profile
 * with `adapter = "aisdk"` adds an entry under its own id.
 */
import type { LoomConfig } from "../config/config.ts";
import type { Db } from "../store/db.ts";
import type { AgentProvider } from "./types.ts";
import type { SearchConfig } from "./aisdk/tools/search.ts";

export class ProviderRegistry {
  readonly #config: LoomConfig;
  readonly #db: Db | undefined;
  readonly #ids: Set<string>;
  /** id → in-flight or resolved adapter; caching the promise dedupes concurrent `get`s. */
  readonly #cache = new Map<string, Promise<AgentProvider>>();
  /** Resolved adapters, in construction order — for `live()` / shutdown. */
  readonly #live: AgentProvider[] = [];

  constructor(config: LoomConfig, db?: Db) {
    this.#config = config;
    this.#db = db;
    this.#ids = new Set(["claude", "fake", ...Object.keys(config.providers.aisdk)]);
  }

  get defaultId(): string {
    const want = this.#config.defaultProvider;
    return this.#ids.has(want) ? want : "claude";
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  /** Construct (or return the cached) adapter for `id`, loading its SDK lazily. */
  get(id: string): Promise<AgentProvider> {
    const cached = this.#cache.get(id);
    if (cached) return cached;
    if (!this.#ids.has(id)) return Promise.reject(new Error(`unknown provider: ${id}`));
    const built = this.#build(id).then((p) => {
      this.#live.push(p);
      return p;
    });
    this.#cache.set(id, built);
    return built;
  }

  async #build(id: string): Promise<AgentProvider> {
    if (id === "fake") {
      const { FakeProvider } = await import("./fake/fake.ts");
      return new FakeProvider();
    }
    if (id === "claude") {
      const { ClaudeProvider } = await import("./claude/adapter.ts");
      return new ClaudeProvider({
        cliPath: this.#config.providers.claude.cliPath,
        promptCacheTtl: this.#config.providers.claude.promptCacheTtl,
      });
    }
    const profile = this.#config.providers.aisdk[id];
    if (!profile) throw new Error(`unknown provider: ${id}`);
    if (!this.#db) throw new Error(`aisdk provider "${id}" needs a database`);
    const [{ AisdkProvider, resolveModelFactory }, { ProviderMessageStore }] = await Promise.all([
      import("./aisdk/adapter.ts"),
      import("./aisdk/store.ts"),
    ]);
    const apiKey = profile.apiKeyEnv ? (process.env[profile.apiKeyEnv] ?? "") : "";
    const makeModel = await resolveModelFactory(profile.sdk, { id, baseUrl: profile.baseUrl, apiKey });
    const search = this.#resolveSearch();
    return new AisdkProvider(
      { id, model: profile.model, models: profile.models, makeModel, ...(search ? { search } : {}) },
      new ProviderMessageStore(this.#db),
    );
  }

  /** `[search]` → a resolved `web_search` config, or undefined when off / keyless. */
  #resolveSearch(): SearchConfig | undefined {
    const s = this.#config.search;
    if (s.backend === "none") return undefined;
    const apiKey = s.apiKeyEnv ? (process.env[s.apiKeyEnv] ?? "") : "";
    if (!apiKey) return undefined;
    return { backend: s.backend, apiKey, apiBase: s.apiBase, maxResults: s.maxResults };
  }

  /** Providers that have actually been constructed (for shutdown / status). */
  live(): AgentProvider[] {
    return [...this.#live];
  }

  get config(): LoomConfig {
    return this.#config;
  }
}
