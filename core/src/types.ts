import type { HostStopReason } from "./vm-termination.ts";
import { mcpGrantsSchema } from "./mcp-config.ts";
import { z } from "zod";
import { opaqueSchema } from "./schema.ts";
import { initHookSchema } from "./init-hook.ts";
const effortLevelSchema = z.string();
/**
 * The provider seam (design spec §3). Nothing above the adapter layer imports a
 * vendor SDK; adapters normalize to the one `HarnessEvent` union and this pair
 * of interfaces. The Claude adapter ships in V1; ADK is a designed-for second.
 */
import {
  providerTotalSchema,
  tokenUsageSchema,
  type HarnessEvent,
  type PlanWindow,
} from "./events.ts";
import { sessionStateSchema } from "./session-state.ts";
import type { SendOptions } from "./message-queue.ts";

export const sessionModeSchema = z.enum(["default", "plan", "acceptEdits", "auto"]);
export type SessionMode = z.infer<typeof sessionModeSchema>;

/** How hard the model should think. Claude's five levels are the well-known
 *  suggestions (for autocomplete); the type stays open so a model's own
 *  advertised strings (an OpenAI `minimal`, a future vendor value) pass
 *  through the shared interfaces and RPC validation without a cast — vendor-
 *  specific restrictions belong inside connectors, not this union. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | (string & {});

export const providerCapabilitiesSchema = z.object({
  /** Mode changes take effect immediately (Claude) vs. next turn (ADK). See
   *  {@link liveModelSwitch} for model-change timing, which can differ. */
  liveModeSwitch: z.boolean(),
  /** Model changes take effect immediately vs. next turn — kept separate from
   *  {@link liveModeSwitch} because a provider's timing for the two can differ
   *  (Codex app-server applies a mode change live but a model change only on
   *  the next turn). */
  liveModelSwitch: z.boolean(),
  /** `resumeSession` honours {@link SessionRef.forkHistory}: the provider can
   *  copy its own native history (Claude's session, a Codex thread) into a new
   *  provider session. A transcript Loom owns is copied by the daemon instead
   *  (see {@link ownsTranscript}). */
  forking: z.boolean(),
  /** `rewind(keep)` can truncate the transcript to an earlier turn (undo). */
  rewind: z.boolean(),
  subagents: z.boolean(),
  /** `compact()` is driven through the provider's own harness (vs. Loom rebuilding history). */
  compaction: z.boolean(),
  /** `compact(instructions)` actually honors a custom `instructions` string
   *  rather than silently ignoring it — independent of {@link compaction}
   *  (Claude and aisdk both honor instructions but get there differently: one
   *  through its own harness, one by Loom's own summarizer). A caller must
   *  reject non-blank instructions up front when this is `false` rather than
   *  silently downgrading to plain compaction the caller didn't ask for. */
  compactionInstructions: z.boolean(),
  /** The session's message history lives in Loom's own transcript store
   *  (aisdk's `provider_messages`) rather than in a thread the provider owns
   *  (Claude's session, a Codex app-server thread). Gates whether the daemon's
   *  transcript-based checkpoint / rewind / fork / cross-provider-switch
   *  machinery is safe to use. */
  ownsTranscript: z.boolean(),
  /** Can run a cheap, tool-free single-turn call (used for auto-titling). */
  oneShot: z.boolean(),
  /** Emits `input_consumed` for input sent with an `inputId`: a queued message
   *  reaches the chat log when the agent takes it up rather than when it is
   *  handed over. Absent counts as false. */
  inputReceipts: z.boolean().optional(),
  /** Emits token counts before the final result (partial usage). */
  partialTokens: z.boolean(),
  permissionModes: z.array(sessionModeSchema),
  models: z.array(z.string()),
});
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

/** Capability preferences are independent of server tool names and schemas. */
export const MCP_CAPABILITIES = [
  "read",
  "write",
  "edit",
  "find",
  "grep",
  "web_search",
  "web_fetch",
] as const;
export type McpCapability = (typeof MCP_CAPABILITIES)[number];

