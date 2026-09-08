import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { onPath } from "@loom/core/paths";
import { isClaudeId } from "@loom/core/provider-id";
import type { PriceRow } from "./pricing.ts";

/**
 * Loom configuration. Mirrors the `.loom/config.toml` sketch in the design spec.
 * Milestone 1 only reads a handful of these; the rest are carried so the shape
 * is stable for later milestones.
 */
export type AisdkKind = "openai" | "google" | "anthropic" | "chatgpt";

/**
 * One Vercel-AI-SDK provider profile. Configured as `[custom-provider.<id>]`
 * (OpenAI-compatible), `[google]` / `[anthropic]` / `[chatgpt]` (one native
 * profile per vendor), or the low-level `[providers.<id>]` with
 * `adapter = "aisdk"`.
 */
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
  /**
   * Per-model context-window sizes in tokens, keyed by model id. Filled from
   * `{base_url}/models` when the endpoint advertises it (`context_length` /
   * `max_model_len` / …); set `model_context` in the config to pin sizes for
   * endpoints that don't report one. Wins over the built-in prefix table.
   */
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
   * Per-segment ceiling on tool round-trips in one turn (`max_steps`). Not a
   * hard turn limit — a turn whose model is still working continues past it
   * automatically — so this is a granularity knob: raise it for a model that
   * takes many small steps, lower it to rein one in. Default 50; clamped 1–500.
   */
  maxSteps: number;
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
  /** Cheap model for one-shot auto-titling; "" → falls back to `titles.model`. */
  titleModel: string;
  /**
   * Connector package that serves this profile. "" → routed by `sdk`
   * (`google` → `@loom/connector-gemini`, else `@loom/connector-generic`).
   * Set it to point at an out-of-tree connector.
   */
  connector: string;
  /**
   * Codex OAuth credentials for `sdk = "chatgpt"`. Empty uses Codex's own
   * `~/.codex/auth.json`; this is deliberately a path rather than a token so
   * Loom never copies a ChatGPT subscription credential into its config or DB.
   */
  authPath: string;
  /**
   * Explicit Codex home directory for `sdk = "chatgpt"` (`auth.json`,
   * `config.toml`). Resolution order: `config_dir` → legacy `auth_path`'s
   * parent → `CODEX_HOME` → `~/.codex`; setting both `config_dir` and
   * `auth_path` is only valid when they name the same directory.
   */
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
  /** Display label + id-slug source; "" → the base `claude` id, tag "Claude". */
  name: string;
  /** Fleet-row id colour (Ink name); "" → auto-assign from a palette. */
  color: string;
}

/**
 * What a `[[hooks]]` entry can fire on. Two families:
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

const isHookEvent = (v: unknown): v is HookEvent =>
  typeof v === "string" && (HOOK_EVENTS as readonly string[]).includes(v);

/** One `[[hooks]]` entry, normalized. */
export type WriteHookEvent = "file_write" | "turn_end";

export type HookConfig = HookFields &
  ({ kind: "check"; on: WriteHookEvent[] } | { kind: "notify"; on: HookEvent[] });

