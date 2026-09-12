import { z } from "zod";
import { opaqueSchema } from "./schema.ts";
import { cacheCreationSchema } from "./cache.ts";
/**
 * The normalized event union every provider adapter emits (design spec §3).
 * Milestone 1 has no adapter yet, but the daemon's event log, persistence and
 * wire protocol are all typed against this union so adapters slot in later
 * without reshaping anything downstream.
 */
import { sessionStateSchema, type SessionState, type SessionStateKind } from "./session-state.ts";

/**
 * What a blocked turn is waiting on. `user_question` is the SDK's own
 * multiple-choice `AskUserQuestion` tool (answered, not approved/denied);
 * `question` is Loom's `ask_user`.
 */
export type { AwaitReason } from "./session-state.ts";

// The session's turn state is a closed union — see `./session-state.ts`.
export type { SessionState, SessionStateKind };

export const tokenUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export const harnessEventBaseSchema = z.object({
  /** Session this event belongs to. */
  sessionId: z.string(),
  /** Sub-agent that produced it, when applicable. */
  agentId: z.string().optional(),
  /** Adapter-side monotonic ordinal within the session, if the adapter provides one. */
  ordinal: z.number().optional(),
  /** Wall-clock time the daemon observed the event. */
  ts: z.number(),
});
export type HarnessEventBase = z.infer<typeof harnessEventBaseSchema>;

export const assistantTextEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("assistant_text"),
  text: z.string(),
});
export type AssistantTextEvent = z.infer<typeof assistantTextEventSchema>;

export const thinkingEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("thinking"),
  text: z.string(),
});
export type ThinkingEvent = z.infer<typeof thinkingEventSchema>;

export const toolCallEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("tool_call"),
  id: z.string(),
  name: z.string(),
  input: opaqueSchema,
});
export type ToolCallEvent = z.infer<typeof toolCallEventSchema>;

export const toolResultEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("tool_result"),
  id: z.string(),
  ok: z.boolean(),
  output: opaqueSchema,
});
export type ToolResultEvent = z.infer<typeof toolResultEventSchema>;

export const permissionRequestEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("permission_request"),
  id: z.string(),
  tool: z.string(),
  input: opaqueSchema,
  suggestions: opaqueSchema.optional(),
});
export type PermissionRequestEvent = z.infer<typeof permissionRequestEventSchema>;

/** The agent called the loom `ask_user` tool and is blocked on a human answer. */
export const questionEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("question"),
  id: z.string(),
  question: z.string(),
  /** Optional background the agent supplied with the question. */
  context: z.string().optional(),
});
export type QuestionEvent = z.infer<typeof questionEventSchema>;

/** A human answered an outstanding {@link QuestionEvent}; the turn resumes. */
export const answerEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("answer"),
  id: z.string(),
  text: z.string(),
});
export type AnswerEvent = z.infer<typeof answerEventSchema>;

/**
 * In `plan` mode the agent called the harness's "present a plan" tool. The turn
 * blocks on a {@link PlanDecision} — surfaced as `awaiting_input` / `plan_review`.
 */
export const planReviewEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("plan_review"),
  id: z.string(),
  plan: z.string(),
});
export type PlanReviewEvent = z.infer<typeof planReviewEventSchema>;

export const usageEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("usage"),
  tokens: tokenUsageSchema,
  /** Input tokens on the most recent request — numerator for context-window fill. */
  contextUsed: z.number(),
  /** Model context limit from Loom's catalogue (not the SDK). */
  contextLimit: z.number(),
  /** Incremental dollar cost attributed to this event, if computed. */
  costDeltaUsd: z.number().optional(),
  /**
   * The prompt-cache TTL the provider actually wrote at on this turn, in
   * minutes (5 or 60). Ground truth read back off the response — not the TTL
   * Loom asked for — so a pin the provider silently declined (an API key, a
   * plan outside its usage limits, Bedrock) shows up instead of being assumed.
   * Absent when the turn wrote no cache, or the provider reports no split.
   */
  cacheTtlMinutes: z.number().optional(),
  /** Observed per-TTL write counts, used to price mixed cache writes. */
  cacheCreation: cacheCreationSchema.optional(),
});
export type UsageEvent = z.infer<typeof usageEventSchema>;

/**
 * The context window's fill moved, with no token accounting attached. A turn
 * drives many model requests and the meter should follow each one, but a
 * {@link UsageEvent} carries three other facts — billable tokens, a turn
 * boundary that arms the cache countdown, and the observed cache TTL — none of
 * which a mid-turn request has settled yet. So the fill travels on its own.
 *
 * Ephemeral, like {@link CompactProgressEvent}: not persisted, never in the
 * transcript, read only off the session snapshot. An adapter that already
 * emits a `usage` per model request (the aisdk path) has no use for it.
 */
