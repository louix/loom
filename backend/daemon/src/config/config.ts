import {
  normalizeSessionEnvironment,
  type SessionEnvironment,
} from "../../../../core/src/session-environment.ts";
import { bundledRuntime } from "../../../../runtime/src/packaged/artifact.ts";
import {
  normalizeExtraHosts,
  expandNetworkPresets,
} from "../../../../runtime/src/session-vm/network-policy.ts";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { onPath, tryFindRepoRoot } from "@loom/core/paths";
import { isClaudeId } from "@loom/core/provider-id";
import type { McpCapability } from "@loom/core/types";
import { createConfigSchema, providerSchema, parseSettings } from "./schema.ts";
import { userConfigPath } from "../config-path.ts";
import type { PriceRow } from "./pricing.ts";
import { resolveToolSelection, toolExecutionError } from "./tool-selection.ts";

/**
 * Loom configuration, loaded only from the trusted user config file.
 * Milestone 1 only reads a handful of these; the rest are carried so the shape
 * is stable for later milestones.
 */
export type AisdkKind = "openai" | "google" | "anthropic" | "chatgpt";

/** Resolved provider profile; the config family selects its internal SDK. */
export interface AisdkProfile {
  /**
   * Which backend: `openai` (OpenAI-compatible — the default), `google`
   * (native Gemini), `anthropic` (native Anthropic), or `chatgpt` (the Codex
   * OAuth subscription endpoint).
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
  /**
   * Optional model pin. Normally left unset: the picker's model list comes from
   * `{base_url}/models` and a new session defaults to the last model this
   * provider ran (remembered in the db). Set it only to force a specific model
   * on an endpoint whose `/models` is missing or wrong.
   */
  model: string;
  /** Optional explicit picker list, when `/models` can't be trusted. Defaults to `[model]`. */
  models: string[];
  /** Per-model context windows discovered from the provider catalog. */
  modelContext: Record<string, number>;
  /**
   * Per-model USD-per-million prices advertised by the endpoint's `/models`
   * (`pricing` rows — sference, OpenRouter). Filled from the probe; feeds the
   * cost table for models the user's `models.toml` doesn't price.
   */
  modelPricing: Record<string, PriceRow>;
  /** Per-model display names advertised by the endpoint (`display_name`). */
  modelLabels: Record<string, string>;
  /**
   * Per-model reasoning-effort levels advertised by the endpoint's `/models`
   * (`supported_reasoning_efforts`, or OpenRouter's `reasoning.supported_efforts`).
   * Filled from the probe; gates the thinking-effort picker for this provider.
   */
  modelEfforts: Record<string, string[]>;
  /** Per-model default effort advertised by the endpoint (`default_reasoning_effort`). */
  modelDefaultEffort: Record<string, string>;
  /**
   * Ask the endpoint to include token usage in streaming responses
   * (`stream_options.include_usage`). On by default — without it, endpoints
   * like sference stream no usage at all, leaving the context meter and cost
   * at zero. Set `include_usage = false` for an endpoint that rejects the
   * field outright.
   */
  includeUsage: boolean;
  /**
   * Neither `model` nor `models` was configured (the normal case) — the daemon
   * fills `models` from `{base_url}/models` at start-up (openai-compatible
   * endpoints only). Cleared once resolved; stays true if detection failed.
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
  /**
   * Prompt-cache TTL for `sdk = "anthropic"`: "5m", "1h", or "off". Default ""
   * — cache with the API's own default lifetime (5 minutes).
   *
   * Loom asks for one cache breakpoint per turn, so each turn caches the
   * conversation so far and the next one reads it back; "off" stops asking,
   * which means paying full input price for the whole history every turn. A 1h
   * write costs 2x base input against 1.25x for 5m, and only pays for itself
   * across gaps longer than five minutes.
   *
   * Ignored by the other SDKs: OpenAI-compatible endpoints cache implicitly
   * server-side with no request field to set, and Gemini has its own scheme.
   */
  promptCacheTtl: "5m" | "1h" | "off" | "";
  /** Cheap model for one-shot auto-titling; "" → a cheap default for this provider. */
  titleModel: string;
  /** Codex home directory; empty uses CODEX_HOME, then ~/.codex. */
  configDir: string;
  /** Explicit `codex` executable for `sdk = "chatgpt"`. Empty resolves `codex` on PATH. */
  codexCliPath: string;
  /** Keep Codex's native web search alongside Loom's configured search. Default false — set explicitly to opt in. */
  codexBuiltinWebSearch: boolean;
}

