/**
 * Loom agents, daemon side (docs/loom-agents.md, stage 1): the `loom-agents`
 * tools a session calls to start and manage its children, the settings a
 * session gets from its profile and its place in the supervision tree, and
 * the notifications a child's turn sends up to its supervisor.
 *
 * Children are ordinary sessions with a `supervisorId`: the daemon starts,
 * messages (through the A9 queue), interrupts and archives them by the same
 * paths a client does. Everything that reaches into the daemon goes through
 * {@link AgentHost}, so this module holds the rules and the wording, not the
 * machinery.
 */
import type { AgentCallEvent, HarnessEvent } from "@loom/core/events";
import type { AgentCallResult, McpServerHandle, SessionMode } from "@loom/core/types";
import type { HoldRespect, QueueDelivery, QueueHoldCause } from "@loom/core/message-queue";
import type { SessionState, StopCause } from "@loom/core/session-state";
import type { GitFacts, SessionSnapshot, TranscriptEntry } from "@loom/core/wire";
import type { Logger } from "@loom/core/logger";
import {
  LOOM_AGENTS_SERVER,
  SELF_PROFILE,
  supervisionDepth,
  type AgentProfileInfo,
} from "@loom/core/agents";
import { isAgentTool, type AgentToolName } from "@loom/runtime/agent-tools";
import type { AgentProfileConfig, LoomConfig } from "../config/config.ts";

/** A notification carries the child's final message up to this many bytes. */
export const NOTIFY_MESSAGE_BYTES = 2048;
/** `agent_read` returns at most this much text per call. */
export const READ_BUDGET_BYTES = 16 * 1024;
/** `agent_read` without a cursor: the final message, up to this much. */
const FINAL_BUDGET_BYTES = 32 * 1024;
const WAIT_DEFAULT_S = 60;
const WAIT_MAX_S = 600;
/** `agent_read` with a cursor fetches at most this many entries per call. */
const READ_FETCH = 1000;

const short = (id: string): string => id.slice(0, 8);

/** A branch against its base, and whether work is left uncommitted. */
const gitSummary = (git: GitFacts): string =>
  [
    `${git.aheadOfBase} commit${git.aheadOfBase === 1 ? "" : "s"} ahead of its base`,
    ...(git.behindBase > 0 ? [`${git.behindBase} behind`] : []),
    ...(git.dirty ? ["uncommitted changes"] : []),
  ].join(", ");

/** Why a child's queue is held, as its supervisor is told. */
const holdCause = (hold: QueueHoldCause): string => {
  if (hold.by === "user") return "the user stopped it";
  if (hold.by === "supervisor") return "you stopped it";
  switch (hold.reason) {
    case "crash":
      return "it stopped unexpectedly";
    case "restart":
      return "the daemon restarted while a message was being handed over";
    case "rejected":
      return "a message may not have reached it";
    case "interrupt":
      return "it was stopped";
  }
};

/** States a child's turn has stopped in: done working until someone acts. */
const SETTLED: ReadonlySet<SessionState["kind"]> = new Set([
  "idle",
  "awaiting_input",
  "error",
  "interrupted",
  "done",
]);

/** Cut `text` to `bytes` of UTF-8 on a character boundary; whether it was cut. */
export const cutBytes = (text: string, bytes: number): { text: string; cut: boolean } => {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= bytes) return { text, cut: false };
  // `fatal: false` drops a split trailing character rather than throwing.
  const head = new TextDecoder("utf-8", { fatal: false }).decode(encoded.slice(0, bytes));
  return { text: head.replace(/�$/, ""), cut: true };
};

// ---------------------------------------------------------------------------
// what a session gets
// ---------------------------------------------------------------------------

/** The agent fields of `CreateSessionOptions` / `SessionRef`, with the MCP
 *  servers its profile keeps. */
export interface AgentSessionPlan {
  mcpServers: McpServerHandle[];
  agentTools?: true;
  agentPrompt?: string;
  skills?: string[];
  allowTools?: string[];
  denyTools?: string[];
}

