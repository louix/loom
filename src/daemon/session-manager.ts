/**
 * Owns every live adapter session: one pump task per session drains the
 * adapter's normalized `HarnessEvent` stream, forwards each frame to the daemon,
 * derives status (design spec §4) and rolls usage up. Turn control — send,
 * interrupt, permission responses, mode / model — funnels through here so it is
 * serialized per session and the daemon stays thin.
 */
import type { HarnessEvent, SessionStatus } from "../protocol/events.ts";
import type { Logger } from "../util/logger.ts";
import type { UsageDelta } from "../store/sessions.ts";
import type {
  AdapterSnapshot,
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  PermissionDecision,
  PlanDecision,
  SessionMode,
  SessionRef,
} from "../provider/types.ts";
import { deriveStatus } from "./status-machine.ts";

export interface ManagerHooks {
  /** Forward a normalized event to the push stream + persistence. */
  emitEvent(ev: HarnessEvent): void;
  /** A derived status transition. */
  onStatus(sessionId: string, status: SessionStatus, reason: string | null): void;
  /** A usage delta to accumulate. */
  onUsage(sessionId: string, delta: UsageDelta): void;
  /** A turn ended (clean or not). Fires after the usage rollup for that turn. */
  onResult(sessionId: string, ok: boolean): void;
  /** The session's set of sub-agents changed (one started or stopped). */
  onSubagents(sessionId: string): void;
  /** The provider's persisted id became known. */
  onProviderRef(sessionId: string, providerRef: string): void;
  log: Logger;
}

export interface RespondResult {
  ok: boolean;
  alreadyResolved: boolean;
}

interface Running {
  provider: string;
  session: AgentSession;
  status: SessionStatus;
  ordinal: number;
  pendingPerms: Set<string>;
  pendingQuestions: Set<string>;
  pendingPlans: Set<string>;
  subagents: Map<string, { name: string; startedAt: number; active: boolean }>;
  interrupting: boolean;
  ended: boolean;
  refReported: boolean;
  pump: Promise<void>;
}

const LIVE: readonly SessionStatus[] = ["starting", "running", "awaiting_input"];

export class SessionManager {
  readonly #hooks: ManagerHooks;
  readonly #running = new Map<string, Running>();

  constructor(hooks: ManagerHooks) {
    this.#hooks = hooks;
  }

  get count(): number {
    return this.#running.size;
  }

  has(id: string): boolean {
    return this.#running.has(id);
  }

  ids(): string[] {
    return [...this.#running.keys()];
  }

  snapshot(id: string): AdapterSnapshot | null {
    return this.#running.get(id)?.session.snapshot() ?? null;
  }

  // --- lifecycle --------------------------------------------------------

  async create(provider: AgentProvider, opts: CreateSessionOptions): Promise<void> {
    const session = await provider.createSession(opts);
    this.#attach(provider.id, opts.sessionId, session);
  }

  async resume(provider: AgentProvider, ref: SessionRef): Promise<void> {
    const session = await provider.resumeSession(ref);
    this.#attach(provider.id, ref.sessionId, session);
  }

  #attach(providerId: string, id: string, session: AgentSession): void {
    const run: Running = {
      provider: providerId,
      session,
      status: "starting",
      ordinal: 0,
      pendingPerms: new Set(),
      pendingQuestions: new Set(),
      pendingPlans: new Set(),
      subagents: new Map(),
      interrupting: false,
      ended: false,
      refReported: false,
      pump: Promise.resolve(),
    };
    this.#running.set(id, run);
    run.pump = this.#drain(id, run);
  }