/**
 * One Claude profile — a named `~/.claude`-style config directory. Each becomes
 * its own provider: the first / unnamed one keeps the id `claude`, a named one
 * gets `claude:<slug>` (see {@link claudeProfileId}). The `dir` is handed to the
 * SDK subprocess as `CLAUDE_CONFIG_DIR`, so a user with `~/.claude-personal` and
 * `~/.claude-work` can run both at once without symlink-swapping.
 */
export interface ClaudeProfile {
  /** Config dir, tilde-expanded and absolute after `normalizeConfig`. */
  dir: string;
  /** Profile name and id-slug source; "" → the base `claude` id. */
  name: string;
  /** Resolved display label: configured tag, profile name, then provider name. */
  tag?: string;
  /** Fleet-row id colour (Ink name); "" → auto-assign from a palette. */
  color: string;
}

/**
 * What a `hooks` entry can fire on. Two families:
 *
 *  - *Write* events — `file_write` (one tool call that wrote files, fired as
 *    soon as its result lands) and `turn_end` (once per turn, with every file
 *    the turn wrote). A linter usually wants `turn_end`; a formatter that
 *    should run shortly after an edit wants `file_write` (asynchronous).
 *  - *Waiting* events — the turn stopped and wants a human: `waiting` covers
 *    every blocked reason at once, and `permission` / `question` /
 *    `plan_review` / `user_question` name one apiece. `error` and `interrupted`
 *    are the other two ways a turn stops without finishing.
 *
 * `turn_end` fires on any completed turn, including one that wrote nothing.
 */
export type HookEvent =
  | "init"
  | "file_write"
  | "turn_end"
  | "waiting"
  | "permission"
  | "question"
  | "plan_review"
  | "user_question"
  | "error"
  | "interrupted";

export const HOOK_EVENTS: readonly HookEvent[] = [
  "init",
  "file_write",
  "turn_end",
  "waiting",
  "permission",
  "question",
  "plan_review",
  "user_question",
  "error",
  "interrupted",
];

/** One `hooks` entry, normalized. */
export type WriteHookEvent = "file_write" | "turn_end" | "init";

export type HookConfig = HookFields &
  ({ kind: "check"; on: WriteHookEvent[] } | { kind: "notify"; on: HookEvent[] });

interface HookFields {
  async?: boolean;
  /** Label for logs and the agent-facing failure message; defaults to `run`'s first word. */
  name: string;
  /** Notification delivery gate; defaults to always. */
  when: "always" | "unfocused" | "disconnected";
  /** The command, run through `sh -c` in the session's worktree. */
  run: string;
  /**
   * Restrict the hook to one repo. A glob against the daemon's absolute
   * repo root (`~` expanded, `**` crosses `/`), so `~/dev/loom` pins one
   * project and `~/dev/**` covers everything under a directory. "" = every
   * repo. Hooks inside a matching `repo` override already apply only there.
   *
   * Global hooks are inherited by every repo; matching repo hooks append to them.
   * Use this field to restrict a global hook to a project or group of projects.
   */
  project: string;
  /**
   * Path globs gating the *write* events; a hook fires only if at least one
   * written file matches (tested against both the absolute path and the path
   * relative to the session's worktree). Empty = every path. Ignored by the
   * waiting events, which have no files.
   */
  match: string[];
  /** Wall-clock ceiling for the command, in ms. Default 30s, clamped 1s–10min. */
  timeoutMs: number;
}