/**
 * What `row` runs with: `loom-agents` unless its profile leaves it out or it
 * sits at `agents.max_depth`; the profile's MCP servers, skills, tool lists
 * and prompt; and, for a child, a note on who supervises it. Recomputed for
 * every start and resume, so a config change reaches a resumed session. A
 * profile since removed from the config contributes nothing.
 */
export const agentSessionPlan = (
  row: Pick<SessionSnapshot, "id" | "supervisorId" | "agentProfile">,
  ctx: {
    agents: LoomConfig["agents"];
    lookup: (id: string) => SessionSnapshot | undefined;
    /** See {@link AgentHost.settledTitle}. */
    settledTitle: (id: string) => string | null;
    handles: McpServerHandle[];
  },
): AgentSessionPlan => {
  const profile =
    row.agentProfile && row.agentProfile !== SELF_PROFILE
      ? ctx.agents.profiles[row.agentProfile]
      : undefined;
  const depth = supervisionDepth(row.id, (id) => (id === row.id ? row : ctx.lookup(id)));
  const keeps = (name: string) => profile?.mcp === undefined || profile.mcp.includes(name);
  const supervisor = row.supervisorId ? ctx.lookup(row.supervisorId) : undefined;
  const prompt = [
    supervisor ? childNote(supervisor.id, ctx.settledTitle(supervisor.id)) : "",
    profile?.prompt ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    mcpServers: ctx.handles.filter((h) => keeps(h.name)),
    ...(depth < ctx.agents.maxDepth && keeps(LOOM_AGENTS_SERVER) ? { agentTools: true } : {}),
    ...(prompt ? { agentPrompt: prompt } : {}),
    ...(profile?.skills ? { skills: profile.skills } : {}),
    ...(profile?.tools?.allow ? { allowTools: profile.tools.allow } : {}),
    ...(profile?.tools?.deny ? { denyTools: profile.tools.deny } : {}),
  };
};

const childNote = (supervisorId: string, title: string | null): string =>
  [
    `You are a Loom sub-agent: session ${short(supervisorId)}${title ? ` ("${title}")` : ""} started you with a task and supervises you.`,
    "Your final message at the end of each turn is sent to it, so end every turn with a clear report: what you did, how you verified it, and what is left or failed.",
    "Commit your work before you report: your supervisor sees your branch, not your uncommitted files.",
    "Questions and permission requests go to the user, as usual.",
  ].join(" ");

/** The configured profiles as clients list them. */
export const profileInfos = (agents: LoomConfig["agents"]): AgentProfileInfo[] =>
  Object.entries(agents.profiles).map(([name, p]) => ({
    name,
    description: p.description,
    ...(p.provider ? { provider: p.provider } : {}),
    ...(p.model ? { model: p.model } : {}),
    ...(p.effort ? { effort: p.effort } : {}),
    ...(p.mode ? { mode: p.mode } : {}),
  }));

// ---------------------------------------------------------------------------
// transcripts
// ---------------------------------------------------------------------------

/**
 * The final message of the latest turn: the root assistant text after its
 * last tool activity or user message, else the turn's `result` summary.
 * `events` oldest first, as a page holds them.
 */
export const finalMessage = (events: readonly HarnessEvent[]): string => {
  const parts: string[] = [];
  let summary = "";
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.agentId !== undefined) continue;
    if (ev.type === "assistant_text") parts.unshift(ev.text);
    else if (ev.type === "result" && ev.kind === "ok" && !summary && parts.length === 0)
      summary = ev.summary ?? "";
    else if (ev.type === "tool_call" || ev.type === "tool_result" || ev.type === "user_message")
      break;
  }
  // Every adapter emits whole text blocks, not deltas.
  return (
    parts
      .map((p) => p.trim())
      .filter(Boolean)
      .join("\n\n") || summary
  ).trim();
};

