/**
 * The Claude adapter — wraps `@anthropic-ai/claude-agent-sdk` (design spec §3).
 * One `query()` per session in streaming-input mode: the prompt is an async
 * iterable we feed follow-up turns into, `canUseTool` surfaces permission
 * prompts as `HarnessEvent`s, and `SDKMessage`s are normalized by
 * {@link ClaudeEventMapper}. Mode / model changes are live control calls.
 *
 * Auth is not brokered here — the SDK uses Claude's OAuth in `~/.claude`.
 */
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  McpServerConfig,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { HarnessEvent } from "../../protocol/events.ts";
import { makeLogger, type Logger } from "../../util/logger.ts";
import { AsyncChannel } from "../../util/channel.ts";
import { ClaudeEventMapper } from "./map.ts";
import { resolveClaudeCli } from "./cli.ts";
import { buildLoomMcpServer } from "./loom-mcp.ts";
import type {
  AdapterSnapshot,
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  McpServerHandle,
  PermissionDecision,
  PlanDecision,
  ProviderCapabilities,
  SessionMode,
  SessionRef,
  UserInput,
} from "../types.ts";

const CAPS: ProviderCapabilities = {
  liveModeSwitch: true,
  forking: true,
  subagents: true,
  compaction: true,
  oneShot: true,
  partialTokens: true,
  permissionModes: ["default", "plan", "acceptEdits", "auto"],
  models: [],
};

function toPermissionMode(mode: SessionMode): PermissionMode {
  // "auto" is Loom's name for "don't ask me anything"; the rest are the SDK's
  // own permission modes and pass straight through.
  return mode === "auto" ? "bypassPermissions" : mode;
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  } as unknown as SDKUserMessage;
}

