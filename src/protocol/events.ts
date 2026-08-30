/**
 * The normalized event union every provider adapter emits (design spec §3).
 * Milestone 1 has no adapter yet, but the daemon's event log, persistence and
 * wire protocol are all typed against this union so adapters slot in later
 * without reshaping anything downstream.
 */

export type SessionStatus =
  | "starting"
  | "awaiting_input"
  | "running"
  | "interrupted"
  | "idle"
  | "error"
  | "done";

export type AwaitReason = "permission" | "question" | "plan_review";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface HarnessEventBase {
  /** Session this event belongs to. */
  sessionId: string;
  /** Sub-agent that produced it, when applicable. */
  agentId?: string;
  /** Adapter-side monotonic ordinal within the session, if the adapter provides one. */
  ordinal?: number;
  /** Wall-clock time the daemon observed the event. */
  ts: number;
}

export interface AssistantTextEvent extends HarnessEventBase {
  type: "assistant_text";
  text: string;
}

export interface ThinkingEvent extends HarnessEventBase {
  type: "thinking";
  text: string;
}

export interface ToolCallEvent extends HarnessEventBase {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultEvent extends HarnessEventBase {
  type: "tool_result";
  id: string;
  ok: boolean;
  output: unknown;
}

export interface PermissionRequestEvent extends HarnessEventBase {
  type: "permission_request";
  id: string;
  tool: string;
  input: unknown;
  suggestions?: unknown;
}

/** The agent called the loom `ask_user` tool and is blocked on a human answer. */
export interface QuestionEvent extends HarnessEventBase {
  type: "question";
  id: string;
  question: string;
  /** Optional background the agent supplied with the question. */
  context?: string;
}

/** A human answered an outstanding {@link QuestionEvent}; the turn resumes. */
export interface AnswerEvent extends HarnessEventBase {
  type: "answer";
  id: string;
  text: string;
}

/**
 * In `plan` mode the agent called the harness's "present a plan" tool. The turn
 * blocks on a {@link PlanDecision} — surfaced as `awaiting_input` / `plan_review`.
 */
export interface PlanReviewEvent extends HarnessEventBase {
  type: "plan_review";
  id: string;
  plan: string;
}

export interface UsageEvent extends HarnessEventBase {
  type: "usage";
  tokens: TokenUsage;
  /** Input tokens on the most recent request — numerator for context-window fill. */
  contextUsed: number;
  /** Model context limit from Loom's catalogue (not the SDK). */
  contextLimit: number;
  /** Incremental dollar cost attributed to this event, if computed. */
  costDeltaUsd?: number;
}

/**
 * The context window was compacted (`/compact`, or an automatic threshold in
 * the provider). `before` / `after` are the context-token counts either side of
 * the boundary; `after` is 0 when the provider doesn't report it until the next
 * turn. Status is unaffected.
 */
export interface CompactEvent extends HarnessEventBase {
  type: "compact";
  trigger: "manual" | "auto";
  before: number;
  after: number;
  summary?: string;
}

/**
 * A heartbeat while a compaction is in flight. Summarising a long history can
 * take minutes (the model rewrites the whole transcript into a summary), so the
 * provider ticks one of these out every few seconds. `generated` is the length
 * of summary text produced so far — a liveness proxy, not a percentage; there's
 * no true progress number for a single streamed completion. A `compact` (or a
 * fatal `error`) ends the run. Not persisted or shown in the transcript.
 */
export interface CompactProgressEvent extends HarnessEventBase {
  type: "compact_progress";
  /** ms since the compaction started. */
  elapsedMs: number;
  /** chars of summary text streamed so far. */
  generated: number;
  /** context-token count at the start, for a "compacting 120k" label. */
  before: number;
}

export interface SubagentStartedEvent extends HarnessEventBase {
  type: "subagent_started";
  subagentId: string;
  name: string;
}

export interface SubagentStoppedEvent extends HarnessEventBase {
  type: "subagent_stopped";
  subagentId: string;
}

export interface StatusChangedEvent extends HarnessEventBase {
  type: "status_changed";
  status: SessionStatus;
  reason?: AwaitReason | string;
}

export interface ErrorEvent extends HarnessEventBase {
  type: "error";
  message: string;
  fatal: boolean;
}

export interface ResultEvent extends HarnessEventBase {
  type: "result";
  ok: boolean;
  summary?: string;
  /**
   * Why the turn ended, when it wasn't the model stopping on its own.
   * `step_limit` — the aisdk per-segment step ceiling tripped
   * `MAX_TURN_SEGMENTS` times without the turn completing (probable loop). The
   * session is left `idle`, so a plain `send` continues it. Absent on a normal
   * finish.
   */
  stopReason?: "step_limit";
}

/**
 * The session was rewound to an earlier turn (`undo`) — the transcript past
 * `toTurn` was discarded. Daemon-emitted, not from an adapter. Status is left
 * at `idle`.
 */
export interface RewindEvent extends HarnessEventBase {
  type: "rewind";
  toTurn: number;
}

/**
 * A user message the daemon delivered while a turn was already in flight.
 * `injected: true` means it reached the model mid-turn (aisdk: after the
 * current tool result, before the next step); on Claude it is queued by the
 * SDK for the next turn boundary. Emitted so every client sees it land, since
 * the composing client's local echo doesn't reach the others.
 */
export interface UserMessageEvent extends HarnessEventBase {
  type: "user_message";
  text: string;
  injected: boolean;
}

export type HarnessEvent =
  | AssistantTextEvent
  | ThinkingEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | QuestionEvent
  | AnswerEvent
  | PlanReviewEvent
  | UsageEvent
  | CompactEvent
  | CompactProgressEvent
  | SubagentStartedEvent
  | SubagentStoppedEvent
  | StatusChangedEvent
  | ErrorEvent
  | ResultEvent
  | RewindEvent
  | UserMessageEvent;

export type HarnessEventType = HarnessEvent["type"];
