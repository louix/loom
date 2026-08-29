import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

/**
 * Loom configuration. Mirrors the `.loom/config.toml` sketch in the design spec.
 * Milestone 1 only reads a handful of these; the rest are carried so the shape
 * is stable for later milestones.
 */
export type AisdkKind = "openai" | "google" | "anthropic";

/** One Vercel-AI-SDK provider profile (`[providers.<id>]`, `adapter = "aisdk"`). */
export interface AisdkProfile {
  /**
   * Which `@ai-sdk/*` backend: `openai` (OpenAI-compatible — the default),
   * `google` (native Gemini), or `anthropic` (native Anthropic).
   */
  sdk: AisdkKind;
  /**
   * Base URL. Required for `sdk = "openai"`; optional for the others (their
   * SDKs have sensible defaults, override for a proxy / gateway).
   */
  baseUrl: string;
  /** Env var holding the API key; "" for a keyless local endpoint. */
  apiKeyEnv: string;
  /**
   * API key given literally in the config. Wins over `apiKeyEnv`. Convenient,
   * but it's a plaintext secret in a file — prefer `api_key_env` for anything
   * that might get committed or shared.
   */
  apiKey: string;
  /** Default model id for new sessions on this provider. */
  model: string;
  /** Model ids offered in the picker (M10e). Defaults to `[model]`. */
  models: string[];
  /**
   * Neither `model` nor `models` was configured — the daemon fills them from
   * `{base_url}/models` at start-up (openai-compatible endpoints only). Cleared
   * once resolved.
   */
  autoModels: boolean;
  /** Short label for the provider (Detail pane, `loom ls`). Defaults to the id. */
  tag: string;
  /**
   * Colour for this provider's session ids in the Fleet pane. One of Ink's
   * names (cyan / magenta / yellow / green / blue / red …); "" → auto-assign
   * from a palette in config order.
   */
  color: string;
  /** Cheap model for one-shot auto-titling; "" → falls back to `titles.model`. */
  titleModel: string;
}

export interface LoomConfig {
  baseBranch: string;
  worktreeDir: string;
  /**
   * Worktree isolation for new sessions. `enabled` (the default) gives each
   * session its own `git worktree` + branch off `baseBranch`. Off → sessions
   * run directly in the repo working dir: no branch isolation, concurrent
   * sessions can collide, and hard-fork is unavailable (undo still works).
   * `session.create` takes a per-session `worktree` boolean that overrides it.
   */
  worktree: { enabled: boolean };
  db: string;
  runIsolation: "in-process" | "subprocess";
  /** Provider id new sessions use when the client doesn't name one. */
  defaultProvider: string;
  daemon: {
    idleShutdownMinutes: number;
    /** Capacity of the in-memory push-event ring buffer (frames). */
    eventBufferSize: number;
  };
  providers: {
    claude: {
      model: string;
      permissionDefault: "default" | "plan" | "acceptEdits" | "bypassPermissions";
      settingSources: string[];
      disableBuiltin: string[];
      /** Override the Claude Code executable. Empty = discover `claude` on PATH, else the SDK's bundled binary. */
      cliPath: string;
      /**
       * Prompt-cache TTL for the main conversation: "5m", "1h", or "" (let the
       * CLI decide — 1h on a subscription, 5m on an API key). Pinning it makes
       * the TUI's cache-liveness countdown exact.
       */
      promptCacheTtl: "5m" | "1h" | "";
    };
    /**
     * OpenAI-compatible providers, keyed by id (the `[providers.<id>]` table
     * name). Any provider table carrying `adapter = "aisdk"` lands here — GLM,
     * DeepSeek, OpenRouter, a local vLLM / Ollama, OpenAI itself.
     */
    aisdk: Record<string, AisdkProfile>;
  };
  mcp: Array<{ name: string; command: string }>;
  titles: {
    /** Auto-summarise the first message into a session title after turn 1. */
    enabled: boolean;
    /** Model for the one-shot; empty → a per-provider cheap default. */
    model: string;
  };
  pricing: { table: string };
  notify: { webhook: string };
  budget: {
    defaultMaxCostUsd: number;
    onBreach: "soft" | "hard";
  };
  /**
   * `web_search` tool for aisdk sessions (Claude has its own). Off unless a
   * backend is chosen and its key env var is set.
   */
  search: {
    backend: "none" | "brave" | "tavily";
    /** Env var holding the API key. */
    apiKeyEnv: string;
    /** Literal API key; wins over `apiKeyEnv`. Prefer the env var. */
    apiKey: string;
    /** Override the backend's base URL (a proxy, or a test stub). */
    apiBase: string;
    maxResults: number;
  };
}

