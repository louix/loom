/**
 * The provider seam (design spec §3). Nothing above the adapter layer imports a
 * vendor SDK; adapters normalize to the one `HarnessEvent` union and this pair
 * of interfaces. The Claude adapter ships in V1; ADK is a designed-for second.
 */
import type { HarnessEvent, SessionState, TokenUsage } from "./events.ts";

export type SessionMode = "default" | "plan" | "acceptEdits" | "auto";

/** How hard the model should think. Claude's five levels are the well-known
 *  suggestions (for autocomplete); the type stays open so a model's own
 *  advertised strings (an OpenAI `minimal`, a future vendor value) pass
 *  through the shared interfaces and RPC validation without a cast — vendor-
 *  specific restrictions belong inside connectors, not this union. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | (string & {});

export interface ProviderCapabilities {
  /** Mode changes take effect immediately (Claude) vs. next turn (ADK). See
   *  {@link liveModelSwitch} for model-change timing, which can differ. */
  liveModeSwitch: boolean;
  /** Model changes take effect immediately vs. next turn — kept separate from
   *  {@link liveModeSwitch} because a provider's timing for the two can differ
   *  (Codex app-server applies a mode change live but a model change only on
   *  the next turn). */
  liveModelSwitch: boolean;
  forking: boolean;
  /** `rewind(keep)` can truncate the transcript to an earlier turn (undo). */
  rewind: boolean;
  subagents: boolean;
  /** `compact()` is driven through the provider's own harness (vs. Loom rebuilding history). */
  compaction: boolean;
  /** `compact(instructions)` actually honors a custom `instructions` string
   *  rather than silently ignoring it — independent of {@link compaction}
   *  (Claude and aisdk both honor instructions but get there differently: one
   *  through its own harness, one by Loom's own summarizer). A caller must
   *  reject non-blank instructions up front when this is `false` rather than
   *  silently downgrading to plain compaction the caller didn't ask for. */
  compactionInstructions: boolean;
  /** The session's message history lives in Loom's own transcript store
   *  (aisdk's `provider_messages`) rather than in a thread the provider owns
   *  (Claude's session, a Codex app-server thread). Gates whether the daemon's
   *  transcript-based checkpoint / rewind / fork / cross-provider-switch
   *  machinery is safe to use. */
  ownsTranscript: boolean;
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

