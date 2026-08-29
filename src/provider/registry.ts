/**
 * Lazily instantiates provider adapters by id. The provider is picked per
 * session (design spec §2), so nothing is constructed until a session asks for
 * it — importing the Claude SDK has a cost, and the `fake` provider only exists
 * for tests / offline play.
 *
 * `claude` and `fake` are always present; every `[providers.<id>]` profile with
 * `adapter = "aisdk"` adds an {@link AisdkProvider} entry under its own id.
 */
import type { LoomConfig } from "../config/config.ts";
import type { Db } from "../store/db.ts";
import { ClaudeProvider } from "./claude/adapter.ts";
import { FakeProvider } from "./fake/fake.ts";
import { AisdkProvider } from "./aisdk/adapter.ts";
import { ProviderMessageStore } from "./aisdk/store.ts";
import type { AgentProvider } from "./types.ts";

export class ProviderRegistry {
  readonly #config: LoomConfig;
  readonly #factories = new Map<string, () => AgentProvider>();
  readonly #cache = new Map<string, AgentProvider>();

  constructor(config: LoomConfig, db?: Db) {
    this.#config = config;
    this.#factories.set(
      "claude",
      () =>
        new ClaudeProvider({
          cliPath: config.providers.claude.cliPath,
          promptCacheTtl: config.providers.claude.promptCacheTtl,
        }),
    );
    this.#factories.set("fake", () => new FakeProvider());

    for (const [id, profile] of Object.entries(config.providers.aisdk)) {
      this.#factories.set(id, () => {
        if (!db) throw new Error(`aisdk provider "${id}" needs a database`);
        const apiKey = profile.apiKeyEnv ? (process.env[profile.apiKeyEnv] ?? "") : "";
        return new AisdkProvider(
          { id, baseUrl: profile.baseUrl, apiKey, model: profile.model, models: profile.models },
          new ProviderMessageStore(db),
        );
      });
    }
  }

  get defaultId(): string {
    const want = this.#config.defaultProvider;
    return this.#factories.has(want) ? want : "claude";
  }

  has(id: string): boolean {
    return this.#factories.has(id);
  }

  get(id: string): AgentProvider {
    const cached = this.#cache.get(id);
    if (cached) return cached;
    const factory = this.#factories.get(id);
    if (!factory) throw new Error(`unknown provider: ${id}`);
    const provider = factory();
    this.#cache.set(id, provider);
    return provider;
  }

  /** Providers that have actually been constructed (for shutdown / status). */
  live(): AgentProvider[] {
    return [...this.#cache.values()];
  }

  get config(): LoomConfig {
    return this.#config;
  }
}
