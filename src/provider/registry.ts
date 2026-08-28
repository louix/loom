/**
 * Lazily instantiates provider adapters by id. The provider is picked per
 * session (design spec §2), so nothing is constructed until a session asks for
 * it — importing the Claude SDK has a cost, and the `fake` provider only exists
 * for tests / offline play.
 */
import type { LoomConfig } from "../config/config.ts";
import { ClaudeProvider } from "./claude/adapter.ts";
import { FakeProvider } from "./fake/fake.ts";
import type { AgentProvider } from "./types.ts";

export class ProviderRegistry {
  readonly #config: LoomConfig;
  readonly #factories = new Map<string, () => AgentProvider>();
  readonly #cache = new Map<string, AgentProvider>();

  constructor(config: LoomConfig) {
    this.#config = config;
    this.#factories.set(
      "claude",
      () => new ClaudeProvider({ cliPath: config.providers.claude.cliPath }),
    );
    this.#factories.set("fake", () => new FakeProvider());
  }

  get defaultId(): string {
    return "claude";
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