export const contextEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("context"),
  /** Input tokens on the most recent request — numerator for context-window fill. */
  contextUsed: z.number(),
  /**
   * Model context limit from Loom's catalogue (not the SDK). Absent when the
   * adapter hasn't learned it yet (it arrives with the first completed turn) —
   * a beat without it moves the numerator and leaves the stored scale alone,
   * rather than resetting a resumed session's limit to zero.
   */
  contextLimit: z.number().optional(),
});
export type ContextEvent = z.infer<typeof contextEventSchema>;

/**
 * The context window was compacted (`/compact`, or an automatic threshold in
 * the provider). `before` / `after` are the context-token counts either side of
 * the boundary; `after` is 0 when the provider doesn't report it until the next
 * turn. Status is unaffected.
 */
export const compactEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("compact"),
  trigger: z.union([z.literal("manual"), z.literal("auto")]),
  before: z.number(),
  after: z.number(),
  summary: z.string().optional(),
});
export type CompactEvent = z.infer<typeof compactEventSchema>;

/**
 * A heartbeat while a compaction is in flight. Summarising a long history can
 * take minutes (the model rewrites the whole transcript into a summary), so the
 * provider ticks one of these out every few seconds. `generated` is the length
 * of summary text produced so far — a liveness proxy, not a percentage; there's
 * no true progress number for a single streamed completion. A `compact` (or a
 * fatal `error`) ends the run. Not persisted or shown in the transcript.
 */
export const compactProgressEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("compact_progress"),
  /** ms since the compaction started. */
  elapsedMs: z.number(),
  /** chars of summary text streamed so far. */
  generated: z.number(),
  /** context-token count at the start, for a "compacting 120k" label. */
  before: z.number(),
});
export type CompactProgressEvent = z.infer<typeof compactProgressEventSchema>;

export const subagentStartedEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("subagent_started"),
  subagentId: z.string(),
  name: z.string(),
});
export type SubagentStartedEvent = z.infer<typeof subagentStartedEventSchema>;

export const subagentStoppedEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("subagent_stopped"),
  subagentId: z.string(),
});
export type SubagentStoppedEvent = z.infer<typeof subagentStoppedEventSchema>;

/** Coarse classification of a background task, for an icon / label. */
export const backgroundTaskKindSchema = z.union([
  z.literal("subagent"),
  z.literal("shell"),
  z.literal("workflow"),
  z.literal("monitor"),
  z.literal("other"),
]);
export type BackgroundTaskKind = z.infer<typeof backgroundTaskKindSchema>;

export const backgroundTaskInfoSchema = z.object({
  /** The provider's task id — stable for the task's lifetime. */
  id: z.string(),
  kind: backgroundTaskKindSchema,
  /** A one-line human label (task description, or the shell command). */
  title: z.string(),
});
export type BackgroundTaskInfo = z.infer<typeof backgroundTaskInfoSchema>;

/**
 * The session's full set of live background tasks after a membership change —
 * an async subagent spawned, a backgrounded shell started or exited, a workflow
 * settled. REPLACE semantics: a consumer swaps its whole set for `tasks` and
 * never pairs start/stop edges (mirrors the SDK's own level signal). An empty
 * `tasks` means all background work has drained. Housekeeping / ambient tasks
 * are filtered out by the adapter, and the adapter suppresses a repeat event
 * whose membership is unchanged.
 *
 * State-bearing: a non-empty set holds a settled turn in `working_background`
 * instead of `idle`; an empty set releases it.
 */
export const backgroundTasksEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("background_tasks"),
  tasks: z.array(backgroundTaskInfoSchema),
});
export type BackgroundTasksEvent = z.infer<typeof backgroundTasksEventSchema>;

export const statusChangedEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("status_changed"),
  status: sessionStateSchema,
  /** An audit breadcrumb for the transition (`"rewind"`, `"resumed"`, …), not part of the state. */
  note: z.string().optional(),
});
export type StatusChangedEvent = z.infer<typeof statusChangedEventSchema>;

/** Host startup activity, available before an agent's event stream exists. */
export const startupProgressEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("startup_progress"),
  message: z.string(),
});
export type StartupProgressEvent = z.infer<typeof startupProgressEventSchema>;

export const errorEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("error"),
  message: z.string(),
  fatal: z.boolean(),
});
export type ErrorEvent = z.infer<typeof errorEventSchema>;

