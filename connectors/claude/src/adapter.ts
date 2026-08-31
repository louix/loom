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
import type { HarnessEvent } from "@loom/core/events";
import { makeLogger, type Logger } from "@loom/core/logger";
import { AsyncChannel } from "@loom/core/channel";
import { ClaudeEventMapper } from "./map.ts";
import { resolveClaudeCli } from "./cli.ts";
import { buildLoomMcpServer } from "./loom-mcp.ts";
import type {
  AdapterSnapshot,
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  DiscoveredModel,
  EffortLevel,
  McpServerHandle,
  PermissionDecision,
  PlanDecision,
  ProviderCapabilities,
  SessionMode,
  SessionRef,
  UserInput,
} from "@loom/core/types";

const CAPS: ProviderCapabilities = {
  liveModeSwitch: true,
  forking: true,
  rewind: false, // F3: resumeSessionAt / resumeDropsTurn
  subagents: true,
  compaction: true,
  oneShot: true,
  partialTokens: true,
  // All four map 1:1 onto the SDK's PermissionMode. In particular `auto` is the
  // SDK's own "auto" (Claude proceeds, but still prompts for anything it judges
  // unsafe) — *not* `bypassPermissions`, which is the one that needs the CLI to
  // be launched with --dangerously-skip-permissions and which Loom never uses.
  permissionModes: ["default", "plan", "acceptEdits", "auto"],
  models: [],
};

/** {@link SessionMode} is a subset of the SDK's {@link PermissionMode}. */
const toPermissionMode = (mode: SessionMode): PermissionMode => mode;

/** Pull a context-window size out of a `[1m]` / `[200k]` style tag; 0 if none. */
const parseContextTag = (s: string): number => {
  const m = /\[(\d+(?:\.\d+)?)\s*([mk])\]/i.exec(s);
  if (!m) return 0;
  return Math.round(parseFloat(m[1]!) * (m[2]!.toLowerCase() === "m" ? 1_000_000 : 1_000));
};

const userMessage = (text: string): SDKUserMessage => {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  } as unknown as SDKUserMessage;
};

const mcpConfig = (handles: McpServerHandle[]): Record<string, McpServerConfig> => {
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
};

// ---------------------------------------------------------------------------

class ClaudeSession implements AgentSession {
  readonly id: string;

  #query: Query | null = null;
  #mapper: ClaudeEventMapper;
  #log: Logger;
  #mode: SessionMode;
  #effort: EffortLevel | null;

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
  /**
   * Set by `interrupt()`, cleared by the next `send()`. The SDK's `interrupt()`
   * aborts the live turn but not turns already sitting in its command queue (a
   * message the user sent mid-turn, or the plan-approval path's own follow-up).
   * While this is set, `#drain` keeps the mapper's accounting current but drops
   * every mapped event, so a queued turn can't stream chatter into a session
   * the user has stopped. A real `send()` supersedes the interrupt.
   */
  #interrupted = false;

  constructor(opts: CreateSessionOptions) {
    this.id = opts.sessionId;
    this.#mapper = new ClaudeEventMapper(opts.sessionId);
    this.#mode = opts.mode;
    this.#effort = opts.effort ?? null;
    this.#log = makeLogger("claude").child(opts.sessionId.slice(0, 8));
  }

  get providerRef(): string | null {
    return this.#mapper.state.providerRef;
  }

