import { z } from "zod";
import { opaqueSchema } from "./schema.ts";
import { backgroundTaskKindSchema, harnessEventSchema, tokenUsageSchema } from "./events.ts";
import { sessionStateSchema } from "./session-state.ts";
import { sessionInteractionSchema } from "./interaction.ts";
import { sessionModeSchema } from "./types.ts";

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
// v4 reconnects from a fresh snapshot and durable history; no transport replay.
export const PROTOCOL_VERSION = 4;

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

export const requestFrameSchema = z.object({
  kind: z.literal("req"),
  id: z.int(),
  method: z.string(),
  params: opaqueSchema.optional(),
});
export type RequestFrame = z.infer<typeof requestFrameSchema>;

export const okResponseFrameSchema = z.object({
  kind: z.literal("res"),
  id: z.int(),
  ok: z.literal(true),
  result: opaqueSchema,
});
export type OkResponseFrame = z.infer<typeof okResponseFrameSchema>;

export const errResponseFrameSchema = z.object({
  kind: z.literal("res"),
  id: z.int(),
  ok: z.literal(false),
  error: z.lazy(() => wireErrorSchema),
});
export type ErrResponseFrame = z.infer<typeof errResponseFrameSchema>;

export const responseFrameSchema = z.discriminatedUnion("ok", [
  okResponseFrameSchema,
  errResponseFrameSchema,
]);
export type ResponseFrame = z.infer<typeof responseFrameSchema>;

export const wireErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  data: opaqueSchema.optional(),
});
export type WireError = z.infer<typeof wireErrorSchema>;

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
export const transcriptIdSchema = z.int().positive();
export type TranscriptId = z.infer<typeof transcriptIdSchema>;

/** Could the daemon have issued `v` as a {@link TranscriptId}? Guards the
 *  cursor a client hands back, which is otherwise arbitrary JSON. */
export const isTranscriptId = (v: unknown): v is TranscriptId => {
  return transcriptIdSchema.safeParse(v).success;
};

export const transcriptEntrySchema = z.object({
  id: transcriptIdSchema,
  event: harnessEventSchema,
});
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

/** Where the next older {@link HistoryPage} starts. Opaque to the client —
 *  read it off a page and hand it back verbatim. */
export const historyCursorSchema = z.object({
  olderThan: transcriptIdSchema,
});
export type HistoryCursor = z.infer<typeof historyCursorSchema>;

/**
 * One page of a session's durable transcript, oldest-first *within the page*.
 * Pages walk backwards: each carries the cursor for the page before it.
 *
 * `olderCursor === null` means this page reaches the start of the session's
 * history — actual exhaustion, and only that. A client that has dropped pages
 * to stay inside a memory budget must keep a cursor pointing at what it
 * dropped, never conclude the daemon has nothing more.
 */