export interface LoomConfig {
  autoNix: boolean;
  tui: { includeEventLogInEditor: boolean };
  providerAccess: { only?: string[]; disabled: string[] };
  isolation: {
    /** Project-wide default for new sessions; runtime availability is separate. */
    enabled?: boolean;
    /** Available runtimes, including ones disabled as the default. */
    runtimes?: Partial<Record<"claude" | "aisdk" | "codex", { artifact: string; smolvm: string }>>;
    claude?: { artifact: string; smolvm: string };
    aisdk?: { artifact: string; smolvm: string };
    codex?: { artifact: string; smolvm: string };
    extraAllowedHosts: string[];
    idleTimeoutMinutes?: number;
    environment?: SessionEnvironment;
    /** How new VM sessions reach the repository. Absent means mount. */
    checkout?: { mode: "mount" | "clone"; visibleRefs: string[]; maxPushBytes: number };
  };
  baseBranch: string;
  worktreeDir: string;
  /**
   * Claude config directories to expose as providers. Always non-empty —
   * defaults to a single `~/.claude` (id `claude`). Order is stable: entry 0 is
   * the fallback `default_provider`.
   */
  claudeProfiles: ClaudeProfile[];
  /**
   * Worktree isolation for new sessions. `enabled` (the default) gives each
   * session its own `git worktree` + branch off `baseBranch`. Off → sessions
   * run directly in the repo working dir: no branch isolation, concurrent
   * sessions can collide, and hard-fork is unavailable (undo still works).
   * `session.create` takes a per-session `worktree` boolean that overrides it.
   */
  worktree: { enabled: boolean };
  /**
   * Keep a session's branch current with its base. When `enabled`, the daemon —
   * each time a session goes idle — replays (or merges) the branch onto the
   * base branch if the base has advanced and the worktree is clean. A clean
   * update is silent (an operator notice only); a conflict, or an uncommitted
   * worktree, sends the agent a message asking it to integrate the base itself.
   * Off by default: history is only rewritten when you opt in.
   */
  autoRebase: { enabled: boolean; mode: "rebase" | "merge" };
  /**
   * Re-drive agents a daemon restart cut off mid-turn. When `enabled` (the
   * default), sessions the previous daemon left actively working (`running` /
   * `starting` / `working_background`) are revived from their persisted
   * transcript and sent a message to continue. Sessions blocked on a human
   * decision (`awaiting_input`) are always left interrupted — Loom never
   * answers a permission prompt or question by itself.
   */
  autoResume: { enabled: boolean };
  /**
   * Remind the agent about an uncommitted worktree. When `enabled` (the
   * default), a session that goes idle with uncommitted changes gets a one-off
   * message suggesting it commit — one per commit boundary, so a tree left dirty
   * on purpose stops nagging until the next commit. Never commits anything
   * itself; in-place sessions (no isolated worktree) are exempt.
   */
  commitReminder: { enabled: boolean };
  db: string;
  /** Provider id new sessions use when the client doesn't name one. */
  defaultProvider: string;
  daemon: {
    idleShutdownMinutes: number;
  };
  providers: {
    claude: {
      model: string;
      /** Model for automatic session titles; empty uses the provider default. */
      titleModel: string;
      /** Models offered in the TUI picker (`M` / `⌥p`). Empty = the daemon asks
       *  the Claude CLI for its catalog at start-up; set it to pin a curated
       *  list and skip that probe. */
      models: string[];
      permissionDefault: "default" | "plan" | "acceptEdits" | "bypassPermissions";
      settingSources: string[];
      disableBuiltin: string[];
      /** Override the Claude Code executable. Empty = discover `claude` on PATH, else the SDK's bundled binary. */
      cliPath: string;
      workerAllowedHosts?: string[];
      /**
       * Prompt-cache TTL for the main conversation: "5m", "1h", or "" (the
       * default — let the CLI decide, which is 1h on a subscription within its
       * usage limits and 5m on an API key, Bedrock, Vertex or Foundry).
       *
       * Loom used to pin "1h" so the cache countdown had a number to run on;
       * it now measures the TTL off each response instead, so the pin is no
       * longer load-bearing and the CLI — which knows the account type — is
       * the better judge. Set it only to override that judgement, remembering
       * a 1h cache write costs 2x base input against 1.25x for 5m.
       */
      promptCacheTtl: "5m" | "1h" | "";
    };
    /** Resolved native API, Codex and OpenAI-compatible profiles, keyed by id. */
    aisdk: Record<string, AisdkProfile>;
  };
  mcp: Array<
    { name: string; defaultFor?: McpCapability[]; required?: boolean } & (
      | { command: string; args?: string[] }
      | { runtime: string; isolation: "vm" }
    )
  >;
  httpMcp: Array<{
    name: string;
    required?: boolean;
    url: string;
    bearerTokenEnv: string;
    /** Inline credential, when supplied, takes precedence over the environment. */
    bearerToken?: string;
    defaultFor: McpCapability[];
  }>;
  titles: {
    /** Auto-summarise the first message into a session title after turn 1. */
    enabled: boolean;
  };
  notify: { webhook: string };
  /**
   * Shell commands the daemon runs when something happens in a session — a
   * linter after the agent edits a file, `notify-send` when a turn parks on a
   * question. Configured as `hooks`, in the user-level config and/or the
   * per-repo one.
   *
   * Unrelated to `.loom/hooks/` on disk, which holds the git `pre-push` block
   * installed into session worktrees.
   */
  hooks: HookConfig[];
  /**
   * `web_search` tool for aisdk sessions (Claude has its own). Off unless a
   * backend is chosen and its key env var is set. Hosted search MCP servers
   * are configured with [remote_tools.<name>].
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
  autoNix: false,
  tui: { includeEventLogInEditor: false },
  baseBranch: "main",
  worktreeDir: ".loom/trees",
  providerAccess: { disabled: [] },
  isolation: { enabled: false, extraAllowedHosts: [] },
  claudeProfiles: [{ dir: "~/.claude", name: "", color: "" }],
  worktree: { enabled: true },
  autoRebase: { enabled: false, mode: "rebase" },
  autoResume: { enabled: true },
  commitReminder: { enabled: true },
  db: ".loom/loom.db",
  defaultProvider: "claude",
  daemon: {
    idleShutdownMinutes: 30,
  },
  providers: {
    claude: {
      model: "claude-sonnet-5",
      titleModel: "",
      models: [],
      permissionDefault: "default",
      settingSources: ["project"],
      disableBuiltin: [],
      cliPath: "",
      promptCacheTtl: "",
    },
    aisdk: {},
  },
  mcp: [],
  httpMcp: [],
  titles: { enabled: true },
  notify: { webhook: "" },
  hooks: [],
  search: { backend: "none", apiKeyEnv: "", apiKey: "", apiBase: "", maxResults: 5 },
};

const asRecord = (v: unknown): Record<string, unknown> => {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
};

const settingsSchema = createConfigSchema(DEFAULT_CONFIG, HOOK_EVENTS);

/** Expand a leading `~` / `~/` against the home directory; other paths pass through. */
export const expandTilde = (p: string): string => {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
};

/**
 * A Claude profile `name` → id slug: lowercased, non-alphanumerics collapsed to
 * `-`, trimmed. "" (and the redundant "claude") collapse onto the base id.
 */
export const slugifyProfile = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "claude" ? "" : slug;
};

