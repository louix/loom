import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

/**
 * Loom configuration. Mirrors the `.loom/config.toml` sketch in the design spec.
 * Milestone 1 only reads a handful of these; the rest are carried so the shape
 * is stable for later milestones.
 */
export interface LoomConfig {
  baseBranch: string;
  worktreeDir: string;
  db: string;
  runIsolation: "in-process" | "subprocess";
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
    adk: {
      model: string;
      auth: "api_key" | "vertex";
    };
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
    adk: {
      model: "gemini-2.5-pro",
      auth: "api_key",
    },
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
  const adk = asRecord(providers["adk"]);
  const titles = asRecord(r["titles"]);
  const pricing = asRecord(r["pricing"]);
  const notify = asRecord(r["notify"]);
  const budget = asRecord(r["budget"]);

  const runIsolation = r["run_isolation"] === "subprocess" ? "subprocess" : "in-process";

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
      adk: {
        model: str(adk["model"], d.providers.adk.model),
        auth: adk["auth"] === "vertex" ? "vertex" : "api_key",
      },
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

/** Load and normalize `.loom/config.toml`; returns defaults if the file is absent. */
export function loadConfig(configPath: string): LoomConfig {
  let raw: unknown = {};
  try {
    raw = parseToml(readFileSync(configPath, "utf8"));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") {
      throw new Error(`failed to read ${configPath}: ${e.message}`);
    }
  }
  return normalizeConfig(raw);
}

/** Resolve a possibly-relative config path against the repo root. */
export function resolveAgainstRepo(repoRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}