export const DEFAULT_CONFIG: LoomConfig = {
  baseBranch: "main",
  worktreeDir: ".loom/trees",
  worktree: { enabled: true },
  db: ".loom/loom.db",
  runIsolation: "in-process",
  defaultProvider: "claude",
  daemon: {
    idleShutdownMinutes: 30,
    eventBufferSize: 4096,
  },
  providers: {
    claude: {
      model: "claude-sonnet-5",
      permissionDefault: "default",
      settingSources: ["project"],
      disableBuiltin: ["Grep", "Glob"],
      cliPath: "",
      promptCacheTtl: "1h",
    },
    aisdk: {},
  },
  mcp: [
    { name: "tilth", command: "tilth mcp --edit" },
    { name: "fff", command: "fff-mcp" },
  ],
  titles: { enabled: true, model: "" },
  pricing: { table: ".loom/models.toml" },
  notify: { webhook: "" },
  budget: {
    defaultMaxCostUsd: 5.0,
    onBreach: "soft",
  },
  search: { backend: "none", apiKeyEnv: "", apiKey: "", apiBase: "", maxResults: 5 },
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** A non-negative number, or the fallback (rejects `-1`, NaN, wrong type). */
function nonNeg(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function strArray(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  // Keep the string entries rather than reverting the whole list (and losing an
  // explicit `[]`) because of one stray non-string element.
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * Pull every `[providers.<id>]` table with `adapter = "aisdk"` into a profile
 * map. `claude` is handled separately and never treated as an aisdk profile.
 * An `sdk = "openai"` profile with no `base_url` is dropped (nothing to dial).
 * A profile with no `model` / `models` is kept for `openai` (the daemon probes
 * `{base_url}/models` at start-up, `autoModels`) but dropped for `google` /
 * `anthropic`, which have no uniform model-list endpoint.
 */
function parseAisdkProfiles(providers: Record<string, unknown>): Record<string, AisdkProfile> {
  const out: Record<string, AisdkProfile> = {};
  for (const [id, raw] of Object.entries(providers)) {
    if (id === "claude") continue;
    const t = asRecord(raw);
    if (t["adapter"] !== "aisdk") continue;
    const sdk: AisdkKind =
      t["sdk"] === "google" || t["sdk"] === "anthropic" ? t["sdk"] : "openai";
    const baseUrl = str(t["base_url"], "");
    if (sdk === "openai" && baseUrl === "") continue;
    const model = str(t["model"], "");
    const models = strArray(t["models"], model ? [model] : []);
    const autoModels = model === "" && models.length === 0;
    if (autoModels && sdk !== "openai") continue; // can't auto-detect; nothing to dial
    const effectiveModel = model || (models[0] ?? "");
    out[id] = {
      sdk,
      baseUrl,
      apiKeyEnv: str(t["api_key_env"], ""),
      apiKey: str(t["api_key"], ""),
      model: effectiveModel,
      models: models.length > 0 ? models : effectiveModel ? [effectiveModel] : [],
      autoModels,
      tag: str(t["tag"], id),
      color: str(t["color"], ""),
      titleModel: str(t["title_model"], ""),
    };
  }
  return out;
}

/**
 * The API key for an aisdk profile / `[search]`: an inline `api_key` wins,
 * else `api_key_env` is looked up in the environment, else "" (a keyless
 * local endpoint).
 */
export function resolveApiKey(
  src: { apiKey?: string; apiKeyEnv?: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (src.apiKey) return src.apiKey;
  if (src.apiKeyEnv) return env[src.apiKeyEnv] ?? "";
  return "";
}

/**
 * Human-readable warnings about the loaded config — misconfigured providers,
 * env vars that aren't set, models that will be auto-detected, a keyless search
 * backend. `normalizeConfig` has already coerced an unknown `default_provider`
 * to `claude`, so that's not re-checked here. Logged at daemon start-up and
 * available over `config.check` / `loom config`.
 */
export function lintConfig(cfg: LoomConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const w: string[] = [];
  for (const [id, p] of Object.entries(cfg.providers.aisdk)) {
    if (p.sdk === "openai" && p.baseUrl === "") {
      w.push(`provider "${id}": sdk = "openai" needs a base_url`);
    }
    if (!p.apiKey && p.apiKeyEnv && !env[p.apiKeyEnv]) {
      w.push(`provider "${id}": $${p.apiKeyEnv} is not set`);
    }
    if (!p.apiKey && !p.apiKeyEnv && p.sdk !== "openai") {
      w.push(`provider "${id}": sdk = "${p.sdk}" needs an api_key / api_key_env`);
    }
    if (p.autoModels) {
      w.push(`provider "${id}": no model configured — will auto-detect from ${p.baseUrl}/models at start-up`);
    }
  }
  if (cfg.search.backend !== "none" && !cfg.search.apiKey) {
    if (!cfg.search.apiKeyEnv) {
      w.push(`search: backend = "${cfg.search.backend}" but no api_key / api_key_env — web_search stays disabled`);
    } else if (!env[cfg.search.apiKeyEnv]) {
      w.push(`search: $${cfg.search.apiKeyEnv} is not set — web_search stays disabled`);
    }
  }
  return w;
}

/**
 * Parse a raw TOML tree into a fully-populated LoomConfig, filling any missing
 * key from DEFAULT_CONFIG. Unknown keys are ignored. Enum-typed fields fall back
 * to the default when the value is not one of the permitted literals.
 */
export function normalizeConfig(raw: unknown): LoomConfig {
  const r = asRecord(raw);
  const d = DEFAULT_CONFIG;

  const daemon = asRecord(r["daemon"]);
  const worktree = asRecord(r["worktree"]);
  const providers = asRecord(r["providers"]);
  const claude = asRecord(providers["claude"]);
  const aisdk = parseAisdkProfiles(providers);
  const titles = asRecord(r["titles"]);
  const pricing = asRecord(r["pricing"]);
  const notify = asRecord(r["notify"]);
  const budget = asRecord(r["budget"]);
  const search = asRecord(r["search"]);

  const runIsolation = r["run_isolation"] === "subprocess" ? "subprocess" : "in-process";

  // The default provider must actually be configured; fall back to claude.
  const wantDefault = str(r["default_provider"], d.defaultProvider);
  const defaultProvider = wantDefault === "claude" || wantDefault in aisdk ? wantDefault : "claude";

  const permDefault = claude["permission_default"];
  const permissionDefault =
    permDefault === "plan" ||
    permDefault === "acceptEdits" ||
    permDefault === "bypassPermissions" ||
    permDefault === "default"
      ? permDefault
      : d.providers.claude.permissionDefault;

  const mcpRaw = Array.isArray(r["mcp"]) ? (r["mcp"] as unknown[]) : null;
  const mcp = mcpRaw
    ? mcpRaw
        .map((entry) => {
          const e = asRecord(entry);
          return { name: str(e["name"], ""), command: str(e["command"], "") };
        })
        .filter((e) => e.name !== "" && e.command !== "")
    : d.mcp;

  return {
    baseBranch: str(r["base_branch"], d.baseBranch),
    worktreeDir: str(r["worktree_dir"], d.worktreeDir),
    worktree: {
      enabled: typeof worktree["enabled"] === "boolean" ? worktree["enabled"] : d.worktree.enabled,
    },
    db: str(r["db"], d.db),
    runIsolation,
    defaultProvider,
    daemon: {
      idleShutdownMinutes: nonNeg(daemon["idle_shutdown_minutes"], d.daemon.idleShutdownMinutes),
      eventBufferSize: Math.max(1, nonNeg(daemon["event_buffer_size"], d.daemon.eventBufferSize)),
    },
    providers: {
      claude: {
        model: str(claude["model"], d.providers.claude.model),
        permissionDefault,
        settingSources: strArray(claude["setting_sources"], d.providers.claude.settingSources),
        disableBuiltin: strArray(claude["disable_builtin"], d.providers.claude.disableBuiltin),
        cliPath: str(claude["cli_path"], d.providers.claude.cliPath),
        promptCacheTtl:
          claude["prompt_cache_ttl"] === "5m" ||
          claude["prompt_cache_ttl"] === "1h" ||
          claude["prompt_cache_ttl"] === ""
            ? (claude["prompt_cache_ttl"] as "5m" | "1h" | "")
            : d.providers.claude.promptCacheTtl,
      },
      aisdk,
    },
    mcp,
    titles: {
      enabled: typeof titles["enabled"] === "boolean" ? titles["enabled"] : d.titles.enabled,
      model: str(titles["model"], d.titles.model),
    },
    pricing: { table: str(pricing["table"], d.pricing.table) },
    notify: { webhook: str(notify["webhook"], d.notify.webhook) },
    budget: {
      defaultMaxCostUsd: nonNeg(budget["default_max_cost_usd"], d.budget.defaultMaxCostUsd),
      onBreach: budget["on_breach"] === "hard" ? "hard" : "soft",
    },
    search: {
      backend: search["backend"] === "brave" || search["backend"] === "tavily" ? search["backend"] : "none",
      apiKeyEnv: str(search["api_key_env"], d.search.apiKeyEnv),
      apiKey: str(search["api_key"], d.search.apiKey),
      apiBase: str(search["api_base"], d.search.apiBase),
      maxResults: Math.max(1, nonNeg(search["max_results"], d.search.maxResults)),
    },
  };
}

function readTomlIfPresent(path: string): Record<string, unknown> | null {
  try {
    const parsed = parseToml(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw new Error(`failed to read ${path}: ${e.message}`);
  }
}

/** Recursive object merge; `over` wins. Arrays and scalars are replaced wholesale. */
export function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    if (
      b &&
      v &&
      typeof b === "object" &&
      typeof v === "object" &&
      !Array.isArray(b) &&
      !Array.isArray(v)
    ) {
      out[k] = deepMerge(b as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Load and normalize config. The per-repo `.loom/config.toml` is layered on top
 * of the user-level `userConfigPath` (when given); either may be absent.
 */
export function loadConfig(repoConfigPath: string, userConfigPath?: string): LoomConfig {
  let raw: Record<string, unknown> = {};
  if (userConfigPath) {
    const u = readTomlIfPresent(userConfigPath);
    if (u) raw = u;
  }
  const r = readTomlIfPresent(repoConfigPath);
  if (r) raw = deepMerge(raw, r);
  return normalizeConfig(raw);
}

/** Resolve a possibly-relative config path against the repo root. */
export function resolveAgainstRepo(repoRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}