  /** Build the `query()` and start pumping its messages into the outbox. */
  start(
    opts: CreateSessionOptions,
    extra: { resume?: string; cli?: string; promptCacheTtl?: string } = {},
  ): void {
    const { resume, cli, promptCacheTtl } = extra;
    if (opts.prompt) this.#inbox.push(userMessage(opts.prompt));

    const canUseTool: CanUseTool = (toolName, input, ctx) => {
      const reqId = ctx.toolUseID || ctx.requestId;
      // In plan mode the agent presents its plan via ExitPlanMode; surface that
      // as a first-class plan review rather than a generic permission prompt.
      if (toolName === "ExitPlanMode" || toolName === "exit_plan_mode") {
        const raw = (input as { plan?: unknown } | null)?.plan;
        const plan =
          typeof raw === "string" && raw.trim() !== "" ? raw : JSON.stringify(input ?? {});
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
      // `env` REPLACES the subprocess environment, so spread process.env first.
      // Pinning the cache TTL makes the TUI's liveness countdown exact.
      ...(promptCacheTtl
        ? { env: { ...process.env, CLAUDE_CODE_PROMPT_CACHE_TTL: promptCacheTtl } }
        : {}),
      ...(cli ? { pathToClaudeCodeExecutable: cli } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(resume ? { resume } : {}),
      ...(opts.disableTools && opts.disableTools.length > 0
        ? { disallowedTools: opts.disableTools }
        : {}),
      ...(opts.settingSources
        ? { settingSources: opts.settingSources as NonNullable<Options["settingSources"]> }
        : {}),
      ...(opts.systemPromptAppend
        ? {
            systemPrompt: {
              type: "preset",
              preset: "claude_code",
              append: opts.systemPromptAppend,
            },
          }
        : {}),
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
        // Always run the mapper — it carries cumulative token / cost state
        // that must stay correct even for a turn we're suppressing.
        const events = this.#mapper.map(msg);
        if (this.#interrupted) continue;
        for (const ev of events) this.#outbox.push(ev);
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
      // The CLI process ended (crash / transport error) without `close()` —
      // resolve any outstanding gate/ask_user/plan promise so the MCP tool's
      // `execute` doesn't hang forever.
      this.#rejectPending("the session ended before this was answered");
      this.#outbox.close();
      this.#inbox.close();
    }
  }

  /** Resolve every outstanding permission / question / plan promise. */
  #rejectPending(reason: string): void {
    for (const [, resolve] of this.#pendingPerms) resolve({ behavior: "deny", message: reason });
    this.#pendingPerms.clear();
    for (const [, resolve] of this.#pendingQuestions) resolve(`(${reason})`);
    this.#pendingQuestions.clear();
    for (const [, resolve] of this.#pendingPlans) resolve({ behavior: "deny", message: reason });
    this.#pendingPlans.clear();
  }

  events(): AsyncIterable<HarnessEvent> {
    return this.#outbox;
  }

  async send(input: UserInput): Promise<void> {
    if (this.#closing) throw new Error("session is closing");
    this.#interrupted = false; // a fresh user turn supersedes any prior interrupt
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
      // Native exit: the SDK leaves plan mode and the turn implements. Mirror
      // that into our own mode so `snapshot()` (and the daemon registry that
      // reads it) stops reporting "plan" once the turn is already executing.
      try {
        await this.setMode("default");
      } catch (err) {
        this.#log.warn("failed to sync mode after plan exit", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
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
    // Stop the live turn, and don't let anything queued behind it speak into
    // the stopped session. `#inbox.drain()` clears sends the SDK hasn't pulled
    // yet; `#interrupted` (lifted by the next `send()`) muzzles a turn already
    // in the SDK's own command queue — 0.3.251's `interrupt()` takes no
    // `cancel_queued`, so that queue can't be emptied from here.
    this.#interrupted = true;
    this.#inbox.drain();
    const receipt = await this.#query?.interrupt();
    const queued = receipt?.still_queued;
    if (queued && queued.length > 0) {
      this.#log.debug("interrupt left queued turns in the CLI", { count: queued.length });
    }
  }

  async rewind(_keep: number): Promise<void> {
    throw new Error("rewind for Claude sessions lands in fork-tree F3 (resumeSessionAt)");
  }

  async setMode(mode: SessionMode): Promise<void> {
    try {
      await this.#query?.setPermissionMode(toPermissionMode(mode));
      this.#mode = mode;
    } catch (err) {
      // Keep the old mode and give the caller a readable reason.
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(`Claude rejected the "${mode}" permission mode: ${raw}`);
    }
  }

  async setModel(model: string): Promise<void> {
    await this.#query?.setModel(model);
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    try {
      await this.#query?.applyFlagSettings({ effortLevel: effort });
      this.#effort = effort;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(`Claude rejected the "${effort}" effort level: ${raw}`);
    }
  }

  snapshot(): AdapterSnapshot {
    const s = this.#mapper.state;
    return {
      status: "running",
      providerRef: s.providerRef,
      model: s.model,
      effort: this.#effort,
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
    this.#rejectPending("the session was closed before this was answered");
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
  /** `providers.claude.prompt_cache_ttl` — "5m" | "1h" | "" (CLI decides). */
  promptCacheTtl?: string;
}

export class ClaudeProvider implements AgentProvider {
  readonly id = "claude";
  readonly capabilities = CAPS;

  readonly #cliPathOption: string;
  readonly #promptCacheTtl: string;
  #cli: string | undefined;
  #cliResolved = false;

  constructor(opts: ClaudeProviderOptions = {}) {
    this.#cliPathOption = opts.cliPath ?? "";
    this.#promptCacheTtl = opts.promptCacheTtl ?? "";
  }

  #resolveCli(): string | undefined {
    if (!this.#cliResolved) {
      this.#cli = resolveClaudeCli(this.#cliPathOption);
      this.#cliResolved = true;
    }
    return this.#cli;
  }

  #extra(cli: string | undefined): { cli?: string; promptCacheTtl?: string } {
    return {
      ...(cli ? { cli } : {}),
      ...(this.#promptCacheTtl ? { promptCacheTtl: this.#promptCacheTtl } : {}),
    };
  }

  async createSession(opts: CreateSessionOptions): Promise<AgentSession> {
    const cli = this.#resolveCli();
    const s = new ClaudeSession(opts);
    s.start(opts, this.#extra(cli));
    return s;
  }

  async resumeSession(ref: SessionRef): Promise<AgentSession> {
    const cli = this.#resolveCli();
    const opts: CreateSessionOptions = {
      sessionId: ref.sessionId,
      cwd: ref.cwd,
      prompt: "", // resume replays in-flight state; the next real turn comes via send()
      mode: ref.mode ?? "default",
      mcpServers: ref.mcpServers ?? [],
      loomServer: true,
      ...(ref.model ? { model: ref.model } : {}),
      ...(ref.effort ? { effort: ref.effort } : {}),
    };
    const s = new ClaudeSession(opts);
    s.start(opts, { resume: ref.providerRef, ...this.#extra(cli) });
    return s;
  }

  async listPersistedSessions(): Promise<SessionRef[]> {
    // Wired up with the worktree manager (M3), which owns the per-session cwd.
    return [];
  }

  /**
   * The model catalog the CLI reports — no hard-coded list. A throwaway
   * `query()` whose prompt never yields: the `initialize` handshake carries
   * `models`, so we read it and close without running a turn.
   */
  async listModels(): Promise<DiscoveredModel[]> {
    const cli = this.#resolveCli();
    const q = query({
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {})(),
      options: cli ? { pathToClaudeCodeExecutable: cli } : {},
    });
    try {
      const init = await q.initializationResult();
      const seen = new Set<string>();
      const out: DiscoveredModel[] = [];
      for (const m of init.models) {
        if (!m.value || m.value === "default") continue; // "default" = whatever the account picks; Loom has its own
        // Some rows tag a context variant in the value / name, e.g. "…[1m]".
        const ctx = parseContextTag(`${m.value} ${m.displayName ?? ""}`);
        const id = (m.resolvedModel || m.value).replace(/\s*\[[^\]]*\]\s*$/, "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          ...(m.displayName ? { label: m.displayName } : {}),
          ...(ctx ? { context: ctx } : {}),
          ...(m.supportsEffort ? { supportsEffort: true } : {}),
          ...(m.supportedEffortLevels && m.supportedEffortLevels.length > 0
            ? { effortLevels: m.supportedEffortLevels }
            : {}),
        });
      }
      return out;
    } finally {
      await Promise.resolve(q.close?.()).catch(() => {});
    }
  }
}
