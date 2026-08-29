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
  /** Default model id for new sessions on this provider. */
  model: string;
  /** Model ids offered in the picker (M10e). Defaults to `[model]`. */
  models: string[];
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
}

export const DEFAULT_CONFIG: LoomConfig = {
  baseBranch: "main",
  worktreeDir: ".loom/trees",
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

function strArray(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : fallback;
}

/**
 * Pull every `[providers.<id>]` table with `adapter = "aisdk"` into a profile
 * map. `claude` is handled separately and never treated as an aisdk profile.
 * An `sdk = "openai"` profile with no `base_url` is dropped (nothing to dial);
 * `google` / `anthropic` profiles don't need one.
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
    out[id] = {
      sdk,
      baseUrl,
      apiKeyEnv: str(t["api_key_env"], ""),
      model,
      models,
      tag: str(t["tag"], id),
      color: str(t["color"], ""),
      titleModel: str(t["title_model"], ""),
    };
  }
  return out;
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
  const providers = asRecord(r["providers"]);
  const claude = asRecord(providers["claude"]);
  const aisdk = parseAisdkProfiles(providers);
  const titles = asRecord(r["titles"]);
  const pricing = asRecord(r["pricing"]);
  const notify = asRecord(r["notify"]);
  const budget = asRecord(r["budget"]);

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
    db: str(r["db"], d.db),
    runIsolation,
    defaultProvider,
    daemon: {
      idleShutdownMinutes: num(daemon["idle_shutdown_minutes"], d.daemon.idleShutdownMinutes),
      eventBufferSize: num(daemon["event_buffer_size"], d.daemon.eventBufferSize),
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
      defaultMaxCostUsd: num(budget["default_max_cost_usd"], d.budget.defaultMaxCostUsd),
      onBreach: budget["on_breach"] === "hard" ? "hard" : "soft",
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