/** Provider id for a Claude profile: `claude`, or `claude:<slug>` when named. */
export const claudeProfileId = (p: { name: string }): string => {
  const slug = slugifyProfile(p.name);
  return slug ? `claude:${slug}` : "claude";
};

/**
 * `providers.claude.profiles` → a stable, de-duplicated list. A missing / empty `dir`
 * drops the entry; a second entry that resolves to an id already taken is
 * dropped (both flagged by {@link lintConfig}). Always returns at least the
 * default `~/.claude` profile.
 */
const parseClaudeProfiles = (rows: ClaudeProfile[]): ClaudeProfile[] => {
  const out: ClaudeProfile[] = [];
  const seen = new Set<string>();
  for (const entry of rows) {
    const dir = entry.dir;
    if (dir === "") continue;
    const profile: ClaudeProfile = {
      dir: expandTilde(dir),
      name: entry.name,
      ...(entry.tag !== undefined ? { tag: entry.tag } : {}),
      color: entry.color,
    };
    const id = claudeProfileId(profile);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(profile);
  }
  if (out.length === 0)
    return DEFAULT_CONFIG.claudeProfiles.map((p) => ({ ...p, dir: expandTilde(p.dir) }));
  return out;
};

/**
 * Build one aisdk profile from a config table. `sdk = "openai"` with no
 * `base_url` is dropped (nothing to dial). No `model` / `models` is kept for
 * `openai` (the daemon probes `{base_url}/models` at start-up, `autoModels`)
 * but dropped for `google` / `anthropic`, which have no uniform model-list
 * endpoint. ChatGPT subscription profiles use Codex's authenticated catalog.
 * Returns `null` when the table can't yield a usable
 * profile.
 */
