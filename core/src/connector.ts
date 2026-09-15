import { z } from "zod";
import type { SessionEnvironment } from "./session-environment.ts";
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
  /** The resolved search API key. */
  apiKey: string;
  /** Backend URL override; "" uses the backend default. */
  apiBase: string;
  maxResults: number;
}

/**
 * The config slice for one provider id, flattened from `[providers.<id>]` /
 * `providers.<family>` or `providers.<family>.profiles.<name>`.
 * Every field is optional — a connector reads only the ones it needs.
 */
const connectorConfigFields = z.object({
  /** Default model for new sessions. */
  model: z.string(),
  /** Model ids offered in the picker. */
  models: z.array(z.string()),
  /** OpenAI-compatible endpoint base URL. */
  baseUrl: z.string(),
  /** Resolved API key (inline `api_key` wins over `api_key_env`), "" if keyless. */
  apiKey: z.string(),
  /** Which model backend the aisdk connectors dial. */
  sdk: z.enum(["openai", "google", "anthropic", "chatgpt"]),
  /** ChatGPT: explicit `codex` executable. Empty / omitted uses PATH. */
  codexCliPath: z.string(),
  /** Expose Codex's own web search alongside configured MCP servers. Default false. */
  codexBuiltinWebSearch: z.boolean(),
  /** Per-segment tool-call ceiling for a turn. */
  maxSteps: z.number(),
  /**
   * Known per-model context-window sizes in tokens, keyed by model id — from
   * the endpoint's `/models` metadata (`context_length` et al.) or a
   * `model_context` config pin. Sessions prefer these over the built-in
   * prefix table in `@loom/core/tokens`.
   */
  modelContext: z.record(z.string(), z.number()),
  /**
   * Request `stream_options.include_usage` on streamed completions (default
   * true). Endpoints that validate strictly against an older OpenAI schema
   * may reject the field — turn it off per provider with `include_usage`.
   */
  includeUsage: z.boolean(),
  /** Claude: explicit path to the `claude` executable ("" = discover / bundled). */
  cliPath: z.string(),
  /**
   * Prompt-cache TTL. Claude: "5m" | "1h" | "" (the CLI decides). aisdk with
   * `sdk = "anthropic"`: the same, plus "off" to stop asking for a cache
   * breakpoint at all. Ignored by the other aisdk backends.
   */
  promptCacheTtl: z.string(),
  /**
   * Claude: `CLAUDE_CONFIG_DIR` for this provider instance — the profile's
   * config directory, already tilde-expanded and absolute. "" = the SDK's
   * default (`~/.claude`).
   *
   * ChatGPT (`sdk = "chatgpt"`): explicit Codex home directory (`auth.json`,
   * `config.toml`). "" uses `CODEX_HOME`, then `~/.codex`.
   */
  configDir: z.string(),
});

/** Selects only connector fields; host launch policy never crosses the wire. */
export const connectorWireConfigSchema = connectorConfigFields.partial();
export type ConnectorWireConfig = z.infer<typeof connectorWireConfigSchema>;

export interface ConnectorConfig extends ConnectorWireConfig {
  /** Operator-selected Deno network hosts for a connector worker. */
  workerAllowedHosts?: string[];
  /** Host-selected Claude session VM policy. */
  sessionVm?: {
    artifact: string;
    smolvm: string;
    repoRoot: string;
    extraAllowedHosts?: string[];
    environment?: SessionEnvironment;
  };
}

export interface ConnectorContext {
  /** Set by the local bootstrap, never accepted from serialized connector config. */
  executionEnvironment?: "host" | "session-vm";
  /** Host-only progress before create/resume returns an agent session. */
  onVmStarted?: (sessionId: string, generation: string) => void;
  onStartupProgress?: (sessionId: string, message: string) => void;
  /** The provider id this instance serves. */
  id: string;
  config: ConnectorConfig;
  /** Provided to connectors that persist their own history (aisdk); omitted for Claude. */
  transcript?: TranscriptStore;
  /** Provided when a `web_search` backend + key are configured. */
  search?: SearchConfig;
  /** The repo's base branch (`base_branch`) — feeds `status` ahead/behind counts. */
  baseBranch?: string;
  logger: Logger;
}

export type CreateProvider = (ctx: ConnectorContext) => Promise<AgentProvider> | AgentProvider;

export interface ConnectorModule {
  createProvider: CreateProvider;
}

/** Package name → a lazy loader for that connector. Assembled by the CLI. */
export type ConnectorManifest = Record<string, () => Promise<ConnectorModule>>;