function mcpConfig(handles: McpServerHandle[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const h of handles) {
    if (h.spec.transport === "stdio") {
      out[h.name] = {
        type: "stdio",
        command: h.spec.command,
        ...(h.spec.args ? { args: h.spec.args } : {}),
        ...(h.spec.env ? { env: h.spec.env } : {}),
      };
    } else {
      out[h.name] = {
        type: "http",
        url: h.spec.url,
        ...(h.spec.headers ? { headers: h.spec.headers } : {}),
      };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

class ClaudeSession implements AgentSession {
  readonly id: string;

  #query: Query | null = null;
  #mapper: ClaudeEventMapper;
  #log: Logger;
  #mode: SessionMode;

  /** Follow-up turns fed into the streaming-input prompt. */
  #inbox = new AsyncChannel<SDKUserMessage>();
  /** Normalized events out: SDK messages + permission prompts, merged. */
  #outbox = new AsyncChannel<HarnessEvent>();
  #pendingPerms = new Map<string, (r: PermissionResult | null) => void>();
  /** Outstanding `ask_user` calls, keyed by the id on the emitted `question` event. */
  #pendingQuestions = new Map<string, (answer: string) => void>();
  /** Outstanding `ExitPlanMode` calls, keyed by the id on the emitted `plan_review` event. */
  #pendingPlans = new Map<string, (r: PermissionResult | null) => void>();
  #pump: Promise<void> | null = null;
  #closing = false;

  constructor(opts: CreateSessionOptions) {
    this.id = opts.sessionId;
    this.#mapper = new ClaudeEventMapper(opts.sessionId);
    this.#mode = opts.mode;
    this.#log = makeLogger("claude").child(opts.sessionId.slice(0, 8));
  }

  get providerRef(): string | null {
    return this.#mapper.state.providerRef;
  }

  /** Build the `query()` and start pumping its messages into the outbox. */
  start(opts: CreateSessionOptions, extra: { resume?: string; cli?: string } = {}): void {
    const { resume, cli } = extra;
    if (opts.prompt) this.#inbox.push(userMessage(opts.prompt));

    const canUseTool: CanUseTool = (toolName, input, ctx) => {
      const reqId = ctx.toolUseID || ctx.requestId;
      // In plan mode the agent presents its plan via ExitPlanMode; surface that
      // as a first-class plan review rather than a generic permission prompt.
      if (toolName === "ExitPlanMode" || toolName === "exit_plan_mode") {
        const raw = (input as { plan?: unknown } | null)?.plan;
        const plan = typeof raw === "string" && raw.trim() !== "" ? raw : JSON.stringify(input ?? {});
        return new Promise<PermissionResult | null>((resolve) => {
          this.#pendingPlans.set(reqId, resolve);
          this.#outbox.push({
            type: "plan_review",
            sessionId: this.id,
            ts: Date.now(),
            id: reqId,
            plan,
            ...(ctx.agentID ? { agentId: ctx.agentID } : {}),
          });
        });
      }
      return new Promise<PermissionResult | null>((resolve) => {
        this.#pendingPerms.set(reqId, resolve);
        this.#outbox.push({
          type: "permission_request",
          sessionId: this.id,
          ts: Date.now(),
          id: reqId,
          tool: toolName,
          input,
          ...(ctx.suggestions ? { suggestions: ctx.suggestions } : {}),
          ...(ctx.agentID ? { agentId: ctx.agentID } : {}),
        });
      });
    };

    const mcpServers = mcpConfig(opts.mcpServers);
    if (opts.loomServer) {
      mcpServers["loom"] = buildLoomMcpServer({
        cwd: opts.cwd,
        askUser: (question, context) => this.#askUser(question, context),
      });
    }

    const options: Options = {
      cwd: opts.cwd,
      permissionMode: toPermissionMode(opts.mode),
      canUseTool,
      includePartialMessages: false,
      mcpServers,
      stderr: (data) => this.#log.debug("cli stderr", { data: data.slice(0, 500) }),
      ...(cli ? { pathToClaudeCodeExecutable: cli } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(resume ? { resume } : {}),
      ...(opts.disableTools && opts.disableTools.length > 0
        ? { disallowedTools: opts.disableTools }
        : {}),
      ...(opts.settingSources
        ? { settingSources: opts.settingSources as NonNullable<Options["settingSources"]> }
        : {}),
      ...(opts.systemPromptAppend
        ? { systemPrompt: { type: "preset", preset: "claude_code", append: opts.systemPromptAppend } }
        : {}),
      ...(opts.budget?.maxTurns ? { maxTurns: opts.budget.maxTurns } : {}),
      ...(opts.subagents && opts.subagents.length > 0
        ? {
            agents: Object.fromEntries(
              opts.subagents.map((a) => [
                a.name,
                {
                  description: a.description,
                  prompt: a.prompt,
                  ...(a.tools ? { tools: a.tools } : {}),
                  ...(a.model ? { model: a.model } : {}),
                },
              ]),
            ) as NonNullable<Options["agents"]>,
          }
        : {}),
    };

    this.#query = query({ prompt: this.#inbox, options });
    this.#pump = this.#drain();
  }

  async #drain(): Promise<void> {
    const q = this.#query;
    if (!q) return;
    try {
      for await (const msg of q) {
        for (const ev of this.#mapper.map(msg)) this.#outbox.push(ev);
      }
    } catch (err) {
      if (!this.#closing) {
        this.#outbox.push({
          type: "error",
          sessionId: this.id,
          ts: Date.now(),
          message: err instanceof Error ? err.message : String(err),
          fatal: true,
        });
      }
    } finally {
      this.#outbox.close();
      this.#inbox.close();
    }
  }

  events(): AsyncIterable<HarnessEvent> {
    return this.#outbox;
  }

  async send(input: UserInput): Promise<void> {
    if (this.#closing) throw new Error("session is closing");
    this.#inbox.push(userMessage(input));
  }

  /**
   * Drive the Claude Code CLI's `/compact` command over the streaming input.
   * The CLI treats a leading-slash user message as a command; when the summary
   * lands it emits a `compact_boundary` system message, which the mapper turns
   * into a `compact` event.
   */
  async compact(instructions?: string): Promise<void> {
    if (this.#closing) throw new Error("session is closing");
    const trimmed = instructions?.trim();
    this.#inbox.push(userMessage(trimmed ? `/compact ${trimmed}` : "/compact"));
  }

  async respondToPermission(id: string, decision: PermissionDecision): Promise<void> {
    const resolve = this.#pendingPerms.get(id);
    if (!resolve) return; // already resolved / unknown — first writer won
    this.#pendingPerms.delete(id);
    if (decision.behavior === "allow") {
      resolve({
        behavior: "allow",
        ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
      });
    } else {
      resolve({ behavior: "deny", message: decision.message ?? "denied by user" });
    }
  }

  /** loom `ask_user` handler: emit a `question` event, block until answered. */
  #askUser(question: string, context: string | undefined): Promise<string> {
    const id = randomUUID();
    return new Promise<string>((resolve) => {
      this.#pendingQuestions.set(id, resolve);
      this.#outbox.push({
        type: "question",
        sessionId: this.id,
        ts: Date.now(),
        id,
        question,
        ...(context ? { context } : {}),
      });
    });
  }

  async answerQuestion(id: string, text: string): Promise<void> {
    const resolve = this.#pendingQuestions.get(id);
    if (!resolve) return; // already answered / unknown — first writer won
    this.#pendingQuestions.delete(id);
    this.#outbox.push({ type: "answer", sessionId: this.id, ts: Date.now(), id, text });
    resolve(text);
  }

  async respondToPlan(id: string, decision: PlanDecision): Promise<void> {
    const resolve = this.#pendingPlans.get(id);
    if (!resolve) return; // already resolved / unknown — first writer won
    this.#pendingPlans.delete(id);

    if (decision.action === "implement") {
      // Native exit: the SDK leaves plan mode and the turn implements.
      resolve({ behavior: "allow" });
      return;
    }

    // The other three cases end the ExitPlanMode call and re-drive the session
    // deterministically, so behaviour doesn't hinge on SDK `updatedInput` support.
    if (decision.action === "discuss") {
      resolve({ behavior: "deny", message: decision.message });
      return; // stays in plan mode; the message arrives as the next user turn
    }

    resolve({ behavior: "deny", message: "Plan accepted — implementing now." });
    if (decision.action === "implement_fresh") {
      await this.compact(
        "Keep the approved plan and the original goal verbatim. Drop the exploration transcript.",
      );
    }
    await this.setMode("acceptEdits");
    const plan = decision.action === "revise" ? decision.plan : "the plan you just presented";
    await this.send(`The plan is approved. Implement it now:\n\n${plan}`);
  }

  async interrupt(): Promise<void> {
    await this.#query?.interrupt();
  }

  async setMode(mode: SessionMode): Promise<void> {
    this.#mode = mode;
    await this.#query?.setPermissionMode(toPermissionMode(mode));
  }

  async setModel(model: string): Promise<void> {
    await this.#query?.setModel(model);
  }

  snapshot(): AdapterSnapshot {
    const s = this.#mapper.state;
    return {
      status: "running",
      providerRef: s.providerRef,
      model: s.model,
      mode: this.#mode,
      usage: { ...s.usage },
      contextUsed: s.contextUsed,
      contextLimit: s.contextLimit,
      costUsd: s.costUsd,
      turns: s.turns,
    };
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const [, resolve] of this.#pendingPerms) resolve({ behavior: "deny", message: "session closed" });
    this.#pendingPerms.clear();
    for (const [, resolve] of this.#pendingQuestions) resolve("(the session was closed before the user answered)");
    this.#pendingQuestions.clear();
    for (const [, resolve] of this.#pendingPlans) resolve({ behavior: "deny", message: "session closed" });
    this.#pendingPlans.clear();
    try {
      this.#query?.close();
    } catch {
      // best effort
    }
    this.#outbox.close();
    this.#inbox.close();
    await this.#pump?.catch(() => {});
  }
}

// ---------------------------------------------------------------------------

export interface ClaudeProviderOptions {
  /** `providers.claude.cli_path` — "" means discover / bundled. */
  cliPath?: string;
}

export class ClaudeProvider implements AgentProvider {
  readonly id = "claude";
  readonly capabilities = CAPS;

  readonly #cliPathOption: string;
  #cli: string | undefined;
  #cliResolved = false;

  constructor(opts: ClaudeProviderOptions = {}) {
    this.#cliPathOption = opts.cliPath ?? "";
  }

  #resolveCli(): string | undefined {
    if (!this.#cliResolved) {
      this.#cli = resolveClaudeCli(this.#cliPathOption);
      this.#cliResolved = true;
    }
    return this.#cli;
  }

  async createSession(opts: CreateSessionOptions): Promise<AgentSession> {
    const cli = this.#resolveCli();
    const s = new ClaudeSession(opts);
    s.start(opts, { ...(cli ? { cli } : {}) });
    return s;
  }

  async resumeSession(ref: SessionRef): Promise<AgentSession> {
    const cli = this.#resolveCli();
    const opts: CreateSessionOptions = {
      sessionId: ref.sessionId,
      cwd: ref.cwd,
      prompt: "", // resume replays in-flight state; the next real turn comes via send()
      mode: ref.mode ?? "default",
      mcpServers: [],
      loomServer: true,
      ...(ref.model ? { model: ref.model } : {}),
    };
    const s = new ClaudeSession(opts);
    s.start(opts, { resume: ref.providerRef, ...(cli ? { cli } : {}) });
    return s;
  }

  async listPersistedSessions(): Promise<SessionRef[]> {
    // Wired up with the worktree manager (M3), which owns the per-session cwd.
    return [];
  }
}