const buildAisdkProfile = (
  id: string,
  t: Record<string, unknown>,
  sdk: AisdkKind,
): AisdkProfile | null => {
  const p = parseSettings(providerSchema, t);
  const baseUrl = p.base_url;
  if (sdk === "openai" && baseUrl === "") return null;
  const model = p.model;
  const models = p.models ?? (model ? [model] : []);
  const autoModels = model === "" && models.length === 0;
  if (autoModels && sdk !== "openai" && sdk !== "chatgpt") return null;
  const effectiveModel = model || (models[0] ?? "");
  const effectiveModelList = effectiveModel ? [effectiveModel] : [];
  let defaultTag = id;
  if (sdk === "chatgpt") defaultTag = id === "codex" ? "Codex" : id.slice("codex:".length);
  return {
    sdk,
    baseUrl,
    apiKeyEnv: p.api_key_env,
    apiKey: p.api_key,
    model: effectiveModel,
    models: models.length > 0 ? models : effectiveModelList,
    modelContext: {},
    modelPricing: {},
    modelLabels: {},
    modelEfforts: {},
    modelDefaultEffort: {},
    includeUsage: p.include_usage,
    autoModels,
    tag: p.tag ?? defaultTag,
    color: p.color,
    promptCacheTtl: p.prompt_cache_ttl,
    titleModel: p.title_model,
    configDir: expandTilde(p.config_dir),
    codexCliPath: expandTilde(p.cli_path),
    codexBuiltinWebSearch: p.builtin_web_search,
  };
};

/** Family defaults merge into each named profile before runtime defaults are applied. */
const parseAisdkProfiles = (raw: Record<string, unknown>): Record<string, AisdkProfile> => {
  const out: Record<string, AisdkProfile> = {};
  const providers = asRecord(raw.providers);
  for (const [family, sdk] of Object.entries({
    codex: "chatgpt",
    google: "google",
    anthropic: "anthropic",
    openai_compatible: "openai",
  } as const)) {
    if (!Object.hasOwn(providers, family)) continue;
    const { profiles, ...defaults } = asRecord(providers[family]);
    const entries =
      profiles === undefined && family !== "openai_compatible"
        ? { default: {} }
        : asRecord(profiles);
    for (const [name, overrides] of Object.entries(entries)) {
      let id = name;
      if (family !== "openai_compatible") id = name === "default" ? family : `${family}:${name}`;
      if (isClaudeId(id) || id === "fake" || id === "mock" || id in out)
        throw new Error(`Reserved or duplicate provider id: ${id}`);
      const profile = buildAisdkProfile(id, deepMerge(defaults, asRecord(overrides)), sdk);
      if (profile) out[id] = profile;
    }
  }
  return out;
};

/**
 * The API key for an aisdk profile / `search`: an inline `api_key` wins,
 * else `api_key_env` is looked up in the environment, else "" (a keyless
 * local endpoint).
 */