/** A vendor-neutral MCP server description. */
export const mcpServerHandleSchema = z.object({
  name: z.string(),
  /** Configured tools must connect successfully before a session runs. */
  required: z.boolean().optional(),
  /** Preferred capabilities; tools retain their own names and input schemas. */
  defaultFor: z.array(z.enum(MCP_CAPABILITIES)).optional(),
  /** Upstream credential env name to omit from native child environments. */
  credentialEnv: z.string().optional(),
  spec: z.union([
    z.object({
      transport: z.literal("runtime"),
      runtime: z.string(),
      isolation: z.literal("vm"),
      grants: mcpGrantsSchema.optional(),
    }),
    z.object({
      transport: z.literal("stdio"),
      command: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
    z.object({
      transport: z.literal("http"),
      url: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
    }),
  ]),
});
export type McpServerHandle = z.infer<typeof mcpServerHandleSchema>;

export const agentDefinitionSpecSchema = z.object({
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
});
export type AgentDefinitionSpec = z.infer<typeof agentDefinitionSpecSchema>;

// Shared with the VM runtime, which must not import session types.
export { initHookSchema, type InitHook } from "./init-hook.ts";

/**
 * Loom agents (`docs/loom-agents.md`): what a session gets from its agent
 * profile and its place in the supervision tree. The daemon recomputes them
 * for every start, resume included.
 */
const agentSessionFields = {
  /** Mount the `loom-agents` tools: the session may start and manage children. */
  agentTools: z.boolean().optional(),
  /** The profile's prompt (and, for a child, a note on its supervisor),
   *  appended to the agent's own system prompt — developer instructions for
   *  Codex, which builds its own. */
  agentPrompt: z.string().optional(),
  /** Claude skills to load from the profile's `<config_dir>/skills`; absent keeps the CLI's own. */
  skills: z.array(z.string()).optional(),
  /** Built-in tools the agent may use; absent allows them all. */
  allowTools: z.array(z.string()).optional(),
  /** Built-in tools withheld from the agent. */
  denyTools: z.array(z.string()).optional(),
};

/** The daemon's answer to an `agent_call`: the tool's text result. */
export const agentCallResultSchema = z.object({ ok: z.boolean(), text: z.string() });
export type AgentCallResult = z.infer<typeof agentCallResultSchema>;

/**
 * The end of a background task's output, read on demand
 * ({@link AgentSession.readTaskOutput}). `output` is what the command printed,
 * escape sequences included, so render it as plain text. `unreadable`: the
 * provider has no output for this task (Claude: only shell and Monitor tasks
 * have one); `unsupported`: the provider cannot read task output at all.
 */
export const taskOutputSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("output"),
    output: z.string(),
    /** The size of the whole output in bytes. */
    totalBytes: z.int().nonnegative(),
    /** `output` is only the end of a longer output. */
    truncated: z.boolean(),
  }),
  z.object({ t: z.literal("unreadable") }),
  z.object({ t: z.literal("unsupported") }),
]);
export type TaskOutput = z.infer<typeof taskOutputSchema>;

export const createSessionOptionsSchema = z.object({
  /** Trusted workspace_start commands, consumed once per worker start, including resume. */
  initHooks: z
    .object({
      hooks: z.array(initHookSchema).max(64),
      env: z.record(z.string(), z.string()),
    })
    .optional(),
  /** Loom's session id. The adapter tags the provider's own id separately. */
  sessionId: z.string(),
  /** The session's worktree (or, until the worktree manager lands, the repo root). */
  cwd: z.string(),
  prompt: z.string(),
  /** A person wrote `prompt` — not a supervisor's task or a Loom-made seed. */
  promptByHuman: z.boolean().optional(),
  model: z.string().optional(),
  /** Thinking effort, for models that accept one ({@link DiscoveredModel.supportsEffort}). */
  effort: effortLevelSchema.optional(),
  mode: sessionModeSchema,
  parentId: z.string().optional(),
  /** Steering text for the provider's system prompt — tool steer plus `repoInstructions`. */
  systemPromptAppend: z.string().optional(),
  /** The repository's AGENTS.md, framed, when this provider would not read it
   *  itself (`repoInstructionsFor` in the daemon), or `null`/absent. A
   *  connector that builds its own system-prompt append instead of using
   *  `systemPromptAppend` verbatim (chatgpt) splices this in directly. */
  repoInstructions: z.union([z.string(), z.null()]).optional(),
  /** The directory to describe to the model as its workspace root (e.g. in
   *  tool-steer text), kept distinct from `cwd` (where the provider's own
   *  process/tooling actually runs). Defaults to `cwd` when omitted. */
  workspaceRoot: z.string().optional(),
  /**
   * The session's own base, as a ref its checkout resolves (`origin/<branch>`
   * in a private clone; a branch or commit otherwise) — what the `status` tool
   * counts ahead/behind against. Absent for a session stored without a base:
   * the provider-wide `ConnectorContext.baseBranch` applies.
   */
  base: z.string().optional(),
  mcpServers: z.array(mcpServerHandleSchema),
  /** Mount the in-process `loom` MCP server (ask_user, commit) in this session. */
  loomServer: z.boolean().optional(),
  ...agentSessionFields,
  subagents: z.array(agentDefinitionSpecSchema).optional(),
  /** Built-in tools to disable (e.g. Grep / Glob — fff replaces them). */
  disableTools: z.array(z.string()).optional(),
  /** Which settings layers to load (`project` pulls CLAUDE.md). */
  settingSources: z.array(z.string()).optional(),
  /**
   * A throwaway single-turn call (titling, classification). Adapters should
   * keep it cheap: no MCP, no persistence, one turn.
   */
  oneShot: z.boolean().optional(),
});
export type CreateSessionOptions = z.infer<typeof createSessionOptionsSchema>;