export interface CreateSessionOptions {
  /** Loom's session id. The adapter tags the provider's own id separately. */
  sessionId: string;
  /** The session's worktree (or, until the worktree manager lands, the repo root). */
  cwd: string;
  prompt: string;
  model?: string;
  /** Thinking effort, for models that accept one ({@link DiscoveredModel.supportsEffort}). */
  effort?: EffortLevel;
  mode: SessionMode;
  parentId?: string;
  /** Steering text for the provider's system prompt — tool steer plus the repo's `.loom/LOOM.md`. */
  systemPromptAppend?: string;
  /** Pre-resolved `.loom/LOOM.md` repository instructions (the daemon's own
   *  `cwd`-then-repoRoot fallback already applied), or `null`/absent when
   *  none exist. A connector that builds its own system-prompt append
   *  instead of using `systemPromptAppend` verbatim (chatgpt) splices this
   *  in directly rather than reading the file itself — only the daemon knows
   *  the repo root a worktree `cwd` falls back to. */
  repoInstructions?: string | null;
  /** The directory to describe to the model as its workspace root (e.g. in
   *  tool-steer text), kept distinct from `cwd` (where the provider's own
   *  process/tooling actually runs). Defaults to `cwd` when omitted. */
  workspaceRoot?: string;
  mcpServers: McpServerHandle[];
  /** Mount the in-process `loom` MCP server (ask_user, commit) in this session. */
  loomServer?: boolean;
  subagents?: AgentDefinitionSpec[];
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
  effort?: EffortLevel;
  mode?: SessionMode;
  /** MCP servers to re-mount on resume (the daemon's current `[[mcp]]` list). */
  mcpServers?: McpServerHandle[];
  /** Steering text for the provider's system prompt — recomputed by the daemon
   *  at resume time the same way as at creation (see `CreateSessionOptions`). */
  systemPromptAppend?: string;
  /** See {@link CreateSessionOptions.repoInstructions} — recomputed by the
   *  daemon at resume time the same way as at creation. */
  repoInstructions?: string | null;
  /** See {@link CreateSessionOptions.workspaceRoot}. */
  workspaceRoot?: string;
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
 *   first, so implementation starts lean. May also retarget the `model` /
 *   `effort` the implementation runs under (the plan review's `⌥p`).
 * - `revise` — the user edited the plan; the agent implements *that* text.
 * - `discuss` — send a message back; the agent iterates, staying in plan mode.
 * - `handoff` — the plan is approved but implementation moved to a separate
 *   session (an `⌥p` retarget onto a different provider); end this turn, the
 *   session goes idle. Never produced by the harness tool — the daemon issues
 *   it after spawning the fork.
 *
 * The implementing actions carry the permission `mode` the implementation
 * should run in (`default` / `acceptEdits` / `auto` — never `plan`). When
 * omitted each adapter falls back to what it did before the field existed.
 */
export type PlanDecision =
  | { action: "implement"; mode?: SessionMode }
  | { action: "implement_fresh"; mode?: SessionMode; model?: string; effort?: EffortLevel }
  | { action: "revise"; plan: string; mode?: SessionMode }
  | { action: "discuss"; message: string }
  | { action: "handoff" };

/** What an adapter can report about a live session without the daemon's help. */
export interface AdapterSnapshot {
  status: SessionState;
  providerRef: string | null;
  model: string | null;
  effort: string | null;
  mode: SessionMode;
  usage: TokenUsage;
  contextUsed: number;
  contextLimit: number;
  costUsd: number;
  turns: number;
  /**
   * The last completed turn's fork point, for an adapter that rewinds through
   * its own harness rather than a message count (Claude: the turn's last
   * chain-entry UUID, passed back as `rewind`'s `at`). Absent for adapters that
   * own the transcript array (aisdk).
   */
  rewindRef?: string;
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
  /**
   * Stop the current turn. Together with {@link close}, this MUST cancel any
   * in-flight long-running operation — a turn, a compaction, a sub-agent, a
   * fork — and settle promptly (do not wait out a multi-minute summarise).
   * Parked permission / question / plan promises MUST be resolved so a gated
   * tool `execute` unwinds. Idempotent; safe to call on an already-stopped
   * session.
   */
  interrupt(): Promise<void>;
  /**
   * Undo: drop everything after an earlier turn. `keep` is a message count for
   * adapters that own the transcript (aisdk); `at` is the kept turn's last
   * chain-entry ref for adapters that rewind through their harness (Claude —
   * `AdapterSnapshot.rewindRef`). Only called when `capabilities.rewind` is
   * true; others may throw.
   */
  rewind(keep: number, at?: string): Promise<void>;
  setMode(mode: SessionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  setEffort(effort: EffortLevel): Promise<void>;
  snapshot(): AdapterSnapshot;
  /**
   * Tear the session down. MUST cancel any in-flight operation (as
   * {@link interrupt}) and MUST NOT emit an event or write persistence after it
   * returns. After `close()` the `events()` iterator is ended.
   */
  close(): Promise<void>;
}

export interface AgentProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  createSession(opts: CreateSessionOptions): Promise<AgentSession>;
  resumeSession(ref: SessionRef): Promise<AgentSession>;
  listPersistedSessions(): Promise<SessionRef[]>;
  /**
   * Models this provider can run right now, discovered live (e.g. the Claude
   * CLI's own catalog, an OpenAI `/models` probe). Optional — a provider with
   * no catalog omits it and callers fall back to configured `models`.
   */
  listModels?(): Promise<DiscoveredModel[]>;
}

export interface DiscoveredModel {
  /** The id to pass to the API. */
  id: string;
  /** A friendly display name, when the provider gives one. */
  label?: string;
  /** Context-window size in tokens, when known. */
  context?: number;
  /** Whether this model accepts a thinking-effort level. */
  supportsEffort?: boolean;
  /** The effort levels it accepts, when the provider enumerates them.
   *  Endpoint-advertised lists pass through verbatim — they may name levels
   *  outside Loom's own {@link EffortLevel} set (OpenAI's `minimal`, …). */
  effortLevels?: string[];
  /** Backend-selected effort when the user has not chosen one. */
  defaultEffort?: string;
}

/** Map a Loom session mode to the closest provider permission mode label. */
export const SESSION_MODES: readonly SessionMode[] = ["default", "plan", "acceptEdits", "auto"];

export const isSessionMode = (v: unknown): v is SessionMode => {
  return typeof v === "string" && (SESSION_MODES as readonly string[]).includes(v);
};

/**
 * Resolve a mode string, accepting `"manual"` as the user-facing alias for
 * `"default"` (the SDK's own name — you approve everything). Returns `null` for
 * anything unrecognised.
 */
export const normalizeSessionMode = (v: unknown): SessionMode | null => {
  if (v === "manual") return "default";
  return isSessionMode(v) ? v : null;
};

export type { HarnessEvent };
