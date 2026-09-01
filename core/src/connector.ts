/**
 * The plugin seam. A connector package (`@loom/connector-*`) exports
 * `createProvider`; the CLI hands the daemon a {@link ConnectorManifest} of lazy
 * thunks so the daemon never imports a vendor SDK itself. See
 * `docs/connectors.md` for the full contract.
 */
import type { AgentProvider } from "./types.ts";
import type { TranscriptStore } from "./transcript.ts";
import type { Logger } from "./logger.ts";

/** A resolved `web_search` backend. `[search] backend = "none"` yields no config at all. */
export interface SearchConfig {
  backend: "brave" | "tavily";
  /** The resolved key, not the env-var name. */
  apiKey: string;
  /** Backend URL override; "" uses the backend default. */
  apiBase: string;
  maxResults: number;
}

/**
 * The config slice for one provider id, flattened from `[providers.<id>]` /
 * `[custom-provider.<id>]` / `[google]` / `[anthropic]` / `[providers.claude]`.
 * Every field is optional — a connector reads only the ones it needs.
 */
export interface ConnectorConfig {
  /** Default model for new sessions. */
  model?: string;
  /** Model ids offered in the picker. */
  models?: string[];
  /** OpenAI-compatible endpoint base URL. */
  baseUrl?: string;
  /** Resolved API key (inline `api_key` wins over `api_key_env`), "" if keyless. */
  apiKey?: string;
  /** Which `@ai-sdk/*` backend the aisdk connectors dial. */
  sdk?: "openai" | "google" | "anthropic";
  /** Per-segment tool-call ceiling for a turn. */
  maxSteps?: number;
  /**
   * Known per-model context-window sizes in tokens, keyed by model id — from
   * the endpoint's `/models` metadata (`context_length` et al.) or a
   * `model_context` config pin. Sessions prefer these over the built-in
   * prefix table in `@loom/core/tokens`.
   */
  modelContext?: Record<string, number>;
  /** Claude: explicit path to the `claude` executable ("" = discover / bundled). */
  cliPath?: string;
  /** Claude: prompt-cache TTL — "5m" | "1h" | "". */
  promptCacheTtl?: string;
  /**
   * Claude: `CLAUDE_CONFIG_DIR` for this provider instance — the profile's
   * config directory, already tilde-expanded and absolute. "" = the SDK's
   * default (`~/.claude`).
   */
  configDir?: string;
}

export interface ConnectorContext {
  /** The provider id this instance serves. */
  id: string;
  config: ConnectorConfig;
  /** Provided to connectors that persist their own history (aisdk); omitted for Claude. */
  transcript?: TranscriptStore;
  /** Provided when a `web_search` backend + key are configured. */
  search?: SearchConfig;
  logger: Logger;
}

export type CreateProvider = (ctx: ConnectorContext) => Promise<AgentProvider> | AgentProvider;

export interface ConnectorModule {
  createProvider: CreateProvider;
}

/** Package name → a lazy loader for that connector. Assembled by the CLI. */
export type ConnectorManifest = Record<string, () => Promise<ConnectorModule>>;