const oneLine = (v: unknown, max: number): string => {
  const s = (typeof v === "string" ? v : JSON.stringify(v ?? "")).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** One transcript entry as `agent_read` shows it; null for what it skips. */
const excerptLine = (ev: HarnessEvent): string | null => {
  const sub = ev.agentId !== undefined ? "  (sub) " : "";
  switch (ev.type) {
    case "user_message":
      return `› ${ev.author?.startsWith("supervisor:") ? "supervisor" : "user"}: ${ev.text}`;
    case "assistant_text":
      return `${sub}‹ ${ev.text}`;
    case "tool_call":
      return `${sub}⚙ ${ev.name} ${oneLine(ev.input, 200)}`;
    case "tool_result":
      return `${sub}  → ${ev.ok ? "ok" : "failed"}: ${oneLine(ev.output, 200)}`;
    case "question":
      return `? asked the user: ${ev.question}`;
    case "permission_request":
      return `? needs permission for ${ev.tool}`;
    case "plan_review":
      return "? presented a plan for review";
    case "result":
      return ev.kind === "ok" ? "— turn finished" : `— turn failed: ${ev.error}`;
    case "error":
      return ev.fatal ? `! ${ev.message}` : null;
    default:
      return null;
  }
};

/**
 * Entries after a cursor, oldest first, rendered until `budget` bytes. The
 * cursor returned is the last entry included, so the next read continues
 * exactly there; `more` when the budget stopped it.
 */
export const renderExcerpt = (
  entries: readonly TranscriptEntry[],
  budget = READ_BUDGET_BYTES,
): { text: string; cursor: number | null; more: boolean } => {
  const lines: string[] = [];
  let used = 0;
  let cursor: number | null = null;
  for (const entry of entries) {
    const line = excerptLine(entry.event);
    const bytes = line === null ? 0 : new TextEncoder().encode(line).length + 1;
    if (line !== null && used + bytes > budget) {
      if (lines.length === 0) {
        // One entry larger than the whole budget: show its head, move past it.
        lines.push(cutBytes(line, budget).text + " …");
        cursor = entry.id;
      }
      return { text: lines.join("\n"), cursor, more: true };
    }
    if (line !== null) {
      lines.push(line);
      used += bytes;
    }
    cursor = entry.id;
  }
  return { text: lines.join("\n"), cursor, more: false };
};

// ---------------------------------------------------------------------------
// the daemon's side
// ---------------------------------------------------------------------------

/** A child to start, as `agent_start` resolved it. */
export interface ChildStart {
  prompt: string;
  title: string;
  providerId: string;
  model: string | null;
  effort: string | null;
  mode: SessionMode;
  /** What its worktree branches from. */
  base: string;
  isolation: "vm" | "local";
  supervisorId: string;
  agentProfile: string;
  taskId?: string;
}

/** What {@link AgentSupervision} needs from the daemon. */
export interface AgentHost {
  agents(): LoomConfig["agents"];
  /**
   * A session as clients see it — its row, live overlays and last-known git
   * facts (never a fresh `git` run) — or undefined.
   */
  get(id: string): SessionSnapshot | undefined;
  /** A session's stored status, or undefined when it is gone: cheap, for
   *  checks that run on every status change. */
  status(id: string): SessionState | undefined;
  /** The sessions `supervisorId` supervises, as {@link get} reads them. */
  children(supervisorId: string): SessionSnapshot[];
  /**
   * A session's title once it is a real one (set by hand or generated), else
   * null. Until then a title is the head of the first prompt, which a child
   * shown it as its supervisor's name would read as instructions.
   */
  settledTitle(id: string): string | null;
  /** Is the provider configured and enabled here? */
  providerKnown(id: string): boolean;
  defaultModel(provider: string): string | null;
  defaultEffort(provider: string, model: string | null): string | null;
  /** The repository's current HEAD: its branch, or the commit when detached. */
  headBase(): string | undefined;
  repoRoot: string;
  dirty(path: string): boolean;
  start(child: ChildStart): Promise<SessionSnapshot>;
  /**
   * Put a message in a session's queue, reviving it when it is cold. A hold
   * `respect` says it waits behind stays: the message joins the held entries
   * — a cold session stays cold — and nothing starts until the user sends or
   * releases them. Any other hold it lifts, going first, as the user's send
   * does. Only the user lifts the user's stop, never an agent. `hold` is the
   * hold it found; `waited`, whether it stays.
   */
  enqueue(
    id: string,
    text: string,
    author: string,
    delivery: QueueDelivery,
    respect: Exclude<HoldRespect, "none">,
  ): Promise<{ entryId: string; state: string; hold: QueueHoldCause | null; waited: boolean }>;
  /** Interrupt a child for its supervisor: the turn's end is attributed to
   *  the supervisor (`interrupted` by `supervisor`). */
  interrupt(id: string): Promise<void>;
  /** Archive a child for its supervisor, likewise attributed; refuses
   *  uncommitted changes unless `force`. */
  archive(id: string, force: boolean): Promise<void>;
  /** Transcript entries: after a cursor, oldest first; or the newest `limit`. */
  events(id: string, opts: { after?: number; limit: number }): TranscriptEntry[];
  /** Answer a parked `agent_call`. */
  respond(sessionId: string, callId: string, result: AgentCallResult): Promise<unknown>;
  log: Logger;
}

/** A tool refusal the caller should see as its result, not a daemon fault. */
class Refusal extends Error {}

const refuse = (message: string): never => {
  throw new Refusal(message);
};

const str = (input: Record<string, unknown>, key: string): string | undefined => {
  const v = input[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/** An `agent_wait` in flight: re-checked when a session it waits on changes. */
interface Waiter {
  readonly ids: readonly string[];
  /** Something it waits on changed: settle if the condition now holds. */
  wake(): void;
  /** Its caller's turn ended: stop waiting. */
  cancel(): void;
}

/** States that end a turn: a wait the turn made cannot outlive them. */
const TURN_ENDED: ReadonlySet<SessionState["kind"]> = new Set([
  "idle",
  "error",
  "interrupted",
  "done",
]);

/** The agent tools, the profile rules and the notifications up. */
export class AgentSupervision {
  readonly #host: AgentHost;
  /** `agent_wait` calls in flight, per caller. */
  readonly #waits = new Map<string, Set<Waiter>>();

  constructor(host: AgentHost) {
    this.#host = host;
  }

  /** Run one `agent_call` and answer it. Never throws. */
  async call(callerId: string, call: AgentCallEvent): Promise<void> {
    let result: AgentCallResult;
    try {
      const input =
        call.input && typeof call.input === "object" && !Array.isArray(call.input)
          ? (call.input as Record<string, unknown>)
          : {};
      if (!isAgentTool(call.tool)) refuse(`unknown agent tool: ${call.tool}`);
      result = { ok: true, text: await this.#run(callerId, call.tool as AgentToolName, input) };
    } catch (err) {
      if (!(err instanceof Refusal))
        this.#host.log.warn("agent tool failed", {
          callerId,
          tool: call.tool,
          err: err instanceof Error ? err.message : String(err),
        });
      result = { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
    try {
      await this.#host.respond(callerId, call.id, result);
    } catch (err) {
      this.#host.log.warn("agent tool answer failed", {
        callerId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** End `callerId`'s blocking waits: its turn was interrupted or it stopped. */
  cancel(callerId: string): void {
    const waits = this.#waits.get(callerId);
    this.#waits.delete(callerId);
    for (const wait of waits ?? []) wait.cancel();
  }

  /**
   * Session `id` moved to `state` (every status write, however it came
   * about). A turn end ends `id`'s own waits — a wait cannot outlive the
   * turn that made it, whether that turn finished, failed, crashed or was
   * closed — and any wait on `id` checks again.
   */
  observe(id: string, state: SessionState): void {
    if (TURN_ENDED.has(state.kind)) this.cancel(id);
    this.#wake(id);
  }

  /** Has `id`'s turn stopped? A session gone has. */
  #settled(id: string): boolean {
    const status = this.#host.status(id);
    return !status || SETTLED.has(status.kind);
  }

  /** Something `id` waits on, or is waited on for, may have changed. */
  #wake(id: string): void {
    // A wait that settles removes itself; Map and Set iteration allow that.
    for (const waits of this.#waits.values())
      for (const wait of waits) if (wait.ids.includes(id)) wait.wake();
  }

  #run(caller: string, tool: AgentToolName, input: Record<string, unknown>): Promise<string> {
    switch (tool) {
      case "agents_profiles":
        return Promise.resolve(this.#profiles(caller));
      case "agent_start":
        return this.#start(caller, input);
      case "agent_message":
        return this.#message(caller, input);
      case "agent_status":
        return Promise.resolve(this.#status(caller, input));
      case "agent_read":
        return Promise.resolve(this.#read(caller, input));
      case "agent_interrupt":
        return this.#interrupt(caller, input);
      case "agent_stop":
        return this.#stop(caller, input);
      case "agent_wait":
        return this.#wait(caller, input);
    }
  }

  #session(id: string): SessionSnapshot {
    return this.#host.get(id) ?? refuse(`no such session: ${id}`);
  }

  /** A child `caller` supervises, by full id (or an unambiguous prefix). */
  #child(caller: string, input: Record<string, unknown>): SessionSnapshot {
    const id = str(input, "id") ?? refuse("id is required");
    const exact = this.#host.get(id);
    if (exact?.supervisorId === caller) return exact;
    const match = this.#host.children(caller).filter((s) => s.id.startsWith(id));
    if (match.length === 1) return match[0]!;
    if (match.length > 1)
      refuse(`"${id}" matches more than one of your children; give the full id`);
    return exact
      ? refuse(`${short(id)} is not one of your children; you can act only on agents you started`)
      : refuse(`no such session: ${id}`);
  }

  #profiles(caller: string): string {
    const me = this.#session(caller);
    const agents = this.#host.agents();
    const runs = (p: {
      provider?: string;
      model?: string | null;
      effort?: string | null;
      mode?: string;
    }) =>
      [
        [p.provider, p.model].filter(Boolean).join("/"),
        p.effort ? `effort ${p.effort}` : "",
        p.mode ? `mode ${p.mode}` : "",
      ]
        .filter(Boolean)
        .join(", ");
    const lines = [
      `${SELF_PROFILE} — your own settings (${runs({ provider: me.provider, model: me.model, effort: me.effort, mode: me.mode })}), no extra prompt.`,
      ...Object.entries(agents.profiles).map(([name, p]) => {
        const set = runs(p);
        return `${name} — ${p.description}${set ? ` (${set}; the rest as yours)` : " (runs as you)"}`;
      }),
    ];
    const depth = supervisionDepth(caller, (id) => this.#host.get(id));
    const nested = depth + 1 < agents.maxDepth;
    return [
      ...lines,
      "",
      nested
        ? "Children can start agents of their own unless their profile leaves out loom-agents."
        : `Children cannot start agents of their own (agents.max_depth ${agents.maxDepth}).`,
    ].join("\n");
  }

  /** `name`'s settings for a child of `me`: unset fields follow `me`. */
  #resolve(
    name: string,
    me: SessionSnapshot,
  ): { providerId: string; model: string | null; effort: string | null; mode: SessionMode } {
    const agents = this.#host.agents();
    let profile: AgentProfileConfig | undefined;
    if (name !== SELF_PROFILE) {
      profile = agents.profiles[name];
      if (!profile)
        refuse(
          `no agent profile "${name}"; available: ${[SELF_PROFILE, ...Object.keys(agents.profiles)].join(", ")}`,
        );
    }
    const providerId = profile?.provider ?? me.provider;
    if (!this.#host.providerKnown(providerId))
      refuse(`provider "${providerId}" is not available here`);
    const same = providerId === me.provider;
    const model = profile?.model ?? (same ? me.model : this.#host.defaultModel(providerId));
    const effort =
      profile?.effort ??
      (same && !profile?.model ? me.effort : this.#host.defaultEffort(providerId, model));
    // A child is given work to do: a planning supervisor's children implement.
    const mine: SessionMode = me.mode === "plan" ? "default" : (me.mode as SessionMode);
    return { providerId, model, effort, mode: profile?.mode ?? mine };
  }

  async #start(caller: string, input: Record<string, unknown>): Promise<string> {
    const me = this.#session(caller);
    const agents = this.#host.agents();
    const depth = supervisionDepth(caller, (id) => this.#host.get(id));
    if (depth >= agents.maxDepth)
      refuse(
        `agents.max_depth is ${agents.maxDepth} and this session is at depth ${depth}: it cannot start agents`,
      );
    if (me.checkout === "clone")
      refuse(
        "A session in a private clone cannot start agents yet: clone children arrive in stage 2 of Loom agents (docs/loom-agents.md). Use a worktree or in-place session as the supervisor.",
      );
    const profile = str(input, "profile") ?? refuse("profile is required");
    const task = str(input, "task") ?? refuse("task is required");
    const title = (str(input, "title") ?? refuse("title is required")).slice(0, 200);
    const taskId = str(input, "task_id");
    const settings = this.#resolve(profile, me);
    // In place, the child branches from what is checked out; in a worktree,
    // from the supervisor's own branch.
    const base = me.inPlace
      ? (this.#host.headBase() ?? refuse("the repository has no commit to branch a child from"))
      : (me.branch ?? refuse("this session has no branch to branch a child from"));
    const workdir = me.inPlace ? this.#host.repoRoot : me.worktree;
    const dirty = workdir !== null && this.#host.dirty(workdir);
    const child = await this.#host.start({
      prompt: task,
      title,
      ...settings,
      base,
      isolation: me.isolation ?? "local",
      supervisorId: caller,
      agentProfile: profile,
      ...(taskId ? { taskId } : {}),
    });
    const runs = [child.provider, child.model].filter(Boolean).join("/");
    return [
      `Started agent ${child.id} "${title}" on profile ${profile} (${runs}, mode ${child.mode}).`,
      child.branch
        ? `It works on branch ${child.branch}${child.worktree ? ` in ${child.worktree}` : ""}, from ${child.baseBranch ?? base}.`
        : `It branches from ${child.baseBranch ?? base}.`,
      "You are notified when it finishes a turn, fails or is interrupted (not when it waits on the user): end your turn to wait for it.",
      ...(dirty
        ? [
            `Warning: you have uncommitted changes, and they do not carry over — the child starts from the last commit on ${base}. Commit first if it needs them.`,
          ]
        : []),
    ].join("\n");
  }

  async #message(caller: string, input: Record<string, unknown>): Promise<string> {
    const child = this.#child(caller, input);
    const text = str(input, "text") ?? refuse("text is required");
    const delivery: QueueDelivery =
      input["delivery"] === "end_of_turn" ? "end_of_turn" : "next_boundary";
    if (child.status.kind === "done")
      refuse(`${short(child.id)} is archived; start a new agent instead`);
    // A child the user stopped stays stopped: the message waits behind the
    // user's hold. Any other (the supervisor's own stop, a crash, a restart)
    // it lifts, reviving the child, as the user's send would.
    const title = this.#host.settledTitle(caller);
    const from = `[from your supervisor, session ${short(caller)}${title ? ` "${title}"` : ""}]`;
    const queued = await this.#host.enqueue(
      child.id,
      `${from}\n${text}`,
      `supervisor:${caller}`,
      delivery,
      "user",
    );
    let hold = "";
    if (queued.hold && queued.waited)
      hold = ` Its queue is held (${holdCause(queued.hold)}): the message waits until the user sends or releases.`;
    else if (queued.hold)
      hold = ` Its queue was held (${holdCause(queued.hold)}): the message lifted the hold and goes first.`;
    return `Queued for ${short(child.id)} (${delivery === "end_of_turn" ? "when it finishes" : "at its next tool boundary, or as its next turn"}): entry ${queued.entryId}, ${queued.state}.${hold}`;
  }

  #describe(s: SessionSnapshot): string {
    let state: string = s.status.kind;
    if (s.status.kind === "awaiting_input")
      state = `waiting for input (${s.status.on}) — the user answers it`;
    else if (s.status.kind === "error") state = `failed: ${s.status.message}`;
    else if (s.status.kind === "interrupted") state = "interrupted";
    else if (s.status.kind === "done") state = "archived";
    const diff = s.git ? gitSummary(s.git) : "";
    const final = finalMessage(this.#host.events(s.id, { limit: 200 }).map((e) => e.event));
    const cost =
      s.costSource === "none" || s.costSource === "partial"
        ? "unpriced"
        : `$${s.costUsd.toFixed(2)}`;
    return [
      `${s.id} "${s.title ?? ""}" · profile ${s.agentProfile ?? SELF_PROFILE}${s.taskId ? ` · task ${s.taskId}` : ""}`,
      `  state: ${state} · ${s.turns} turn${s.turns === 1 ? "" : "s"} · ${cost}`,
      ...(s.branch ? [`  branch: ${s.branch}${diff ? ` · ${diff}` : ""}`] : []),
      ...(final ? [`  last message: ${oneLine(final, 300)}`] : []),
    ].join("\n");
  }

  #status(caller: string, input: Record<string, unknown>): string {
    if (str(input, "id")) return this.#describe(this.#child(caller, input));
    const mine = this.#host.children(caller);
    if (mine.length === 0) return "You have no agents. Start one with agent_start.";
    return mine.map((s) => this.#describe(s)).join("\n\n");
  }

  #read(caller: string, input: Record<string, unknown>): string {
    const child = this.#child(caller, input);
    const since = input["since"];
    if (typeof since !== "number") {
      const page = this.#host.events(child.id, { limit: 500 });
      const cursor = page.at(-1)?.id ?? 0;
      const final = finalMessage(page.map((e) => e.event));
      const { text, cut } = cutBytes(final, FINAL_BUDGET_BYTES);
      return [
        final
          ? `Final message of ${short(child.id)}:\n${text}${cut ? "\n[… cut]" : ""}`
          : `${short(child.id)} has no final message yet.`,
        "",
        `cursor: ${cursor} (agent_read with since: ${cursor} continues from here)`,
      ].join("\n");
    }
    const entries = this.#host.events(child.id, { after: since, limit: READ_FETCH });
    const excerpt = renderExcerpt(entries);
    const cursor = excerpt.cursor ?? since;
    // A full page may have more behind it, even when nothing on it showed.
    const more = excerpt.more || entries.length >= READ_FETCH;
    return [
      excerpt.text || "(nothing new)",
      "",
      more
        ? `cursor: ${cursor} — more follows; agent_read with since: ${cursor}`
        : `cursor: ${cursor} — up to date`,
    ].join("\n");
  }

  async #interrupt(caller: string, input: Record<string, unknown>): Promise<string> {
    const child = this.#child(caller, input);
    if (
      !["running", "starting", "working_background", "awaiting_input"].includes(child.status.kind)
    )
      return `${short(child.id)} is not running (${child.status.kind}).`;
    await this.#host.interrupt(child.id);
    return `Interrupted ${short(child.id)}. Message it to go on.`;
  }

  async #stop(caller: string, input: Record<string, unknown>): Promise<string> {
    const child = this.#child(caller, input);
    if (child.status.kind === "done") return `${short(child.id)} is already archived.`;
    const discard = input["discard"] === true;
    if (
      !discard &&
      child.worktree &&
      child.checkout !== "clone" &&
      this.#host.dirty(child.worktree)
    )
      refuse(
        `${short(child.id)} has uncommitted changes: message it to commit them, or call agent_stop with discard: true to lose them.`,
      );
    await this.#host.archive(child.id, discard);
    return `Stopped and archived ${short(child.id)}; its branch${child.branch ? ` ${child.branch}` : ""} and transcript are kept.`;
  }

  async #wait(caller: string, input: Record<string, unknown>): Promise<string> {
    const raw = Array.isArray(input["ids"]) ? input["ids"] : refuse("ids is required");
    const ids = raw.map((id) => this.#child(caller, { id }).id);
    if (ids.length === 0) refuse("ids is required");
    const all = input["until"] !== "any";
    const timeout = Math.min(
      WAIT_MAX_S,
      typeof input["timeout"] === "number" && input["timeout"] > 0
        ? input["timeout"]
        : WAIT_DEFAULT_S,
    );
    const done = () => {
      const settled = ids.map((id) => this.#settled(id));
      return all ? settled.every(Boolean) : settled.some(Boolean);
    };
    type Outcome = "settled" | "timeout" | "cancelled";
    let outcome: Outcome = "settled";
    if (!done()) {
      const waits = this.#waits.get(caller) ?? new Set<Waiter>();
      this.#waits.set(caller, waits);
      outcome = await new Promise<Outcome>((resolve) => {
        const finish = (how: Outcome) => {
          clearTimeout(timer);
          waits.delete(waiter);
          if (waits.size === 0 && this.#waits.get(caller) === waits) this.#waits.delete(caller);
          resolve(how);
        };
        const waiter: Waiter = {
          ids,
          wake: () => {
            if (done()) finish("settled");
          },
          cancel: () => finish("cancelled"),
        };
        const timer = setTimeout(() => finish("timeout"), timeout * 1000);
        waits.add(waiter);
      });
    }
    const heads: Record<Outcome, string> = {
      settled: `${all ? "All" : "One"} settled.`,
      cancelled: "Stopped waiting: your turn ended or was interrupted.",
      timeout: `Timed out after ${timeout}s.`,
    };
    const head = heads[outcome];
    const lines = ids.map((id) => `${short(id)}: ${this.#host.status(id)?.kind ?? "gone"}`);
    return [head, ...lines].join("\n");
  }

  /**
   * Tell `child`'s supervisor that its turn stopped in `state`: a finished
   * turn, a failure or an interrupt. Queued as an end-of-turn entry labelled
   * as the child's, so a busy supervisor is not interrupted and an idle one is
   * woken — unless its queue is held, where it waits behind the hold like
   * everything else; never streamed output. A supervisor that is archived or gone is not
   * told. A wait for input is not reported: permissions, and for now a
   * child's questions, go to the user, so the supervisor could not act on it
   * (the fleet shows the child waiting).
   *
   * Nor is a turn end the supervisor caused itself (`agent_interrupt`,
   * `agent_stop`): its tool call already answers it. Who caused it travels
   * with the state — `interrupted` by `supervisor`, or `cause` for an error
   * the stop ended in — however late it lands.
   *
   * And `state` must still be the child's: one that has moved on since is
   * reported when the turn it moved on to ends.
   *
   * A child gets no commit or rebase nudges, so its turn end is its own: the
   * notification says what its workspace holds (`child.git`, read fresh at
   * the turn end), and the supervisor decides whether to ask for a commit.
   */
  async notify(child: SessionSnapshot, state: SessionState, cause?: StopCause): Promise<void> {
    if (!child.supervisorId) return;
    let event: string;
    switch (state.kind) {
      case "idle":
        event = "finished a turn";
        break;
      case "error":
        event = `failed: ${state.message}`;
        break;
      case "interrupted":
        event = `was interrupted (${state.by})`;
        break;
      default:
        return;
    }
    if (this.#host.status(child.id)?.kind !== state.kind) return;
    if (cause === "supervisor" || (state.kind === "interrupted" && state.by === "supervisor"))
      return;
    const supervisor = this.#host.status(child.supervisorId);
    if (!supervisor || supervisor.kind === "done") return;
    const final = finalMessage(this.#host.events(child.id, { limit: 200 }).map((e) => e.event));
    const { text, cut } = cutBytes(final, NOTIFY_MESSAGE_BYTES);
    const git = child.git;
    const workspace = git
      ? `Its workspace: ${gitSummary(git)}${git.dirty ? "" : ", nothing uncommitted"}.`
      : null;
    const body = [
      `[from your agent ${short(child.id)} "${child.title ?? ""}" (profile ${child.agentProfile ?? SELF_PROFILE})] It ${event}.`,
      ...(workspace ? [workspace] : []),
      ...(final
        ? [
            "",
            "Final message:",
            text,
            ...(cut
              ? [`[… cut at 2 KB; agent_read with id ${child.id} for the whole message]`]
              : []),
          ]
        : []),
    ].join("\n");
    try {
      // Behind any hold: a supervisor the user stopped stays stopped, and a
      // crashed one is not revived by a report.
      await this.#host.enqueue(child.supervisorId, body, `agent:${child.id}`, "end_of_turn", "any");
    } catch (err) {
      this.#host.log.warn("agent notification failed", {
        child: child.id,
        supervisor: child.supervisorId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
