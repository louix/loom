import type { BackgroundTaskKind, HarnessEvent, SessionState, TokenUsage } from "./events.ts";
import type { SessionMode } from "./types.ts";

/**
 * Loom's client<->daemon wire protocol: newline-delimited JSON over a Unix
 * domain socket. One connection multiplexes two logical channels:
 *
 *   - request / response  (client -> daemon -> client), correlated by `id`
 *   - a server -> client push stream of events, each stamped with a monotonic `seq`
 *
 * Every frame is a single JSON object on its own line. `kind` discriminates.
 */

export const PROTOCOL_VERSION = 1;

/**
 * Hard cap on a single newline-delimited frame (bytes). Enforced identically on
 * both ends of the socket — a peer that sends a frame this large (or a stream
 * with no newline) is buggy or hostile, so the reader drops the connection
 * rather than grow its buffer without bound.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

export interface RequestFrame {
  kind: "req";
  id: number;
  method: string;
  params?: unknown;
}

export interface OkResponseFrame {
  kind: "res";
  id: number;
  ok: true;
  result: unknown;
}

export interface ErrResponseFrame {
  kind: "res";
  id: number;
  ok: false;
  error: WireError;
}

export type ResponseFrame = OkResponseFrame | ErrResponseFrame;

export interface WireError {
  code: string;
  message: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Server -> client push stream
// ---------------------------------------------------------------------------

/** A normalized harness event, forwarded to every attached client. */
export interface EventPush {
  kind: "push";
  seq: number;
  /**
   * The daemon epoch (a fresh id per daemon process) that issued `seq`. The
   * seq counter resets to 1 on every daemon start, so it is only unique
   * *within* an epoch — clients must key dedupe / identity on (epoch, seq),
   * or a post-restart frame silently collides with a pre-restart one.
   */
  epoch: string;
  type: "event";
  event: HarnessEvent;
}

/** A session's authoritative fields changed (status/mode/model/usage/git). */
export interface SessionUpdatedPush {
  kind: "push";
  seq: number;
  type: "session_updated";
  session: SessionSnapshot;
  /** Bumped on every authoritative change; clients ignore older versions. */
  version: number;
  /** Who caused the change, when a client did. */
  by?: string;
}

/** A session row disappeared (gc). */
export interface SessionRemovedPush {
  kind: "push";
  seq: number;
  type: "session_removed";
  sessionId: string;
}

/**
 * The daemon could not replay the client's requested `sinceSeq` because the
 * ring buffer had already rolled past it. The client must discard local state
 * and treat the `hello` snapshot (or a fresh `session.list`) as authoritative.
 */
export interface ResyncPush {
  kind: "push";
  seq: number;
  type: "resync";
  reason: string;
}

/**
 * The remembered new-session defaults changed — a session was created, or a
 * live session switched its model / thinking-effort / permission mode — or the
 * start-up model probes resolved a catalog after clients had already fetched
 * the pin fallback. Carries a fresh `providers.list` so clients re-seed
 * new-session prompts without a refetch round trip.
 */
export interface ProvidersUpdatedPush {
  kind: "push";
  seq: number;
  type: "providers_updated";
  providers: ProviderInfo[];
}

/**
 * A daemon-originated advisory for the operator — not tied to a session. The
 * TUI shows it as a transient notice. Used for config-reload feedback.
 */
export interface NoticePush {
  kind: "push";
  seq: number;
  type: "notice";
  text: string;
  tone: "info" | "warn";
}

export type PushFrame =
  | EventPush
  | SessionUpdatedPush
  | SessionRemovedPush
  | ProvidersUpdatedPush
  | ResyncPush
  | NoticePush;

export type Frame = RequestFrame | ResponseFrame | PushFrame;

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export interface GitFacts {
  branch: string | null;
  commits: number;
  aheadOfBase: number;
  behindBase: number;
  dirty: boolean;
  lastCommitSubject: string | null;
}