export const sessionRefSchema = z.object({
  /** Workspace startup hooks are recomputed for every worker launch, including resumes. */
  initHooks: createSessionOptionsSchema.shape["initHooks"].optional(),
  sessionId: z.string(),
  /** The provider's own persisted session identifier. */
  providerRef: z.string(),
  cwd: z.string(),
  model: z.string().optional(),
  effort: effortLevelSchema.optional(),
  mode: sessionModeSchema.optional(),
  /** MCP servers to re-mount on resume (the daemon's current `[[mcp]]` list). */
  mcpServers: z.array(mcpServerHandleSchema).optional(),
  /** Steering text for the provider's system prompt — recomputed by the daemon
   *  at resume time the same way as at creation (see `CreateSessionOptions`). */
  systemPromptAppend: z.string().optional(),
  /** See {@link CreateSessionOptions.repoInstructions} — recomputed by the
   *  daemon at resume time the same way as at creation. */
  repoInstructions: z.union([z.string(), z.null()]).optional(),
  /** See {@link CreateSessionOptions.workspaceRoot}. */
  workspaceRoot: z.string().optional(),
  /** See {@link CreateSessionOptions.base}. */
  base: z.string().optional(),
  ...agentSessionFields,
  /**
   * The provider's running totals for `providerRef` as Loom last observed
   * them. An adapter whose provider restores its totals on resume seeds its
   * baseline from this only when the provider cannot report what it restored.
   */
  usageBaseline: providerTotalSchema.optional(),
  /**
   * Native history fork: copy `providerRef`'s history into a new provider
   * session and resume the copy, leaving `providerRef` itself untouched. The
   * session reports the copy's id as its `providerRef` as soon as it returns.
   * Only sent to a provider whose `capabilities.forking` is true; the copy
   * starts its own usage ledger, so `usageBaseline` (the source's) is unused.
   */
  forkHistory: z.boolean().optional(),
});
export type SessionRef = z.infer<typeof sessionRefSchema>;

export type UserInput = string;

export const permissionDecisionSchema = z.discriminatedUnion("behavior", [
  z.object({
    behavior: z.literal("allow"),
    updatedInput: z.record(z.string(), opaqueSchema).optional(),
  }),
  z.object({
    behavior: z.literal("deny"),
    message: z.string().optional(),
  }),
]);
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;

/**
 * The user's answer to a `plan_review` (the agent called the harness's
 * "present a plan" tool in `plan` mode).
 *
 * - `implement` — accept; the agent proceeds in the same context.
 * - `implement_fresh` — accept, but reduce the context to the plan + goal
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
export const planDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("implement"),
    mode: sessionModeSchema.optional(),
  }),
  z.object({
    action: z.literal("implement_fresh"),
    mode: sessionModeSchema.optional(),
    model: z.string().optional(),
    effort: effortLevelSchema.optional(),
  }),
  z.object({
    action: z.literal("revise"),
    plan: z.string(),
    mode: sessionModeSchema.optional(),
  }),
  z.object({
    action: z.literal("discuss"),
    message: z.string(),
  }),
  z.object({
    action: z.literal("handoff"),
  }),
]);
export type PlanDecision = z.infer<typeof planDecisionSchema>;

/** What an adapter can report about a live session without the daemon's help. */
export const adapterSnapshotSchema = z.object({
  status: sessionStateSchema,
  providerRef: z.union([z.string(), z.null()]),
  model: z.union([z.string(), z.null()]),
  effort: z.union([z.string(), z.null()]),
  mode: sessionModeSchema,
  usage: tokenUsageSchema,
  /** Selected mode waiting for the next turn; absent once effective. */
  pendingMode: sessionModeSchema.optional(),
  contextUsed: z.number(),
  contextLimit: z.number(),
  costUsd: z.number(),
  turns: z.number(),
  /**
   * The last completed turn's fork point, for an adapter that rewinds through
   * its own harness rather than a message count (Claude: the turn's last
   * chain-entry UUID, passed back as `rewind`'s `at`). Absent for adapters that
   * own the transcript array (aisdk).
   */
  rewindRef: z.string().optional(),
});
export type AdapterSnapshot = z.infer<typeof adapterSnapshotSchema>;

