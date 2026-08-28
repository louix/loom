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
}

export type HarnessEvent =
  | AssistantTextEvent
  | ThinkingEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | UsageEvent
  | SubagentStartedEvent
  | SubagentStoppedEvent
  | StatusChangedEvent
  | ErrorEvent
  | ResultEvent;

export type HarnessEventType = HarnessEvent["type"];