export const historyPageSchema = z.object({
  items: z.array(transcriptEntrySchema).readonly(),
  olderCursor: z.union([historyCursorSchema, z.null()]),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;

// ---------------------------------------------------------------------------
// Cross-session search
// ---------------------------------------------------------------------------

/** Ranked matches. Session display metadata comes from the fleet snapshot. */
export const searchResultSchema = z.object({
  query: z.string(),
  ids: z.array(z.string()).readonly(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

// ---------------------------------------------------------------------------
// Server -> client push stream
// ---------------------------------------------------------------------------

/** A normalized harness event, forwarded to every attached client. */
export const eventPushSchema = z.object({
  kind: z.literal("push"),
  seq: z.number(),
  /** Diagnostic stream position only; transcript identity is the durable id. */
  epoch: z.string(),
  type: z.literal("event"),
  event: harnessEventSchema,
  /**
   * The entry's durable {@link TranscriptId} — the same id `session.events`
   * returns for it, so a live frame and a history page dedupe against each
   * other. Absent iff the daemon did not persist this event: status and
   * compaction heartbeats have no durable row, and nothing downstream may
   * manufacture one for them.
   */
  id: transcriptIdSchema.optional(),
});
export type EventPush = z.infer<typeof eventPushSchema>;

/**
 * A daemon-originated advisory for the operator — not tied to a session. The
 * TUI shows it as a transient notice. Used for config-reload feedback.
 */
export const noticePushSchema = z.object({
  kind: z.literal("push"),
  seq: z.number(),
  type: z.literal("notice"),
  text: z.string(),
  tone: z.union([z.literal("info"), z.literal("warn")]),
});
export type NoticePush = z.infer<typeof noticePushSchema>;

/**
 * The daemon's complete authoritative state. Every push carries the whole
 * thing and *replaces* the client's copy — there are no deltas, no versions and
 * no replay, so a client that has just attached and one that has been
 * connected for hours converge on exactly the same value.
 *
 * Deliberately outside the `seq`-stamped event stream: a
 * snapshot is only ever interesting when it's the current one, so buffering old
 * ones to replay after a reconnect would cost memory to deliver staleness.
 */
export const statePushSchema = z.object({
  kind: z.literal("push"),
  type: z.literal("state"),
  state: z.lazy(() => daemonSnapshotSchema),
});
export type StatePush = z.infer<typeof statePushSchema>;

/**
 * Raw adapter events and daemon notices, numbered for diagnostics.
 * Authoritative state travels separately in a whole-fleet {@link StatePush}.
 */
export const pushFrameSchema = z.discriminatedUnion("type", [eventPushSchema, noticePushSchema]);
export type PushFrame = z.infer<typeof pushFrameSchema>;

export const frameSchema = z.union([
  requestFrameSchema,
  responseFrameSchema,
  pushFrameSchema,
  statePushSchema,
]);
export type Frame = z.infer<typeof frameSchema>;

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export const gitFactsSchema = z.object({
  branch: z.union([z.string(), z.null()]),
  commits: z.number(),
  aheadOfBase: z.number(),
  behindBase: z.number(),
  dirty: z.boolean(),
  lastCommitSubject: z.union([z.string(), z.null()]),
});
export type GitFacts = z.infer<typeof gitFactsSchema>;

/** Daemon vitals fixed for the life of the process. */
export const daemonInfoSchema = z.object({
  pid: z.number(),
  version: z.string(),
  startedAt: z.number(),
  repoRoot: z.string(),
  /** Per-process id. A change across a reconnect means the daemon restarted. */
  epoch: z.string(),
});
export type DaemonInfo = z.infer<typeof daemonInfoSchema>;

/** Everything a client needs to render the fleet. See {@link StatePush}. */
export const daemonSnapshotSchema = z.object({
  daemon: daemonInfoSchema,
  providers: z.array(z.lazy(() => providerInfoSchema)),
  sessions: z.array(z.lazy(() => sessionSnapshotSchema)),
});
export type DaemonSnapshot = z.infer<typeof daemonSnapshotSchema>;

export const sessionSnapshotSchema = z.object({
  id: z.string(),
  parentId: z.union([z.string(), z.null()]),
  /** For a hard fork: the parent turn it branched at. null for a root session. */
  forkTurn: z.union([z.number(), z.null()]),
  provider: z.string(),
  model: z.union([z.string(), z.null()]),
  effort: z.union([z.string(), z.null()]),
  mode: z.string(),
  /** Server-confirmed selection waiting to take effect on the next turn. */
  pendingMode: sessionModeSchema.optional(),
  status: sessionStateSchema,
  title: z.union([z.string(), z.null()]),
  /** A user-authored note about the session — meta, not part of the event log. */
  comment: z.union([z.string(), z.null()]),
  worktree: z.union([z.string(), z.null()]),
  branch: z.union([z.string(), z.null()]),
  baseBranch: z.union([z.string(), z.null()]),
  /** Runs in the repo working dir with no dedicated worktree — no branch
   *  isolation, and hard-fork is unavailable. Distinguishes an in-place session
   *  from a gc'd one (both have `worktree: null`). */
  inPlace: z.boolean(),
  /** Immutable execution mode; absent only for legacy rows. */
  isolation: z.enum(["vm", "local"]).optional(),
  usage: tokenUsageSchema,
  contextUsed: z.number(),
  contextLimit: z.number(),
  costUsd: z.number(),
  /** Lifetime provenance; `table` denotes an endpoint estimate, `partial` unpriced spend. */
  costSource: z.union([
    z.literal("table"),
    z.literal("provider"),
    z.literal("none"),
    z.literal("mixed"),
    z.literal("partial"),
  ]),
  turns: z.number(),
  /** Sub-agents this session has spawned (Claude's Task tool). Runtime-only, not persisted. */
  subagents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      active: z.boolean(),
    }),
  ),
  /**
   * Live background tasks the session spawned — async subagents, backgrounded
   * shells, workflows. Non-empty implies `status.kind === "working_background"`
   * (or a live state that will settle there). Runtime-only, not persisted.
   */
  backgroundTasks: z.array(
    z.object({
      id: z.string(),
      kind: backgroundTaskKindSchema,
      title: z.string(),
    }),
  ),
  /**
   * The provider's account-plan usage windows (Claude: `five_hour` / `seven_day`),
   * keyed by window name. Empty for API-key sessions, which have no such plan.
   * Persisted per account/profile; expired observations are omitted.
   */
  rateLimits: z.record(
    z.string(),
    z.object({
      status: z.union([z.literal("allowed"), z.literal("allowed_warning"), z.literal("rejected")]),
      utilization: z.number().optional(),
      resetsAt: z.number().optional(),
      observedAt: z.number().optional(),
    }),
  ),
  /**
   * Prompt-cache liveness inputs. `ttlMinutes` is the TTL the countdown runs
   * on (5, 60, or 0 = unknown) and `ttlSource` says where it came from:
   * `observed` is ground truth read back off a response, `config` is the
   * `prompt_cache_ttl` pin standing in until the session writes cache once,
   * `none` is neither. `lastTurnAt` (epoch ms) arms the countdown; the
   * read/write split of the last turn says whether that turn actually hit cache.
   */
  cache: z.object({
    ttlMinutes: z.number(),
    ttlSource: z.union([z.literal("observed"), z.literal("config"), z.literal("none")]),
    lastTurnAt: z.number(),
    lastRead: z.number(),
    lastWrite: z.number(),
  }),
  /**
   * Keep-warm is on for this session: while it sits idle the daemon re-primes
   * the prompt cache with a tiny turn just before the TTL lapses, so the next
   * real message still hits cache. Claude-only (needs a pinned `cache.ttlMinutes`);
   * runtime-only, not persisted — a daemon restart clears it.
   */
  keepWarm: z.boolean(),
  /**
   * The session's provider can `undo` (`session.rewind`) — its adapter reports
   * `capabilities.rewind`. Lets the TUI offer `u` without encoding which
   * providers support it. Runtime-only, not persisted.
   */
  canRewind: z.boolean(),
  /** Whether the session can be used under the current provider/isolation configuration. */
  resumable: z.boolean(),
  /** Persistent, actionable reason for a read-only session. Runtime-only. */
  resumeBlockedReason: z.string().optional(),
  /**
   * Blocking requests the turn is parked on, oldest first — complete enough to
   * render and answer without any transcript. Non-empty iff
   * `status.kind === "awaiting_input"`; `status.on` is the reason of whichever
   * request most recently parked the turn. Parallel tool calls each raise their
   * own permission, so this is a queue: answering one leaves the rest, and the
   * snapshot is republished with the remainder. Runtime-only, not persisted.
   */
  requests: z.array(sessionInteractionSchema),
  /**
   * A compaction is in flight: `startedAt` is when it began (epoch ms),
   * `before` the context fill it started from, `generated` the chars of summary
   * streamed so far (a liveness proxy, not a percentage). Runtime-only, not
   * persisted — the `compact_progress` beats behind it aren't either, so this
   * overlay is how a freshly attached client (reopened TUI, second window)
   * still shows "compacting…". Absent otherwise.
   */
  compacting: z
    .object({
      startedAt: z.number(),
      before: z.number(),
      generated: z.number(),
    })
    .optional(),
  /** Stop requested; the provider has not yet confirmed cancellation. */
  stopping: z.boolean().optional(),
  /** Cancellation failed; retry interrupt before starting more work. */
  stopFailed: z.boolean().optional(),
  git: z.union([gitFactsSchema, z.null()]),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

// ---------------------------------------------------------------------------
// cache / usage stats (`stats.models`)
// ---------------------------------------------------------------------------

/**
 * Token usage attributed to one provider+model. `SessionSnapshot.usage` is per
 * session and a session can change model mid-life, so its totals are a mixture;
 * these rows are the breakdown, and answer "is this model caching at all, and
 * for how long".
 */
export const modelUsageSchema = z.object({
  provider: z.string(),
  /** "" when the provider never reported one. */
  model: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  costUsd: z.number(),
  turns: z.number(),
  /**
   * Last prompt-cache TTL observed for this pair, in minutes; 0 = never
   * observed (the provider reports no TTL, or has never written cache here).
   */
  ttlMinutes: z.number(),
  /**
   * Longest observed gap followed by a cache hit, in seconds; 0 = unseen.
   * Evidence only: aggregated reports can contain writes followed by hits.
   */
  maxHitGapSec: z.number(),
  /** Shortest observed gap followed by a miss after cache activity; not a TTL ceiling. */
  minMissGapSec: z.number(),
  /** Sessions that contributed — 1 for a per-session row. */
  sessions: z.number(),
  updatedAt: z.number(),
});
export type ModelUsage = z.infer<typeof modelUsageSchema>;

// ---------------------------------------------------------------------------
// hello handshake
// ---------------------------------------------------------------------------

export const helloParamsSchema = z.object({
  protocolVersion: z.number(),
  /** Stable id for this client instance; used in change attribution. */
  clientId: z.string(),
});
export type HelloParams = z.infer<typeof helloParamsSchema>;

/** One row in the model picker — a canonical id plus display trimmings. */
export const modelChoiceSchema = z.object({
  id: z.string(),
  /** Friendly name; falls back to `id` when the provider gives none. */
  label: z.string(),
  /** Context-window size in tokens, when the provider reports it. */
  context: z.number().optional(),
  /** Whether this model accepts a thinking-effort level. */
  supportsEffort: z.boolean().optional(),
  /** The effort levels it accepts, when the provider enumerates them.
   *  Endpoint-advertised lists pass through verbatim — they may name levels
   *  outside Loom's own effort-level union (OpenAI's `minimal`, …). */
  effortLevels: z.array(z.string()).optional(),
  /** The effort the provider defaults to for this model, when advertised —
   *  the picker marks it, and a session created without a choice sends it. */
  defaultEffort: z.string().optional(),
});
export type ModelChoice = z.infer<typeof modelChoiceSchema>;

/** A configured provider, for the TUI's creation flow and model switcher. */
export const providerInfoSchema = z.object({
  id: z.string(),
  /** Canonical model ids — used for defaults, dedupe, and the aisdk picker.
   *  For `claude` this is the CLI-reported catalog (discovered at daemon
   *  start-up); for aisdk it's the configured / `/models`-probed list. */
  models: z.array(z.string()),
  /** Richer picker rows (labels, context sizes) when the provider has them —
   *  Claude does. Parallel to `models`; the picker falls back to a bare `id`. */
  modelChoices: z.array(modelChoiceSchema).optional(),
  /**
   * The start-up model discovery is still running (the Claude CLI catalog
   * probe). The picker shows a loading state instead of the list; the next
   * state snapshot carries the settled list when it lands.
   */
  modelsLoading: z.boolean().optional(),
  /** Actionable diagnostic when automatic model discovery fails. */
  modelsError: z.string().optional(),
  /**
   * Model a new session gets when none is chosen: the last one run on this
   * provider (remembered across restarts), else a config pin, else the first
   * detected model. "" when nothing is known yet.
   */
  defaultModel: z.string(),
  /**
   * Effort level a new session gets when none is chosen: the last one used on
   * this provider (remembered across restarts). "" when nothing is known yet
   * or the provider has no effort-capable models.
   */
  defaultEffort: z.string(),
  /**
   * Permission mode a new session gets when none is chosen: the last one a
   * session was created with (remembered across restarts), else `default`
   * (manual). Same value on every entry — it isn't per-provider.
   */
  defaultMode: sessionModeSchema,
  defaultIsolation: z.enum(["vm", "local"]).optional(),
  vmUnavailableReason: z.string().optional(),
  /** Short label (Detail pane, `loom ls`). */
  tag: z.string(),
  /** Fleet-row id colour — an Ink colour name, or "" for the plain default. */
  color: z.string(),
  /** True for the provider new sessions use when none is named. */
  isDefault: z.boolean(),
  /**
   * Claude only — the OAuth identity behind this profile's `~/.claude` dir, read
   * from `.claude.json` / `.credentials.json`. Omitted when neither field could
   * be resolved; either string may still be "". Shown in the Detail pane to
   * disambiguate a personal vs work profile.
   */
  account: z
    .object({
      loginMethod: z.string(),
      org: z.string(),
    })
    .optional(),
});
export type ProviderInfo = z.infer<typeof providerInfoSchema>;

// ---------------------------------------------------------------------------
// daemon.doctor — diagnostics
// ---------------------------------------------------------------------------

/** One connector package the daemon can load lazily, for `daemon.doctor`. */
export const doctorConnectorSchema = z.object({
  /** npm package name, e.g. `@loom/connector-claude`. */
  pkg: z.string(),
  /** Configured provider ids this package serves (`claude`, `fake`, aisdk profiles). */
  providerIds: z.array(z.string()),
  /** A provider from this package has actually been constructed this process —
   *  the thunk stays unevaluated until a session first uses that provider. */
  loaded: z.boolean(),
});
export type DoctorConnector = z.infer<typeof doctorConnectorSchema>;

/** One configured MCP mount and its local configuration health. */
export const doctorMcpServerSchema = z.object({
  name: z.string(),
  /** Configured command, or "HTTP MCP" for a remote mount. */
  command: z.string(),
  /** Executable plus arguments, or the HTTP origin (without credentials/query). */
  resolved: z.string(),
  /** `ok` on PATH · `missing` unrunnable. */
  status: z.union([z.literal("ok"), z.literal("missing")]),
  /** Set only when the command was rewritten or a binary is missing. */
  note: z.string(),
});
export type DoctorMcpServer = z.infer<typeof doctorMcpServerSchema>;

/**
 * `daemon.doctor` — a read-only snapshot of the tool / connector / MCP
 * environment a new session would get, plus daemon vitals. Backs the TUI's
 * doctor overlay (Space palette → "doctor").
 */
export const doctorReportSchema = z.object({
  daemon: z.object({
    pid: z.number(),
    version: z.string(),
    startedAt: z.number(),
    uptimeMs: z.number(),
    epoch: z.string(),
    repoRoot: z.string(),
    /** Distinct attached clients / raw socket connections. */
    clients: z.number(),
    connections: z.number(),
    /** Number of events and notices emitted by this daemon, for diagnostics. */
    eventSeq: z.number(),
    sessions: z.number(),
    runningSessions: z.number(),
  }),
  connectors: z.array(doctorConnectorSchema),
  mcp: z.array(doctorMcpServerSchema),
  /**
   * Tool names a session sees, by origin. `claude` / `aisdk` are the
   * provider-native built-ins (indicative — the daemon doesn't own those
   * lists); every session additionally gets `loom` and every `mcp` server.
   */
  tools: z.object({
    loom: z.array(z.string()),
    claude: z.array(z.string()),
    aisdk: z.array(z.string()),
    /** Built-ins Loom disables on Claude sessions (steered onto `fff` instead). */
    claudeDisabled: z.array(z.string()),
  }),
  webSearch: z.object({
    backend: z.union([z.literal("none"), z.literal("brave"), z.literal("tavily")]),
    /** Backend set and its key resolved — aisdk sessions then get `web_search`. */
    enabled: z.boolean(),
    note: z.string(),
  }),
  /** `lintConfig` output — misconfigured providers, unset env vars, keyless search. */
  configWarnings: z.array(z.string()),
});
export type DoctorReport = z.infer<typeof doctorReportSchema>;

export const helloResultSchema = z.object({
  protocolVersion: z.number(),
  daemon: daemonInfoSchema,
});
export type HelloResult = z.infer<typeof helloResultSchema>;
