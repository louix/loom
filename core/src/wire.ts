import type { BackgroundTaskKind, HarnessEvent, SessionState, TokenUsage } from "./events.ts";
import type { SessionInteraction } from "./interaction.ts";
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

/**
 * v2 replaced the per-session `session_updated` / `session_removed` /
 * `providers_updated` pushes with one whole-fleet `state` snapshot. A v1 client
 * would sit with an empty fleet forever, so the mismatch has to be loud.
 */
// v3 returns all search IDs in one response instead of paginating them.
export const PROTOCOL_VERSION = 3;

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
// Transcript
// ---------------------------------------------------------------------------

/**
 * Durable identity of one transcript entry: the daemon's `session_events`
 * rowid. Assigned by the insert, so it is stable across daemon restarts and
 * totally ordered within a session — which event timestamps are not, since a
 * burst shares one millisecond and a provider can report them out of order.
 * The same id rides the live {@link EventPush} and the {@link HistoryPage}
 * that carry the entry, so a client merges the two by identity rather than by
 * guessing from timestamps.
 */
export type TranscriptId = number;

/** Could the daemon have issued `v` as a {@link TranscriptId}? Guards the
 *  cursor a client hands back, which is otherwise arbitrary JSON. */
export const isTranscriptId = (v: unknown): v is TranscriptId => {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
};

export interface TranscriptEntry {
  readonly id: TranscriptId;
  readonly event: HarnessEvent;
}

/** Where the next older {@link HistoryPage} starts. Opaque to the client —
 *  read it off a page and hand it back verbatim. */
export interface HistoryCursor {
  readonly olderThan: TranscriptId;
}

/**
 * One page of a session's durable transcript, oldest-first *within the page*.
 * Pages walk backwards: each carries the cursor for the page before it.
 *
 * `olderCursor === null` means this page reaches the start of the session's
 * history — actual exhaustion, and only that. A client that has dropped pages
 * to stay inside a memory budget must keep a cursor pointing at what it
 * dropped, never conclude the daemon has nothing more.
 */
export interface HistoryPage {
  readonly items: readonly TranscriptEntry[];
  readonly olderCursor: HistoryCursor | null;
}

// ---------------------------------------------------------------------------
// Cross-session search
// ---------------------------------------------------------------------------

/** Ranked matches. Session display metadata comes from the fleet snapshot. */
export interface SearchResult {
  readonly query: string;
  readonly ids: readonly string[];
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
   * counter resets to 1 on every daemon start, so `seq` alone is unique only
   * *within* an epoch. Together the pair addresses a position in this
   * connection's raw stream — that is all: which frames a reconnect still
   * needs, and whether the ring rolled past them. It is not the transcript's
   * identity, which is {@link id} and survives a restart.
   */
  epoch: string;
  type: "event";
  event: HarnessEvent;
  /**
   * The entry's durable {@link TranscriptId} — the same id `session.events`
   * returns for it, so a live frame and a history page dedupe against each
   * other. Absent iff the daemon did not persist this event: status and
   * compaction heartbeats have no durable row, and nothing downstream may
   * manufacture one for them.
   */
  id?: TranscriptId;
}

/**
 * The daemon could not replay the client's requested `sinceSeq` because the
 * ring buffer had already rolled past it. Authoritative state needs nothing
 * doing — the next {@link StatePush} carries all of it — but transcript entries
 * in the gap were missed, so a client holding cached pages must drop them and
 * re-read rather than keep a hole it cannot see.
 */
