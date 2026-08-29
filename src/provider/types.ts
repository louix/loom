/**
 * The provider seam (design spec §3). Nothing above the adapter layer imports a
 * vendor SDK; adapters normalize to the one `HarnessEvent` union and this pair
 * of interfaces. The Claude adapter ships in V1; ADK is a designed-for second.
 */
import type { HarnessEvent, SessionStatus, TokenUsage } from "../protocol/events.ts";

export type SessionMode = "default" | "plan" | "acceptEdits" | "auto";

export interface ProviderCapabilities {
  /** Mode / model changes take effect immediately (Claude) vs. next turn (ADK). */
  liveModeSwitch: boolean;
  forking: boolean;
  subagents: boolean;
  /** `compact()` is driven through the provider's own harness (vs. Loom rebuilding history). */
  compaction: boolean;
  /** Can run a cheap, tool-free single-turn call (used for auto-titling). */
  oneShot: boolean;
  /** Emits token counts before the final result (partial usage). */
  partialTokens: boolean;
  permissionModes: SessionMode[];
  models: string[];
}

/** A vendor-neutral MCP server description. The Claude adapter maps it to `mcpServers`. */
export interface McpServerHandle {
  name: string;
  spec:
    | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
    | { transport: "http"; url: string; headers?: Record<string, string> };
}

export interface AgentDefinitionSpec {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
}

export interface SessionBudget {
  maxTokens?: number;
  maxCostUsd?: number;
  maxTurns?: number;
}

export interface CreateSessionOptions {
  /** Loom's session id. The adapter tags the provider's own id separately. */
  sessionId: string;
  /** The session's worktree (or, until the worktree manager lands, the repo root). */
  cwd: string;
  prompt: string;
  model?: string;
  mode: SessionMode;
  parentId?: string;
  systemPromptAppend?: string;
  mcpServers: McpServerHandle[];
  /** Mount the in-process `loom` MCP server (ask_user, commit) in this session. */
  loomServer?: boolean;
  subagents?: AgentDefinitionSpec[];
  budget?: SessionBudget;
  /** Built-in tools to disable (e.g. Grep / Glob — fff replaces them). */
  disableTools?: string[];
  /** Which settings layers to load (`project` pulls CLAUDE.md). */
  settingSources?: string[];
  /**
   * A throwaway single-turn call (titling, classification). Adapters should
   * keep it cheap: no MCP, no persistence, one turn.
   */
  oneShot?: boolean;
}

export interface SessionRef {
  sessionId: string;
  /** The provider's own persisted session identifier. */
  providerRef: string;
  cwd: string;
  model?: string;
  mode?: SessionMode;
  /** MCP servers to re-mount on resume (the daemon's current `[[mcp]]` list). */
  mcpServers?: McpServerHandle[];
}

export type UserInput = string;

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message?: string };

/**
 * The user's answer to a `plan_review` (the agent called the harness's
 * "present a plan" tool in `plan` mode).
 *
 * - `implement` — accept; the agent proceeds in the same context.
 * - `implement_fresh` — accept, but compact the context to the plan + goal
 *   first, so implementation starts lean.
 * - `revise` — the user edited the plan; the agent implements *that* text.
 * - `discuss` — send a message back; the agent iterates, staying in plan mode.
 */
export type PlanDecision =
  | { action: "implement" }
  | { action: "implement_fresh" }
  | { action: "revise"; plan: string }
  | { action: "discuss"; message: string };

/** What an adapter can report about a live session without the daemon's help. */
export interface AdapterSnapshot {
  status: SessionStatus;
  providerRef: string | null;
  model: string | null;
  mode: SessionMode;
  usage: TokenUsage;
  contextUsed: number;
  contextLimit: number;
  costUsd: number;
  turns: number;
}

export interface AgentSession {
  readonly id: string;
  readonly providerRef: string | null;
  /** The normalized event stream. Ends when the run's process exits. */
  events(): AsyncIterable<HarnessEvent>;
  /** Send a follow-up turn / answer. */
  send(input: UserInput): Promise<void>;
  /**
   * Compact the session's context window. Optional `instructions` steer what the
   * summary keeps. Providers that drive this through their harness (Claude's
   * `/compact`) emit a `compact` event when the boundary lands.
   */
  compact(instructions?: string): Promise<void>;
  /** Resolve an outstanding `permission_request`. First writer wins upstream. */
  respondToPermission(id: string, decision: PermissionDecision): Promise<void>;
  /** Resolve an outstanding `ask_user` question with the user's answer. */
  answerQuestion(id: string, text: string): Promise<void>;
  /** Resolve an outstanding `plan_review` with the user's decision. */
  respondToPlan(id: string, decision: PlanDecision): Promise<void>;
  interrupt(): Promise<void>;
  setMode(mode: SessionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  snapshot(): AdapterSnapshot;
  close(): Promise<void>;
}

export interface AgentProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  createSession(opts: CreateSessionOptions): Promise<AgentSession>;
  resumeSession(ref: SessionRef): Promise<AgentSession>;
  listPersistedSessions(): Promise<SessionRef[]>;
}

/** Map a Loom session mode to the closest provider permission mode label. */
export const SESSION_MODES: readonly SessionMode[] = ["default", "plan", "acceptEdits", "auto"];

export function isSessionMode(v: unknown): v is SessionMode {
  return typeof v === "string" && (SESSION_MODES as readonly string[]).includes(v);
}

export type { HarnessEvent };