export interface SessionSnapshot {
  id: string;
  parentId: string | null;
  /** For a hard fork: the parent turn it branched at. null for a root session. */
  forkTurn: number | null;
  provider: string;
  model: string | null;
  effort: string | null;
  mode: string;
  status: SessionState;
  title: string | null;
  worktree: string | null;
  branch: string | null;
  baseBranch: string | null;
  /** Runs in the repo working dir with no dedicated worktree — no branch
   *  isolation, and hard-fork is unavailable. Distinguishes an in-place session
   *  from a gc'd one (both have `worktree: null`). */
  inPlace: boolean;
  usage: TokenUsage;
  contextUsed: number;
  contextLimit: number;
  costUsd: number;
  /** Where `costUsd` was computed — a local price table, the provider, or nothing yet. */
  costSource: "table" | "provider" | "none";
  turns: number;
  /** Sub-agents this session has spawned (Claude's Task tool). Runtime-only, not persisted. */
  subagents: Array<{ id: string; name: string; active: boolean }>;
  /**
   * Live background tasks the session spawned — async subagents, backgrounded
   * shells, workflows. Non-empty implies `status.kind === "working_background"`
   * (or a live state that will settle there). Runtime-only, not persisted.
   */
  backgroundTasks: Array<{ id: string; kind: BackgroundTaskKind; title: string }>;
  /**
   * The provider's account-plan usage windows (Claude: `five_hour` / `seven_day`),
   * keyed by window name. Empty for API-key sessions, which have no such plan.
   * Runtime-only, not persisted.
   */
  rateLimits: Record<
    string,
    { status: "allowed" | "allowed_warning" | "rejected"; utilization?: number; resetsAt?: number }
  >;
  /**
   * Prompt-cache liveness inputs. `ttlMinutes` is the configured TTL (5, 60, or
   * 0 = unknown/CLI-decides); `lastTurnAt` (epoch ms) arms a countdown; the
   * read/write split of the last turn says whether that turn actually hit cache.
   */
  cache: { ttlMinutes: number; lastTurnAt: number; lastRead: number; lastWrite: number };
  /**
   * Keep-warm is on for this session: while it sits idle the daemon re-primes
   * the prompt cache with a tiny turn just before the TTL lapses, so the next
   * real message still hits cache. Claude-only (needs a pinned `cache.ttlMinutes`);
   * runtime-only, not persisted — a daemon restart clears it.
   */
  keepWarm: boolean;
  /**
   * The session's provider can `undo` (`session.rewind`) — its adapter reports
   * `capabilities.rewind`. Lets the TUI offer `u` without encoding which
   * providers support it. Runtime-only, not persisted.
   */
  canRewind: boolean;
  /**
   * A compaction is in flight and holds the session's op gate: `startedAt` is
   * when it began (epoch ms), `before` the context fill it started from.
   * Runtime-only, not persisted — beats aren't either, so this overlay is how
   * a freshly attached client (reopened TUI, second window) still shows
   * "compacting…". Absent otherwise.
   */
  compacting?: { startedAt: number; before: number };
  git: GitFacts | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// hello handshake
// ---------------------------------------------------------------------------

export interface HelloParams {
  protocolVersion: number;
  /** Stable id for this client instance; used in change attribution. */
  clientId: string;
  /** Last push `seq` the client processed, for gap replay. Omit on first attach. */
  sinceSeq?: number;
}

/** One row in the model picker — a canonical id plus display trimmings. */
export interface ModelChoice {
  id: string;
  /** Friendly name; falls back to `id` when the provider gives none. */
  label: string;
  /** Context-window size in tokens, when the provider reports it. */
  context?: number;
  /** Whether this model accepts a thinking-effort level. */
  supportsEffort?: boolean;
  /** The effort levels it accepts, when the provider enumerates them.
   *  Endpoint-advertised lists pass through verbatim — they may name levels
   *  outside Loom's own effort-level union (OpenAI's `minimal`, …). */
  effortLevels?: string[];
  /** The effort the provider defaults to for this model, when advertised —
   *  the picker marks it, and a session created without a choice sends it. */
  defaultEffort?: string;
}

/** A configured provider, for the TUI's creation flow and model switcher. */
export interface ProviderInfo {
  id: string;
  /** Canonical model ids — used for defaults, dedupe, and the aisdk picker.
   *  For `claude` this is the CLI-reported catalog (discovered at daemon
   *  start-up); for aisdk it's the configured / `/models`-probed list. */
  models: string[];
  /** Richer picker rows (labels, context sizes) when the provider has them —
   *  Claude does. Parallel to `models`; the picker falls back to a bare `id`. */
  modelChoices?: ModelChoice[];
  /**
   * Model a new session gets when none is chosen: the last one run on this
   * provider (remembered across restarts), else a config pin, else the first
   * detected model. "" when nothing is known yet.
   */
  defaultModel: string;
  /**
   * Effort level a new session gets when none is chosen: the last one used on
   * this provider (remembered across restarts). "" when nothing is known yet
   * or the provider has no effort-capable models.
   */
  defaultEffort: string;
  /**
   * Permission mode a new session gets when none is chosen: the last one a
   * session was created with (remembered across restarts), else `default`
   * (manual). Same value on every entry — it isn't per-provider.
   */
  defaultMode: SessionMode;
  /** Short label (Detail pane, `loom ls`). */
  tag: string;
  /** Fleet-row id colour — an Ink colour name, or "" for the plain default. */
  color: string;
  /** True for the provider new sessions use when none is named. */
  isDefault: boolean;
  /**
   * Claude only — the OAuth identity behind this profile's `~/.claude` dir, read
   * from `.claude.json` / `.credentials.json`. Omitted when neither field could
   * be resolved; either string may still be "". Shown in the Detail pane to
   * disambiguate a personal vs work profile.
   */
  account?: { loginMethod: string; org: string };
}

// ---------------------------------------------------------------------------
// daemon.doctor — diagnostics
// ---------------------------------------------------------------------------

/** One connector package the daemon can load lazily, for `daemon.doctor`. */
export interface DoctorConnector {
  /** npm package name, e.g. `@loom/connector-claude`. */
  pkg: string;
  /** Configured provider ids this package serves (`claude`, `fake`, aisdk profiles). */
  providerIds: string[];
  /** A provider from this package has actually been constructed this process —
   *  the thunk stays unevaluated until a session first uses that provider. */
  loaded: boolean;
}

/** One MCP server mounted into every session, and whether its command resolves. */
export interface DoctorMcpServer {
  name: string;
  /** As written in `config.toml`'s `[[mcp]]`. */
  command: string;
  /** What actually gets spawned — the legacy `tilth mcp` heal rewrites this. */
  resolved: string;
  /** `ok` on PATH · `missing` unrunnable. */
  status: "ok" | "missing";
  /** Set only when the command was rewritten or a binary is missing. */
  note: string;
}

/**
 * `daemon.doctor` — a read-only snapshot of the tool / connector / MCP
 * environment a new session would get, plus daemon vitals. Backs the TUI's
 * doctor overlay (Space palette → "doctor").
 */
export interface DoctorReport {
  daemon: {
    pid: number;
    version: string;
    startedAt: number;
    uptimeMs: number;
    epoch: string;
    repoRoot: string;
    /** Distinct attached clients / raw socket connections. */
    clients: number;
    connections: number;
    /** Push-stream head seq / frames still buffered for gap replay. */
    eventSeq: number;
    eventBuffer: number;
    sessions: number;
    runningSessions: number;
  };
  connectors: DoctorConnector[];
  mcp: DoctorMcpServer[];
  /**
   * Tool names a session sees, by origin. `claude` / `aisdk` are the
   * provider-native built-ins (indicative — the daemon doesn't own those
   * lists); every session additionally gets `loom` and every `mcp` server.
   */
  tools: {
    loom: string[];
    claude: string[];
    aisdk: string[];
    /** Built-ins Loom disables on Claude sessions (steered onto `fff` instead). */
    claudeDisabled: string[];
  };
  webSearch: {
    backend: "none" | "brave" | "tavily" | "kagi";
    /** Backend set and its key resolved — aisdk sessions then get `web_search`. */
    enabled: boolean;
    note: string;
  };
  /** `lintConfig` output — misconfigured providers, unset env vars, keyless search. */
  configWarnings: string[];
}

export interface HelloResult {
  protocolVersion: number;
  daemon: {
    pid: number;
    version: string;
    startedAt: number;
    repoRoot: string;
    /** Per-process id. A change across a reconnect means the daemon restarted
     *  — the client must discard its seq / version view and re-baseline. */
    epoch: string;
  };
  /** Authoritative session list at handshake time. */
  sessions: SessionSnapshot[];
  /** Current head of the push stream. Frames after this arrive live. */
  seq: number;
  /**
   * True when the daemon will replay buffered frames in `(sinceSeq, seq]`.
   * False when it could not (buffer rolled, or no `sinceSeq` given) and the
   * client should rely on `sessions` above.
   */
  replaying: boolean;
}