export interface ResyncPush {
  kind: "push";
  seq: number;
  type: "resync";
  reason: string;
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

/**
 * The daemon's complete authoritative state. Every push carries the whole
 * thing and *replaces* the client's copy — there are no deltas, no versions and
 * no replay, so a client that has just attached and one that has been
 * connected for hours converge on exactly the same value.
 *
 * Deliberately outside the `seq`-stamped push stream and its replay ring: a
 * snapshot is only ever interesting when it's the current one, so buffering old
 * ones to replay after a reconnect would cost memory to deliver staleness.
 */
export interface StatePush {
  kind: "push";
  type: "state";
  state: DaemonSnapshot;
}

/**
 * The `seq`-stamped stream: raw adapter events plus the two advisories that
 * ride alongside them. Authoritative *state* does not travel here — it is a
 * whole-fleet {@link StatePush}, outside the seq space and its replay ring.
 */
export type PushFrame = EventPush | ResyncPush | NoticePush;

export type Frame = RequestFrame | ResponseFrame | PushFrame | StatePush;

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

/** Daemon vitals fixed for the life of the process. */
export interface DaemonInfo {
  pid: number;
  version: string;
  startedAt: number;
  repoRoot: string;
  /** Per-process id. A change across a reconnect means the daemon restarted. */
  epoch: string;
}

/** Everything a client needs to render the fleet. See {@link StatePush}. */
export interface DaemonSnapshot {
  daemon: DaemonInfo;
  providers: ProviderInfo[];
  sessions: SessionSnapshot[];
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
  /** A user-authored note about the session — meta, not part of the event log. */
  comment: string | null;
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
   * Prompt-cache liveness inputs. `ttlMinutes` is the TTL the countdown runs
   * on (5, 60, or 0 = unknown) and `ttlSource` says where it came from:
   * `observed` is ground truth read back off a response, `config` is the
   * `prompt_cache_ttl` pin standing in until the session writes cache once,
   * `none` is neither. `lastTurnAt` (epoch ms) arms the countdown; the
   * read/write split of the last turn says whether that turn actually hit cache.
   */
  cache: {
    ttlMinutes: number;
    ttlSource: "observed" | "config" | "none";
    lastTurnAt: number;
    lastRead: number;
    lastWrite: number;
  };
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
  /** Whether the session can be used under the current provider/isolation configuration. */
  resumable: boolean;
  /** Persistent, actionable reason for a read-only session. Runtime-only. */
  resumeBlockedReason?: string;
  /**
   * Blocking requests the turn is parked on, oldest first — complete enough to
   * render and answer without any transcript. Non-empty iff
   * `status.kind === "awaiting_input"`; `status.on` is the reason of whichever
   * request most recently parked the turn. Parallel tool calls each raise their
   * own permission, so this is a queue: answering one leaves the rest, and the
   * snapshot is republished with the remainder. Runtime-only, not persisted.
   */
  requests: SessionInteraction[];
  /**
   * A compaction is in flight: `startedAt` is when it began (epoch ms),
   * `before` the context fill it started from, `generated` the chars of summary
   * streamed so far (a liveness proxy, not a percentage). Runtime-only, not
   * persisted — the `compact_progress` beats behind it aren't either, so this
   * overlay is how a freshly attached client (reopened TUI, second window)
   * still shows "compacting…". Absent otherwise.
   */
  compacting?: { startedAt: number; before: number; generated: number };
  git: GitFacts | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// cache / usage stats (`stats.models`)
// ---------------------------------------------------------------------------

/**
 * Token usage attributed to one provider+model. `SessionSnapshot.usage` is per
 * session and a session can change model mid-life, so its totals are a mixture;
 * these rows are the breakdown, and answer "is this model caching at all, and
 * for how long".
 */
export interface ModelUsage {
  provider: string;
  /** "" when the provider never reported one. */
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  turns: number;
  /**
   * Last prompt-cache TTL observed for this pair, in minutes; 0 = never
   * observed (the provider reports no TTL, or has never written cache here).
   */
  ttlMinutes: number;
  /**
   * The longest idle gap after which this pair was still observed *hitting*
   * cache, in seconds; 0 = never seen. A sound lower bound on the real TTL —
   * a hit proves the entry survived that long — and the only lifetime signal
   * available from providers that report no TTL at all (OpenAI-compatible
   * endpoints, which cache implicitly server-side). Deliberately one-sided:
   * a *miss* may be expiry or may be prefix invalidation, so misses are not
   * counted and this never shrinks.
   */
  maxHitGapSec: number;
  /** Sessions that contributed — 1 for a per-session row. */
  sessions: number;
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
   * The start-up model discovery is still running (the Claude CLI catalog
   * probe). The picker shows a loading state instead of the list; the next
   * state snapshot carries the settled list when it lands.
   */
  modelsLoading?: boolean;
  /** Actionable diagnostic when automatic model discovery fails. */
  modelsError?: string;
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

/** One configured MCP mount and its local configuration health. */
export interface DoctorMcpServer {
  name: string;
  /** Configured command, or "HTTP MCP" for a remote mount. */
  command: string;
  /** Executable plus arguments, or the HTTP origin (without credentials/query). */
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
    backend: "none" | "brave" | "tavily";
    /** Backend set and its key resolved — aisdk sessions then get `web_search`. */
    enabled: boolean;
    note: string;
  };
  /** `lintConfig` output — misconfigured providers, unset env vars, keyless search. */
  configWarnings: string[];
}

export interface HelloResult {
  protocolVersion: number;
  daemon: DaemonInfo;
  /** Current head of the push stream. Frames after this arrive live. */
  seq: number;
  /**
   * True when the daemon will replay buffered frames in `(sinceSeq, seq]`.
   * False when it could not (buffer rolled, or no `sinceSeq` given) and the
   * client should rely on `sessions` above.
   */
  replaying: boolean;
}