export interface AgentSession {
  readonly id: string;
  readonly providerRef: string | null;
  /** The normalized event stream. Ends when the run's process exits. */
  events(): AsyncIterable<HarnessEvent>;
  /**
   * Send a follow-up turn / answer. A queued message carries `opts`: its
   * `inputId` names it to the provider and to `input_consumed`, and `midTurn`
   * says it goes into the live turn. Loom's own sends carry none.
   */
  send(input: UserInput, opts?: SendOptions): Promise<void>;
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
   * Answer an `agent_call` the session emitted. An unknown or already-settled
   * id (the turn was interrupted meanwhile) is a no-op. Absent on adapters
   * that never mount the agent tools.
   */
  respondToAgentCall?(id: string, result: AgentCallResult): Promise<void>;
  /**
   * The session's base was renamed ({@link CreateSessionOptions.base}): the
   * `status` tool counts against `base` from its next call. A Loom agent's
   * base is its supervisor's branch, which auto-titling renames. Absent on
   * adapters without a `status` tool.
   */
  setBase?(base: string): Promise<void>;
  /**
   * Read the account's plan windows now, past the adapter's own throttle.
   * Starts the read and resolves without waiting for it: the windows arrive as
   * `rate_limit` events. Absent on adapters with no subscription plan.
   */
  refreshPlanUsage?(): Promise<void>;
  /**
   * The end of a background task's output (`taskId` as `background_tasks`
   * reports it), for a client showing the task while it runs. Read-only; no
   * turn. Absent on adapters that cannot read task output.
   */
  readTaskOutput?(taskId: string): Promise<TaskOutput>;
  /**
   * Stop the current turn. Together with {@link close}, this MUST cancel any
   * in-flight long-running operation — a turn, a compaction, a sub-agent, a
   * fork — and settle promptly (do not wait out a multi-minute summarise).
   * Parked permission / question / plan promises MUST be resolved so a gated
   * tool `execute` unwinds. Idempotent; safe to call on an already-stopped
   * session. Resolve only after cancellation is confirmed; reject if any
   * requested cancellation failed or work is known to remain queued.
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
  close(reason?: HostStopReason): Promise<void>;
}

export interface AgentProvider {
  /** The connector consumes deferred init hooks before its first turn. */
  readonly supportsAsyncInit?: boolean;
  close?(): Promise<void>;
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  createSession(opts: CreateSessionOptions): Promise<AgentSession>;
  resumeSession(ref: SessionRef): Promise<AgentSession>;
  listPersistedSessions(): Promise<SessionRef[]>;
  /**
   * Models this provider can run right now, discovered live (e.g. the Claude
   * CLI's own catalog, an OpenAI `/models` probe). Optional — a provider with
   * no catalog omits it and callers fall back to configured `models`. Metadata
   * only: discovery never starts a conversation. `signal` cancels it, and an
   * implementation that runs a subprocess must stop that process on abort.
   */
  listModels?(signal?: AbortSignal): Promise<DiscoveredModel[]>;
  /**
   * The account's subscription plan windows, read without a session — the
   * fallback when no live session on the account can poll them. Metadata only,
   * like {@link listModels}: no conversation, no transcript, credentials used
   * in place. Empty when the account has no plan (an API key). `signal`
   * cancels it, stopping any subprocess.
   */
  readPlanUsage?(signal?: AbortSignal): Promise<PlanWindow[]>;
}

export const discoveredModelSchema = z.object({
  /** The id to pass to the API. */
  id: z.string(),
  /** A friendly display name, when the provider gives one. */
  label: z.string().optional(),
  /** The provider's description of the model, when it gives one. */
  description: z.string().optional(),
  /** The provider marks this as its default model. */
  isDefault: z.boolean().optional(),
  /** Context-window size in tokens, when known. */
  context: z.number().optional(),
  /** Whether this model accepts a thinking-effort level. */
  supportsEffort: z.boolean().optional(),
  /** The effort levels it accepts, when the provider enumerates them.
   *  Endpoint-advertised lists pass through verbatim — they may name levels
   *  outside Loom's own {@link EffortLevel} set (OpenAI's `minimal`, …). */
  effortLevels: z.array(z.string()).optional(),
  /** Backend-selected effort when the user has not chosen one. */
  defaultEffort: z.string().optional(),
});
export type DiscoveredModel = z.infer<typeof discoveredModelSchema>;

/** Map a Loom session mode to the closest provider permission mode label. */
export const SESSION_MODES = sessionModeSchema.options;

export const isSessionMode = (v: unknown): v is SessionMode => {
  return sessionModeSchema.safeParse(v).success;
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