export const resolveApiKey = (
  src: { apiKey?: string; apiKeyEnv?: string },
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string => {
  if (src.apiKey) return src.apiKey;
  if (src.apiKeyEnv) return env[src.apiKeyEnv] ?? "";
  return "";
};

/**
 * Human-readable warnings about the loaded config — misconfigured providers,
 * env vars that aren't set, models that will be auto-detected, a keyless search
 * backend. `normalizeConfig` has already coerced an unknown `default_provider`
 * to `claude`, so that's not re-checked here. Logged at daemon start-up and
 * available over `config.check` / `loom config`.
 */
/** `sh` builtins and reserved words — never on PATH, yet always runnable. */
const SH_BUILTINS = new Set(
  (
    ". : break continue eval exec exit export readonly return set shift times trap unset " +
    "alias bg cd command false fg getopts hash jobs kill read type ulimit umask unalias wait " +
    "true echo printf test pwd local source if for while until case"
  ).split(" "),
);

export const lintConfig = (
  cfg: LoomConfig,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string[] => {
  const w: string[] = [];
  for (const p of cfg.claudeProfiles) {
    if (!existsSync(p.dir)) {
      w.push(`claude profile "${claudeProfileId(p)}": dir ${p.dir} does not exist`);
    }
  }
  for (const [id, p] of Object.entries(cfg.providers.aisdk)) {
    if (p.sdk === "openai" && p.baseUrl === "") {
      w.push(`provider "${id}": sdk = "openai" needs a base_url`);
    }
    if (!p.apiKey && p.apiKeyEnv && !env[p.apiKeyEnv]) {
      w.push(`provider "${id}": $${p.apiKeyEnv} is not set`);
    }
    if (!p.apiKey && !p.apiKeyEnv && p.sdk !== "openai" && p.sdk !== "chatgpt") {
      w.push(`provider "${id}": sdk = "${p.sdk}" needs an api_key / api_key_env`);
    }
    if (p.autoModels && p.model === "" && p.models.length === 0) {
      w.push(
        `provider "${id}": no models — auto-detection from ${p.baseUrl}/models found none ` +
          "(endpoint unreachable, or it has no /models); set `model` / `models` to pin one",
      );
    }
  }
  for (const h of cfg.hooks) {
    // The command runs through `sh -c`, so only a plain leading word is worth
    // probing — a pipeline, a `VAR=x cmd`, or an absolute path is the user's
    // business. This catches the common miss: `notify-send` on a box without it.
    const word = h.run.split(/\s+/)[0] ?? "";
    if (/^[\w.-]+$/.test(word) && !SH_BUILTINS.has(word) && !onPath(word, env)) {
      w.push(`hook "${h.name}": \`${word}\` is not on PATH — the hook will fail every time`);
    }
    if (h.match.length > 0 && !h.on.some((e) => e === "file_write" || e === "turn_end")) {
      w.push(
        `hook "${h.name}": \`match\` only filters file_write / turn_end — it does nothing for ${h.on.join(", ")}`,
      );
    }
  }
  if (cfg.search.backend !== "none" && !cfg.search.apiKey) {
    if (!cfg.search.apiKeyEnv) {
      w.push(
        `search: backend = "${cfg.search.backend}" but no api_key / api_key_env — web_search stays disabled`,
      );
    } else if (!env[cfg.search.apiKeyEnv]) {
      w.push(`search: $${cfg.search.apiKeyEnv} is not set — web_search stays disabled`);
    }
  }
  for (const m of cfg.mcp) {
    if ("command" in m && !onPath(m.command, env))
      w.push(`Required host tool "${m.name}": executable ${m.command} is unavailable`);
  }
  for (const id of [
    ...cfg.claudeProfiles.map(claudeProfileId),
    ...Object.keys(cfg.providers.aisdk),
  ]) {
    const error = toolExecutionError(cfg, id);
    if (error) w.push(error);
  }
  for (const m of cfg.httpMcp) {
    if (!m.bearerToken && m.bearerTokenEnv && !env[m.bearerTokenEnv])
      w.push(`MCP "${m.name}": $${m.bearerTokenEnv} is not set — session creation will fail`);
  }
  return w;
};

/**
 * Parse a raw config object into a fully-populated LoomConfig, filling any missing
 * key from DEFAULT_CONFIG. Unknown keys are ignored. Enum-typed fields fall back
 * to the default when the value is not one of the permitted literals.
 */
export const normalizeConfig = (raw: unknown): LoomConfig => {
  const r = asRecord(raw);
  if (["command-mcp", "http-mcp", "mcp"].some((key) => key in r))
    throw new Error(
      "Define local_tools, vm_tools or remote_tools by name and select them under session.",
    );
  const settings = parseSettings(settingsSchema, raw);
  const {
    session: {
      isolation,
      provider_access: { only, disabled },
    },
    providers: { claude },
  } = settings;
  const vmEnabled = isolation.enabled;
  const runtimes: NonNullable<LoomConfig["isolation"]["runtimes"]> = {};
  for (const name of ["claude", "aisdk", "codex"] as const) {
    const value = isolation[name];
    const bundle = bundledRuntime(name);
    const artifact = value["artifact"] ?? bundle?.artifact;
    if (artifact === undefined) {
      if (value["smolvm"] !== undefined)
        throw new Error(`session.isolation.${name} requires an artifact path`);
      continue;
    }
    runtimes[name] = {
      artifact: expandTilde(artifact),
      smolvm: expandTilde(value.smolvm ?? bundle?.smolvm ?? "smolvm"),
    };
  }
  const aisdk = parseAisdkProfiles(r);
  const claudeProfiles = parseClaudeProfiles(
    Object.entries(claude.profiles).map(([name, p]) => ({
      name: name === "default" ? "" : name,
      dir: p.config_dir,
      ...(p.tag !== undefined ? { tag: p.tag } : {}),
      color: p.color,
    })),
  );
  for (const profile of claudeProfiles) {
    profile.tag = profile.tag ?? claude.tag ?? (profile.name || "Claude");
  }
  const claudeIds = new Set(claudeProfiles.map(claudeProfileId));

  // The default provider must actually be configured; fall back to claude.
  const wantDefault = settings.default_provider;
  const defaultProvider =
    claudeIds.has(wantDefault) || wantDefault in aisdk || ["fake", "mock"].includes(wantDefault)
      ? wantDefault
      : "claude";

  const { mcp, httpMcp } = resolveToolSelection(settings);

  return {
    autoNix: settings.session.auto_nix,
    tui: { includeEventLogInEditor: settings.tui.include_event_log_in_editor },
    baseBranch: settings.base_branch,
    worktreeDir: settings.worktree_dir,
    providerAccess: { ...(only ? { only } : {}), disabled },
    isolation: {
      enabled: vmEnabled,
      idleTimeoutMinutes: isolation.idle_timeout_minutes,
      runtimes,
      extraAllowedHosts: [
        ...new Set([
          ...normalizeExtraHosts(isolation.extra_allowed_hosts),
          ...expandNetworkPresets(isolation.network_presets),
        ]),
      ],
      environment: normalizeSessionEnvironment(isolation.environment, settings.session.auto_nix),
      checkout: {
        mode: isolation.checkout.mode,
        visibleRefs: isolation.checkout.visible_refs,
        maxPushBytes: isolation.checkout.max_push_bytes,
      },
      ...(vmEnabled ? runtimes : {}),
    },
    claudeProfiles,
    worktree: settings.session.worktree,
    autoRebase: settings.session.auto_rebase,
    autoResume: settings.session.auto_resume,
    commitReminder: settings.session.commit_reminder,
    db: settings.db,
    defaultProvider,
    daemon: {
      idleShutdownMinutes: settings.daemon.idle_shutdown_minutes,
    },
    providers: {
      claude: {
        model: claude.model,
        titleModel: claude.title_model,
        models: claude.models,
        permissionDefault: claude.permission_default,
        settingSources: claude.setting_sources,
        disableBuiltin: claude.disable_builtin,
        cliPath: claude.cli_path,
        ...(claude["worker_allowed_hosts"] !== undefined
          ? { workerAllowedHosts: claude.worker_allowed_hosts }
          : {}),
        promptCacheTtl: claude.prompt_cache_ttl,
      },
      aisdk,
    },
    mcp,
    httpMcp,
    titles: settings.session.titles,
    notify: settings.session.notify,
    hooks: settings.hooks.map((h): HookConfig => ({
      ...(h.kind === "check"
        ? { kind: h.kind, on: h.on as WriteHookEvent[] }
        : { kind: h.kind, on: h.on }),
      name: h.name || h.run.split(/\s+/)[0]!,
      run: h.run,
      when: h.when,
      project: expandTilde(h.project),
      match: h.match,
      timeoutMs: h.timeout,
      async: h.async,
    })),
    search: {
      backend: settings.search.backend,
      apiKeyEnv: settings.search.api_key_env,
      apiKey: settings.search.api_key,
      apiBase: settings.search.api_base,
      maxResults: settings.search.max_results,
    },
  };
};

/** JSONC accepts comments and trailing commas, but never partial or non-object configs. */
export const parseConfig = (text: string): Record<string, unknown> => {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
  if (errors.length) {
    const error = errors[0]!;
    const before = text.replace(/^\uFEFF/, "").slice(0, error.offset);
    const line = before.split("\n").length;
    const column = before.length - before.lastIndexOf("\n");
    throw new Error(
      `Invalid JSONC at line ${line}, column ${column}: ${printParseErrorCode(error.error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Config must be a JSON object");
  return parsed as Record<string, unknown>;
};

const readConfigIfPresent = (path: string): Record<string, unknown> | null => {
  try {
    return parseConfig(readFileSync(path, "utf8"));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw new Error(`failed to read ${path}: ${e.message}`);
  }
};

/** Recursive object merge; `over` wins. Arrays and scalars are replaced wholesale. */
export const deepMerge = (
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    // A JSON `__proto__` property can be an own key that
    // would otherwise walk the prototype on assignment.
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
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
};

/** Git repository identity; missing repo entries may remain configured after a move. */
const configRepoPath = (path: string): string => {
  let expanded = path;
  if (path === "~") expanded = homedir();
  else if (path.startsWith("~/")) expanded = join(homedir(), path.slice(2));
  if (!isAbsolute(expanded)) throw new Error("repo.path must be an absolute path or start with ~/");
  try {
    const canonical = realpathSync(expanded);
    return tryFindRepoRoot(canonical) ?? canonical;
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return resolve(expanded);
  }
};

/** User defaults plus one repo override matched by Git identity. No repo-local config. */
export const loadConfig = (repoRoot: string, configFile = userConfigPath()): LoomConfig => {
  const raw = readConfigIfPresent(configFile) ?? {};
  const { repos = [], ...defaults } = raw;
  if (!Array.isArray(repos)) throw new Error("repos must be an array of objects");
  const target = configRepoPath(resolve(repoRoot));
  const seen = new Set<string>();
  let selected: Record<string, unknown> = {};
  for (const entry of repos) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.path !== "string" ||
      !entry.path.trim()
    )
      throw new Error("Every repos entry requires a nonempty path");
    if ("repos" in entry) throw new Error("Nested repos overrides are not supported");
    const path = configRepoPath(entry.path);
    if (seen.has(path)) throw new Error(`Duplicate repos.path: ${path}`);
    seen.add(path);
    if (path === target) {
      const { path: _, ...overrides } = entry;
      selected = overrides;
    }
  }
  const merged = deepMerge(defaults, selected);
  // Hooks are additive across repo layers; other arrays keep replacement semantics.
  // Validate both layers so an override cannot hide malformed inherited hooks.
  for (const layer of [defaults, selected]) {
    if (layer.hooks !== undefined && !Array.isArray(layer.hooks))
      throw new Error("hooks must be an array");
  }
  merged.hooks = [
    ...((defaults.hooks as unknown[] | undefined) ?? []),
    ...((selected.hooks as unknown[] | undefined) ?? []),
  ];
  return normalizeConfig(merged);
};

/** Resolve a possibly-relative config path against the repo root. */
export const resolveAgainstRepo = (repoRoot: string, p: string): string => {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
};

/** Global cache pruning must also respect paths pinned by other trusted repositories. */
export const loadAllRepoConfigs = (
  repoRoot: string,
  configFile = userConfigPath(),
): LoomConfig[] => {
  const current = loadConfig(repoRoot, configFile); // validates every repo entry first
  const raw = readConfigIfPresent(configFile) ?? {};
  const repos = (raw.repos ?? []) as Array<{ path: string }>;
  return [
    current,
    normalizeConfig(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "repos"))),
    ...repos.map((entry) => loadConfig(configRepoPath(entry.path), configFile)),
  ];
};