interface HookFields {
  /** Label for logs and the agent-facing failure message; defaults to `run`'s first word. */
  name: string;
  /** The command, run through `sh -c` in the session's worktree. */
  run: string;
  /**
   * Restrict the hook to one repo. A glob against the daemon's absolute
   * repo root (`~` expanded, `**` crosses `/`), so `~/dev/loom` pins one
   * project and `~/dev/**` covers everything under a directory. "" = every
   * repo — which is what a hook in a per-repo `.loom/config.toml` normally
   * wants, since that file already only applies to its own project.
   *
   * This exists because config layering replaces arrays wholesale: a repo-level
   * `[[hooks]]` would otherwise shadow every user-level one, so per-project
   * hooks have to be expressible in the user-level file itself.
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
  runIsolation: "in-process" | "subprocess";
  /** Provider id new sessions use when the client doesn't name one. */
  defaultProvider: string;
  daemon: {
    idleShutdownMinutes: number;
    /**
     * Capacity of the in-memory push-event ring buffer, in *frames* (not bytes
     * — a frame carrying a big tool result costs more). Sized only to cover a
     * client's reconnect gap across the whole fleet; deeper scroll-back pages
     * from the durable per-session `session_events` table, so this does not need
     * to hold a long session's entire history.
     */
    eventBufferSize: number;
  };
  providers: {
    claude: {
      model: string;
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
    /**
     * Vercel-AI-SDK providers, keyed by id. Fed by `[custom-provider.<id>]`
     * (OpenAI-compatible — GLM, DeepSeek, OpenRouter, a local vLLM / Ollama),
     * `[google]` / `[anthropic]` (native), and the low-level
     * `[providers.<id>] adapter = "aisdk"` escape hatch.
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
  /**
   * Shell commands the daemon runs when something happens in a session — a
   * linter after the agent edits a file, `notify-send` when a turn parks on a
   * question. Configured as `[[hooks]]`, in the user-level config and/or the
   * per-repo one.
   *
   * Unrelated to `.loom/hooks/` on disk, which holds the git `pre-push` block
   * installed into session worktrees.
   */
  hooks: HookConfig[];
  /**
   * `web_search` tool for aisdk sessions (Claude has its own). Off unless a
   * backend is chosen and its key env var is set. `kagi` dials Kagi's hosted
   * MCP server with the key as a bearer token.
   */
  search: {
    backend: "none" | "brave" | "tavily" | "kagi";
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
  claudeProfiles: [{ dir: "~/.claude", name: "", color: "" }],
  worktree: { enabled: true },
  autoRebase: { enabled: false, mode: "rebase" },
  autoResume: { enabled: true },
  commitReminder: { enabled: true },
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
      models: [],
      permissionDefault: "default",
      settingSources: ["project"],
      disableBuiltin: ["Grep", "Glob"],
      cliPath: "",
      promptCacheTtl: "",
    },
    aisdk: {},
  },
  mcp: [
    { name: "tilth", command: "tilth --mcp --edit" },
    { name: "fff", command: "fff-mcp" },
  ],
  titles: { enabled: true, model: "" },
  pricing: { table: ".loom/models.toml" },
  notify: { webhook: "" },
  hooks: [],
  search: { backend: "none", apiKeyEnv: "", apiKey: "", apiBase: "", maxResults: 5 },
};

const asRecord = (v: unknown): Record<string, unknown> => {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
};

const str = (v: unknown, fallback: string): string => {
  return typeof v === "string" ? v : fallback;
};

const num = (v: unknown, fallback: number): number => {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};

/** A non-negative number, or the fallback (rejects `-1`, NaN, wrong type). */
const nonNeg = (v: unknown, fallback: number): number => {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
};

const strArray = (v: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(v)) return fallback;
  // Keep the string entries rather than reverting the whole list (and losing an
  // explicit `[]`) because of one stray non-string element.
  return v.filter((x): x is string => typeof x === "string");
};

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
 * `[[claude_profiles]]` → a stable, de-duplicated list. A missing / empty `dir`
 * drops the entry; a second entry that resolves to an id already taken is
 * dropped (both flagged by {@link lintConfig}). Always returns at least the
 * default `~/.claude` profile.
 */