  async #drain(id: string, run: Running): Promise<void> {
    try {
      for await (const raw of run.session.events()) {
        const ev = { ...raw, ordinal: run.ordinal++ } as HarnessEvent;
        if (ev.type === "error" && ev.fatal) {
          this.#hooks.log.warn("session error", { id, message: ev.message });
        }
        this.#hooks.emitEvent(ev);
        this.#trackPerms(run, ev);
        this.#trackQuestions(run, ev);
        this.#trackPlans(run, ev);
        this.#trackSubagents(id, run, ev);
        this.#trackUsage(id, ev);
        if (ev.type === "result") this.#hooks.onResult(id, ev.ok);
        this.#trackRef(id, run);
        this.#applyStatus(id, run, ev);
      }
      // The adapter stream ended. A clean run leaves status at idle/done/error;
      // anything still live stopped without a clean finish → interrupted.
      run.ended = true;
      if (LIVE.includes(run.status)) {
        this.#set(id, run, "interrupted", "stream_ended");
      }
    } catch (err) {
      run.ended = true;
      const message = err instanceof Error ? err.message : String(err);
      this.#hooks.log.warn("session pump failed", { id, err: message });
      this.#hooks.emitEvent({ type: "error", sessionId: id, ts: Date.now(), message, fatal: true });
      this.#set(id, run, "error", message.slice(0, 120));
    }
  }

  #trackRef(id: string, run: Running): void {
    if (run.refReported) return;
    const ref = run.session.providerRef;
    if (ref) {
      run.refReported = true;
      this.#hooks.onProviderRef(id, ref);
    }
  }

  #trackPerms(run: Running, ev: HarnessEvent): void {
    if (ev.type === "permission_request") {
      run.pendingPerms.add(ev.id);
    } else if (ev.type === "tool_result") {
      // Not `tool_call`: the aisdk adapter emits the tool_call *before* the
      // permission_request (the gate runs inside the tool's executor), so only
      // the result reliably marks the request done. Claude emits them the other
      // way round, and clearing on the result works there too.
      run.pendingPerms.delete(ev.id);
    }
  }

  #trackQuestions(run: Running, ev: HarnessEvent): void {
    if (ev.type === "question") {
      run.pendingQuestions.add(ev.id);
    } else if (ev.type === "answer") {
      run.pendingQuestions.delete(ev.id);
    }
  }

  #trackPlans(run: Running, ev: HarnessEvent): void {
    if (ev.type === "plan_review") run.pendingPlans.add(ev.id);
  }

  #trackSubagents(id: string, run: Running, ev: HarnessEvent): void {
    if (ev.type === "subagent_started") {
      run.subagents.set(ev.subagentId, { name: ev.name, startedAt: ev.ts, active: true });
      this.#hooks.onSubagents(id);
    } else if (ev.type === "subagent_stopped") {
      const cur = run.subagents.get(ev.subagentId);
      if (cur) {
        run.subagents.set(ev.subagentId, { ...cur, active: false });
        this.#hooks.onSubagents(id);
      }
    }
  }

  /** Sub-agents this session has spawned, oldest first. */
  subagentsOf(id: string): Array<{ id: string; name: string; active: boolean }> {
    const run = this.#running.get(id);
    if (!run) return [];
    return [...run.subagents.entries()]
      .sort((a, b) => a[1].startedAt - b[1].startedAt)
      .map(([subId, v]) => ({ id: subId, name: v.name, active: v.active }));
  }

  #trackUsage(id: string, ev: HarnessEvent): void {
    if (ev.type === "usage") {
      this.#hooks.onUsage(id, {
        input: ev.tokens.input,
        output: ev.tokens.output,
        cacheRead: ev.tokens.cacheRead,
        cacheWrite: ev.tokens.cacheWrite,
        costUsd: ev.costDeltaUsd ?? 0,
        contextUsed: ev.contextUsed,
        contextLimit: ev.contextLimit,
        lastTurnAt: ev.ts,
        lastCacheRead: ev.tokens.cacheRead,
        lastCacheWrite: ev.tokens.cacheWrite,
      });
    } else if (ev.type === "result") {
      this.#hooks.onUsage(id, { turns: 1 });
    }
  }

  #applyStatus(id: string, run: Running, ev: HarnessEvent): void {
    // A user interrupt is sticky — don't let a trailing event undo it, unless
    // it's a fatal error we should surface.
    if (run.interrupting && !(ev.type === "error" && ev.fatal)) return;
    const d = deriveStatus(run.status, ev);
    if (!d) return;
    this.#set(id, run, d.status, d.reason);
  }

  #set(id: string, run: Running, status: SessionStatus, reason: string | null): void {
    if (run.status === status) {
      // still notify on an awaiting_input reason change (permission → question)
      if (status !== "awaiting_input") return;
    }
    run.status = status;
    this.#hooks.onStatus(id, status, reason);
  }

  // --- turn control ----------------------------------------------------

  async send(id: string, text: string): Promise<void> {
    const run = this.#require(id);
    if (run.ended) throw new Error("session has ended");
    await run.session.send(text);
    run.interrupting = false;
    this.#set(id, run, "running", null);
  }

  async compact(id: string, instructions?: string): Promise<void> {
    const run = this.#require(id);
    if (run.ended) throw new Error("session has ended");
    await run.session.compact(instructions);
    // Status is left to the event stream: `/compact` runs a turn that ends with
    // its own `result`, and a session compacted while idle stays idle.
  }

  async interrupt(id: string): Promise<void> {
    const run = this.#require(id);
    run.interrupting = true;
    await run.session.interrupt();
    this.#set(id, run, "interrupted", "user");
  }

  /** Stop a session because it breached a hard budget. */
  async haltForBudget(id: string): Promise<void> {
    const run = this.#running.get(id);
    if (!run || run.ended) return;
    run.interrupting = true;
    await run.session.interrupt().catch(() => {});
    this.#set(id, run, "interrupted", "budget");
  }

  async respondToPermission(
    id: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<RespondResult> {
    const run = this.#require(id);
    if (!run.pendingPerms.has(requestId)) return { ok: false, alreadyResolved: true };
    run.pendingPerms.delete(requestId);
    await run.session.respondToPermission(requestId, decision);
    // Optimistic: the approved tool call will confirm `running` on its own.
    this.#set(id, run, "running", null);
    return { ok: true, alreadyResolved: false };
  }

  async answerQuestion(id: string, questionId: string, text: string): Promise<RespondResult> {
    const run = this.#require(id);
    if (!run.pendingQuestions.has(questionId)) return { ok: false, alreadyResolved: true };
    run.pendingQuestions.delete(questionId);
    await run.session.answerQuestion(questionId, text);
    // The `answer` event the adapter emits will also carry status back to
    // running; set it now so a client sees the change without waiting.
    this.#set(id, run, "running", null);
    return { ok: true, alreadyResolved: false };
  }

  async respondToPlan(
    id: string,
    requestId: string,
    decision: PlanDecision,
  ): Promise<RespondResult> {
    const run = this.#require(id);
    if (!run.pendingPlans.has(requestId)) return { ok: false, alreadyResolved: true };
    run.pendingPlans.delete(requestId);
    await run.session.respondToPlan(requestId, decision);
    this.#set(id, run, "running", null);
    return { ok: true, alreadyResolved: false };
  }

  async setMode(id: string, mode: SessionMode): Promise<void> {
    await this.#require(id).session.setMode(mode);
  }

  async setModel(id: string, model: string): Promise<void> {
    await this.#require(id).session.setModel(model);
  }

  /** Undo: truncate the live session's transcript to its first `keep` messages. */
  async rewind(id: string, keep: number): Promise<void> {
    const run = this.#require(id);
    if (run.status === "running" || run.status === "starting") {
      throw new Error("interrupt the session before rewinding it");
    }
    await run.session.rewind(keep);
    this.#set(id, run, "idle", "rewind");
  }

  // --- teardown ------------------------------------------------------

  async shutdown(): Promise<void> {
    const runs = [...this.#running.values()];
    this.#running.clear();
    await Promise.all(
      runs.map(async (run) => {
        try {
          await run.session.close();
        } catch {
          // best effort
        }
        await run.pump.catch(() => {});
      }),
    );
  }

  #require(id: string): Running {
    const run = this.#running.get(id);
    if (!run) throw new Error(`session not running: ${id}`);
    return run;
  }
}