/** A turn ended cleanly. `summary` is the model's closing text, if any. */
export const resultOkEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("result"),
  kind: z.literal("ok"),
  summary: z.string().optional(),
  /**
   * Why the turn ended, when it wasn't the model stopping on its own.
   * `step_limit` — the aisdk per-segment step ceiling tripped
   * `MAX_TURN_SEGMENTS` times without the turn completing (probable loop). The
   * session is left `idle`, so a plain `send` continues it. Absent on a normal
   * finish.
   */
  stopReason: z.literal("step_limit").optional(),
});
export type ResultOkEvent = z.infer<typeof resultOkEventSchema>;

/** A turn ended on a failure. `error` is always populated. */
export const resultErrorEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("result"),
  kind: z.literal("error"),
  error: z.string(),
});
export type ResultErrorEvent = z.infer<typeof resultErrorEventSchema>;

export const resultEventSchema = z.discriminatedUnion("kind", [
  resultOkEventSchema,
  resultErrorEventSchema,
]);
export type ResultEvent = z.infer<typeof resultEventSchema>;

/**
 * The session was rewound to an earlier turn (`undo`) — the transcript past
 * `toTurn` was discarded. Daemon-emitted, not from an adapter. Status is left
 * at `idle`.
 */
export const rewindEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("rewind"),
  toTurn: z.number(),
});
export type RewindEvent = z.infer<typeof rewindEventSchema>;

/**
 * The session's provider was switched live (`⌥p`) — the conversation continues
 * on `provider` / `model` / `effort`. Daemon-emitted, not from an adapter.
 * Status is left at `idle`.
 *
 * `lossy` is true when the transcript could not be handed to the new provider
 * verbatim (a switch touching Claude, whose history lives server-side) and the
 * target was seeded from a rendered digest of the prior turns instead.
 */
export const providerChangedEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("provider_changed"),
  /** New provider id. */
  provider: z.string(),
  model: z.union([z.string(), z.null()]),
  effort: z.union([z.string(), z.null()]),
  /** Provider id the session ran on before the switch. */
  from: z.string(),
  lossy: z.boolean(),
});
export type ProviderChangedEvent = z.infer<typeof providerChangedEventSchema>;

/**
 * A user message the daemon delivered while a turn was already in flight.
 * `injected: true` means it reached the model mid-turn (aisdk: after the
 * current tool result, before the next step); on Claude it is queued by the
 * SDK for the next turn boundary. Emitted so every client sees it land, since
 * the composing client's local echo doesn't reach the others.
 */
export const userMessageEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("user_message"),
  text: z.string(),
  injected: z.boolean(),
});
export type UserMessageEvent = z.infer<typeof userMessageEventSchema>;

/**
 * The provider's own account-plan usage, for a subscription session (not an
 * API-key one, which has no such window). One event covers one window
 * (`rateLimitType`) — e.g. Claude reports `five_hour` and `seven_day`
 * separately, so a consumer should key state by `rateLimitType` and merge
 * rather than overwrite.
 */
export const rateLimitEventSchema = harnessEventBaseSchema.extend({
  type: z.literal("rate_limit"),
  status: z.union([z.literal("allowed"), z.literal("allowed_warning"), z.literal("rejected")]),
  /** The usage window this reading is for, e.g. `five_hour` / `seven_day`. Absent when the provider doesn't distinguish windows. */
  window: z.string().optional(),
  /** Percentage of the window used, 0-100+. */
  utilization: z.number().optional(),
  /** When the window resets (epoch ms). */
  resetsAt: z.number().optional(),
});
export type RateLimitEvent = z.infer<typeof rateLimitEventSchema>;

export const harnessEventSchema = z.discriminatedUnion("type", [
  assistantTextEventSchema,
  thinkingEventSchema,
  toolCallEventSchema,
  toolResultEventSchema,
  permissionRequestEventSchema,
  questionEventSchema,
  answerEventSchema,
  planReviewEventSchema,
  usageEventSchema,
  contextEventSchema,
  compactEventSchema,
  compactProgressEventSchema,
  subagentStartedEventSchema,
  subagentStoppedEventSchema,
  backgroundTasksEventSchema,
  statusChangedEventSchema,
  startupProgressEventSchema,
  errorEventSchema,
  resultEventSchema,
  rewindEventSchema,
  providerChangedEventSchema,
  userMessageEventSchema,
  rateLimitEventSchema,
]);
export type HarnessEvent = z.infer<typeof harnessEventSchema>;

export type HarnessEventType = HarnessEvent["type"];