const parseClaudeProfiles = (raw: unknown): ClaudeProfile[] => {
  const rows = Array.isArray(raw) ? raw : [];
  const out: ClaudeProfile[] = [];
  const seen = new Set<string>();
  for (const entry of rows) {
    const e = asRecord(entry);
    const dir = str(e["dir"], "").trim();
    if (dir === "") continue;
    const profile: ClaudeProfile = {
      dir: expandTilde(dir),
      name: str(e["name"], "").trim(),
      color: str(e["color"], "").trim(),
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

/** Default hook timeout; long enough for a cold typecheck, short of a hang. */
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/**
 * Reject invalid entries at the boundary; hot reload keeps the old config on error.
 */
const parseHooks = (raw: unknown): HookConfig[] => {
  if (raw !== undefined && !Array.isArray(raw)) throw new Error("hooks: use [[hooks]] entries");
  const rows = Array.isArray(raw) ? raw : [];
  const out: HookConfig[] = [];
  for (const entry of rows) {
    const e = asRecord(entry);
    const run = str(e["run"], "").trim();
    if (run === "") throw new Error("hook: run must be a non-empty command");
    const onRaw = Array.isArray(e["on"]) ? e["on"] : [e["on"]];
    const on = onRaw.filter(isHookEvent);
    if (on.length === 0 || on.length !== onRaw.length) {
      throw new Error("hook: on must contain valid hook events");
    }
    const kind = e["kind"] ?? "notify";
    if (kind !== "check" && kind !== "notify")
      throw new Error("hook: kind must be check or notify");
    const events = [...new Set(on)];
    const trigger: { kind: "check"; on: WriteHookEvent[] } | { kind: "notify"; on: HookEvent[] } =
      kind === "check"
        ? {
            kind,
            on: events.map((event): WriteHookEvent => {
              if (event !== "file_write" && event !== "turn_end")
                throw new Error("check hook: only file_write and turn_end are supported");
              return event;
            }),
          }
        : { kind, on: events };
    // `match` takes one glob or a list, like `on`.
    const matchRaw = e["match"];
    const matchList = Array.isArray(matchRaw) ? matchRaw : [matchRaw];
    const timeoutSec = num(e["timeout"], DEFAULT_HOOK_TIMEOUT_MS / 1000);
    out.push({
      name: str(e["name"], "").trim() || (run.split(/\s+/)[0] ?? "hook"),
      ...trigger,
      run,
      project: expandTilde(str(e["project"], "").trim()),
      match: strArray(matchList, []),
      timeoutMs: Math.min(600_000, Math.max(1_000, Math.round(timeoutSec * 1000))),
    });
  }
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
/** Default per-segment step ceiling; kept in step with `DEFAULT_MAX_STEPS` in
 *  `src/provider/aisdk/session.ts`. */
const DEFAULT_AISDK_MAX_STEPS = 50;

/** `prompt_cache_ttl` on an aisdk profile; anything unrecognised reads as unset. */
const aisdkCacheTtl = (v: unknown): AisdkProfile["promptCacheTtl"] => {
  return v === "5m" || v === "1h" || v === "off" ? v : "";
};

/** `model_context` table → per-model token sizes; junk rows are skipped. */
const modelContextOf = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === "" || (typeof val !== "number" && typeof val !== "string")) continue;
    const n = typeof val === "string" ? Number(val) : val;
    if (Number.isFinite(n) && n > 0) out[k] = Math.round(n);
  }
  return out;
};

const buildAisdkProfile = (
  id: string,
  t: Record<string, unknown>,
  sdk: AisdkKind,
): AisdkProfile | null => {
  const baseUrl = str(t["base_url"], "");
  if (sdk === "openai" && baseUrl === "") return null;
  const model = str(t["model"], "");
  const models = strArray(t["models"], model ? [model] : []);
  const autoModels = model === "" && models.length === 0;
  if (autoModels && sdk !== "openai" && sdk !== "chatgpt") return null;
  const effectiveModel = model || (models[0] ?? "");
  const rawSteps = num(t["max_steps"], DEFAULT_AISDK_MAX_STEPS);
  const effectiveModelList = effectiveModel ? [effectiveModel] : [];
  return {
    sdk,
    baseUrl,
    apiKeyEnv: str(t["api_key_env"], ""),
    apiKey: str(t["api_key"], ""),
    model: effectiveModel,
    models: models.length > 0 ? models : effectiveModelList,
    modelContext: modelContextOf(t["model_context"]),
    modelPricing: {},
    modelLabels: {},
    modelEfforts: {},
    modelDefaultEffort: {},
    includeUsage: t["include_usage"] === false ? false : true,
    autoModels,
    maxSteps: Math.min(500, Math.max(1, Math.trunc(rawSteps))),
    tag: str(t["tag"], id),
    color: str(t["color"], ""),
    promptCacheTtl: aisdkCacheTtl(t["prompt_cache_ttl"]),
    titleModel: str(t["title_model"], ""),
    connector: str(t["connector"], ""),
    authPath: t["auth_path"] ? expandTilde(str(t["auth_path"], "")) : "",
    configDir: t["config_dir"] ? expandTilde(str(t["config_dir"], "")) : "",
    codexCliPath: t["codex_cli_path"] ? expandTilde(str(t["codex_cli_path"], "")) : "",
    codexBuiltinWebSearch: t["codex_builtin_web_search"] === true,
  };
};

/**
 * Every aisdk provider profile, from all the namespaces, keyed by id:
 *  - `[custom-provider.<id>]`   — an OpenAI-compatible endpoint (implicit sdk);
 *    the form that will become a plugin. `base_url` + `api_key` / `api_key_env`.
 *  - `[google]` / `[anthropic]` / `[chatgpt]` — one native profile each, id = the vendor.
 *  - `[providers.<id>]` with `adapter = "aisdk"` — the low-level escape hatch;
 *    its `sdk` key still selects the backend. Wins a duplicate id.
 * `claude` is reserved for the native CLI provider and is never an aisdk id.
 */
const parseAisdkProfiles = (raw: Record<string, unknown>): Record<string, AisdkProfile> => {
  const out: Record<string, AisdkProfile> = {};
  const put = (id: string, p: AisdkProfile | null): void => {
    if (p && !isClaudeId(id) && !(id in out)) out[id] = p;
  };

  // Native providers — one profile per vendor, id = the vendor name. ChatGPT
  // uses the locally authenticated Codex OAuth session, not an API key.
  for (const sdk of ["google", "anthropic", "chatgpt"] as const) {
    if (raw[sdk] && typeof raw[sdk] === "object")
      put(sdk, buildAisdkProfile(sdk, asRecord(raw[sdk]), sdk));
  }

  // [custom-provider.<id>] — OpenAI-compatible, no adapter / sdk keys.
  for (const [id, t] of Object.entries(asRecord(raw["custom-provider"]))) {
    put(id, buildAisdkProfile(id, asRecord(t), "openai"));
  }

  // [providers.<id>] adapter = "aisdk" — kept, and wins a duplicate id.
  for (const [id, t0] of Object.entries(asRecord(raw["providers"]))) {
    if (isClaudeId(id)) continue;
    const t = asRecord(t0);
    if (t["adapter"] !== "aisdk") continue;
    const sdk: AisdkKind =
      t["sdk"] === "google" || t["sdk"] === "anthropic" || t["sdk"] === "chatgpt"
        ? t["sdk"]
        : "openai";
    delete out[id]; // legacy form overrides the same id from the sugar namespaces
    put(id, buildAisdkProfile(id, t, sdk));
  }

  return out;
};

/**
 * The API key for an aisdk profile / `[search]`: an inline `api_key` wins,
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
    if (/^[\w.-]+$/.test(word) && !onPath(word, env)) {
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
  return w;
};

/**
 * Parse a raw TOML tree into a fully-populated LoomConfig, filling any missing
 * key from DEFAULT_CONFIG. Unknown keys are ignored. Enum-typed fields fall back
 * to the default when the value is not one of the permitted literals.
 */
export const normalizeConfig = (raw: unknown): LoomConfig => {
  const r = asRecord(raw);
  const d = DEFAULT_CONFIG;

  const daemon = asRecord(r["daemon"]);
  const worktree = asRecord(r["worktree"]);
  const autoRebase = asRecord(r["auto_rebase"]);
  const autoResume = asRecord(r["auto_resume"]);
  const commitReminder = asRecord(r["commit_reminder"]);
  const providers = asRecord(r["providers"]);
  const claude = asRecord(providers["claude"]);
  const aisdk = parseAisdkProfiles(r);
  const titles = asRecord(r["titles"]);
  const pricing = asRecord(r["pricing"]);
  const notify = asRecord(r["notify"]);
  const search = asRecord(r["search"]);

  const runIsolation = r["run_isolation"] === "subprocess" ? "subprocess" : "in-process";

  const claudeProfiles = parseClaudeProfiles(r["claude_profiles"]);
  const claudeIds = new Set(claudeProfiles.map(claudeProfileId));

  // The default provider must actually be configured; fall back to claude.
  const wantDefault = str(r["default_provider"], d.defaultProvider);
  const defaultProvider =
    claudeIds.has(wantDefault) || wantDefault in aisdk ? wantDefault : "claude";

  // "manual" is the user-facing name for "default" (you approve everything).
  const permDefault =
    claude["permission_default"] === "manual" ? "default" : claude["permission_default"];
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
    claudeProfiles,
    worktree: {
      enabled: typeof worktree["enabled"] === "boolean" ? worktree["enabled"] : d.worktree.enabled,
    },
    autoRebase: {
      enabled:
        typeof autoRebase["enabled"] === "boolean" ? autoRebase["enabled"] : d.autoRebase.enabled,
      mode: autoRebase["mode"] === "merge" ? "merge" : "rebase",
    },
    autoResume: {
      enabled:
        typeof autoResume["enabled"] === "boolean" ? autoResume["enabled"] : d.autoResume.enabled,
    },
    commitReminder: {
      enabled:
        typeof commitReminder["enabled"] === "boolean"
          ? commitReminder["enabled"]
          : d.commitReminder.enabled,
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
        models: strArray(claude["models"], d.providers.claude.models),
        permissionDefault,
        settingSources: strArray(claude["setting_sources"], d.providers.claude.settingSources),
        disableBuiltin: strArray(claude["disable_builtin"], d.providers.claude.disableBuiltin),
        cliPath: str(claude["cli_path"], d.providers.claude.cliPath),
        ...(claude["worker_allowed_hosts"] !== undefined
          ? { workerAllowedHosts: strArray(claude["worker_allowed_hosts"], []) }
          : {}),
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
    hooks: parseHooks(r["hooks"]),
    search: {
      backend:
        search["backend"] === "brave" ||
        search["backend"] === "tavily" ||
        search["backend"] === "kagi"
          ? search["backend"]
          : "none",
      apiKeyEnv: str(search["api_key_env"], d.search.apiKeyEnv),
      apiKey: str(search["api_key"], d.search.apiKey),
      apiBase: str(search["api_base"], d.search.apiBase),
      maxResults: Math.max(1, nonNeg(search["max_results"], d.search.maxResults)),
    },
  };
};

const readTomlIfPresent = (path: string): Record<string, unknown> | null => {
  try {
    const parsed = parseToml(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
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
    // `.loom/config.toml` comes from whatever repo the daemon runs against — an
    // untrusted input. A TOML `[__proto__]` table parses to an own key that
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

/**
 * Load and normalize config. The per-repo `.loom/config.toml` is layered on top
 * of the user-level `userConfigPath` (when given); either may be absent.
 */
export const loadConfig = (repoConfigPath: string, userConfigPath?: string): LoomConfig => {
  let raw: Record<string, unknown> = {};
  if (userConfigPath) {
    const u = readTomlIfPresent(userConfigPath);
    if (u) raw = u;
  }
  const r = readTomlIfPresent(repoConfigPath);
  if (r) raw = deepMerge(raw, r);
  return normalizeConfig(raw);
};

/** Resolve a possibly-relative config path against the repo root. */
export const resolveAgainstRepo = (repoRoot: string, p: string): string => {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
};
