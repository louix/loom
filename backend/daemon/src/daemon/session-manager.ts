/**
 * Owns every live adapter session: one pump task per session drains the
 * adapter's normalized `HarnessEvent` stream, forwards each frame to the daemon,
 * derives status (design spec §4) and rolls usage up. Turn control funnels
 * through here so the daemon stays thin. The three ops that restructure the
 * transcript / turn ownership — `send`, `compact`, `rewind` — are serialized
 * per session through `#enqueue`; `interrupt` / `close` deliberately preempt
 * that chain rather than queue behind it.
 */
import type { AwaitReason, BackgroundTaskInfo, HarnessEvent } from "@loom/core/events";
import {
  isLiveState,
  sameSessionState,
  type SessionState,
  stateError,
  stateIdle,
  stateInterrupted,
  stateRunning,
  stateStarting,
} from "@loom/core/session-state";
import type { Logger } from "@loom/core/logger";
import type { UsageDelta } from "../store/sessions.ts";
import type {
  AdapterSnapshot,
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  EffortLevel,
  PermissionDecision,
  PlanDecision,
  SessionMode,
  SessionRef,
} from "@loom/core/types";
import { deriveStatus } from "./status-machine.ts";

export interface ManagerHooks {
  /** Forward a normalized event to the push stream + persistence. */
  emitEvent(ev: HarnessEvent): void;
  /** A turn-state transition, with an optional audit breadcrumb for it. */
  onStatus(sessionId: string, state: SessionState, note?: string): void;
  /** A usage delta to accumulate. */
  onUsage(sessionId: string, delta: UsageDelta): void;
  /** A turn ended (clean or not). Fires after the usage rollup for that turn. */
  onResult(sessionId: string, ok: boolean): void;
  /** The session's set of sub-agents changed (one started or stopped). */
  onSubagents(sessionId: string): void;
  /** The session's set of live background tasks changed (REPLACE semantics). */
  onBackgroundTasks(sessionId: string): void;
  /** The provider's persisted id became known. */
  onProviderRef(sessionId: string, providerRef: string): void;
  /** The adapter's own mode changed outside of an explicit `session.setMode` call. */
  onMode(sessionId: string, mode: SessionMode): void;
  log: Logger;
}

export interface RespondResult {
  ok: boolean;
  alreadyResolved: boolean;
}

/** One account-plan usage window, e.g. Claude's `five_hour` / `seven_day`. */
export interface RateLimitWindow {
  status: "allowed" | "allowed_warning" | "rejected";
  utilization?: number;
  resetsAt?: number;
}

interface Running {
  provider: string;
  session: AgentSession;
  /** The one source of truth for turn state — `deriveStatus` in, `onStatus` out. */
  state: SessionState;
  ordinal: number;
  /** Outstanding blocking requests: request id → what it blocks on. `awaiting_input` iff non-empty. */
  pending: Map<string, AwaitReason>;
  subagents: Map<string, { name: string; startedAt: number; active: boolean }>;
  /** Live, non-ambient background tasks — last `background_tasks` event's set. */
  backgroundTasks: BackgroundTaskInfo[];
  /** Latest reading per window (`rate_limit` events carry one window each — merge, don't overwrite). */
  rateLimits: Map<string, RateLimitWindow>;
  ended: boolean;
  refReported: boolean;
  pump: Promise<void>;
  /** Per-session op chain — `send` / `compact` / `rewind` run one at a time through {@link SessionManager.#enqueue}. */
  gate: Promise<unknown>;
  /** Set for the duration of a gated `compact` / `rewind`; a straight `send` is fast-failed while non-null. */
  restructuring: "compact" | "rewind" | null;
  /** Set around a gated `rewind` — `interrupt` no-ops rather than clobber a fork in progress. */
  rewinding: boolean;
}

export class SessionManager {
  readonly #hooks: ManagerHooks;
  readonly #running = new Map<string, Running>();
  /** Session ids with keep-warm on (see {@link setKeepWarm}). Runtime-only. */
  readonly #keepWarm = new Set<string>();
  /** Consecutive keep-warm pings since the last real user message, per session. */
  readonly #warmPings = new Map<string, number>();

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

  /** Non-null while a `compact` / `rewind` holds the session's op gate — the
   *  daemon `session.send` handler fast-fails with `code: "busy"` on it. */
  isRestructuring(id: string): "compact" | "rewind" | null {
    return this.#running.get(id)?.restructuring ?? null;
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
      state: stateStarting,
      // S11: seed from wall-clock, not 0 — a session resumed after a restart
      // would otherwise re-issue ordinals 0,1,2… that collide with the ones
      // already stamped on its persisted events. Still monotonic per session
      // (`ordinal++`), and only ever compared within one session's stream.
      ordinal: Date.now(),
      pending: new Map(),
      subagents: new Map(),
      backgroundTasks: [],
      rateLimits: new Map(),
      ended: false,
      refReported: false,
      pump: Promise.resolve(),
      gate: Promise.resolve(),
      restructuring: null,
      rewinding: false,
    };
    this.#running.set(id, run);
    // `#drain` handles its own stream errors; this catch is for the pathological
    // case where the error path itself throws, so the rejection is never left
    // unhandled (callers only `.catch(() => {})` it from close()/shutdown()).
    run.pump = this.#drain(id, run).catch((err) => {
      this.#hooks.log.error("session pump rejected", {
        id,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async #drain(id: string, run: Running): Promise<void> {
    try {
      for await (const raw of run.session.events()) {
        const ev = { ...raw, ordinal: run.ordinal++ } as HarnessEvent;
        if (ev.type === "error" && ev.fatal) {
          this.#hooks.log.warn("session error", { id, message: ev.message });
        }
        // A transient failure in a downstream hook (a store write hiccup inside
        // onStatus / onUsage) must not end the drain and tear down a live agent
        // session — log it and keep consuming the stream.
        try {
          this.#hooks.emitEvent(ev);
          this.#trackPending(run, ev);
          this.#trackSubagents(id, run, ev);
          this.#trackBackgroundTasks(id, run, ev);
          this.#trackRateLimit(run, ev);
          this.#trackUsage(id, ev);
          if (ev.type === "result") this.#hooks.onResult(id, ev.kind === "ok");
          this.#trackRef(id, run);
          this.#applyStatus(id, run, ev);
        } catch (err) {
          this.#hooks.log.error("event hook threw; continuing drain", {
            id,
            evType: ev.type,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // The adapter stream ended. A clean run leaves state at idle/error;
      // anything still live stopped without a clean finish → interrupted.
      run.ended = true;
      // Whatever was still outstanding can no longer be answered — the adapter
      // session is gone. Drop it so a late respondTo* doesn't forward to a
      // dead session (interrupt() does the same).
      run.pending.clear();
      if (run.backgroundTasks.length > 0) {
        run.backgroundTasks = [];
        this.#hooks.onBackgroundTasks(id);
      }
      if (isLiveState(run.state)) {
        this.#transition(id, run, stateInterrupted("stream_ended"), "stream_ended");
      }
    } catch (err) {
      run.ended = true;
      run.pending.clear();
      const message = err instanceof Error ? err.message : String(err);
      this.#hooks.log.warn("session pump failed", { id, err: message });
      this.#hooks.emitEvent({ type: "error", sessionId: id, ts: Date.now(), message, fatal: true });
      this.#transition(id, run, stateError(message.slice(0, 120)));
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

  /**
   * Maintain the outstanding-request map that *is* the `awaiting_input` state.
   * A `tool_result` clears a permission (not `tool_call`: the aisdk adapter
   * emits the call *before* its gate's `permission_request`, so only the result
   * reliably marks it done; Claude emits them the other way and this works
   * too); an `answer` clears a question. Plans are cleared by `respondToPlan`.
   */
  #trackPending(run: Running, ev: HarnessEvent): void {
    switch (ev.type) {
      case "permission_request":
        run.pending.set(ev.id, ev.tool === "AskUserQuestion" ? "user_question" : "permission");
        break;
      case "question":
        run.pending.set(ev.id, "question");
        break;
      case "plan_review":
        run.pending.set(ev.id, "plan_review");
        break;
      case "answer":
      case "tool_result":
        run.pending.delete(ev.id);
        break;
    }
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

  /**
   * Maintain the live background-task set that gates `working_background`. The
   * `background_tasks` event carries the whole set (adapter already dropped
   * ambient entries and de-duped no-op repeats), so this is a straight replace.
   */
  #trackBackgroundTasks(id: string, run: Running, ev: HarnessEvent): void {
    if (ev.type !== "background_tasks") return;
    run.backgroundTasks = ev.tasks;
    this.#hooks.onBackgroundTasks(id);
  }

  /** Live background tasks this session has spawned (async subagents, shells). */
  backgroundTasksOf(id: string): BackgroundTaskInfo[] {
    return this.#running.get(id)?.backgroundTasks ?? [];
  }

  #trackRateLimit(run: Running, ev: HarnessEvent): void {
    if (ev.type !== "rate_limit") return;
    run.rateLimits.set(ev.window ?? "default", {
      status: ev.status,
      ...(ev.utilization != null ? { utilization: ev.utilization } : {}),
      ...(ev.resetsAt != null ? { resetsAt: ev.resetsAt } : {}),
    });
  }

  /** The provider's account-plan usage windows last reported for this session, keyed by window name. */
  rateLimitsOf(id: string): Record<string, RateLimitWindow> {
    const run = this.#running.get(id);
    if (!run || run.rateLimits.size === 0) return {};
    return Object.fromEntries(run.rateLimits);
  }

  #trackUsage(id: string, ev: HarnessEvent): void {
    if (ev.type === "usage") {
      // A provider that computes cost as tokens×rate can hand us a NaN when the
      // rate is unknown; `?? 0` only catches null/undefined. The store guards
      // its columns too, but keep the in-memory delta finite so `#priceUsage`'s
      // `costUsd > 0` check classifies the cost source correctly.
      const cost = ev.costDeltaUsd ?? 0;
      this.#hooks.onUsage(id, {
        input: ev.tokens.input,
        output: ev.tokens.output,
        cacheRead: ev.tokens.cacheRead,
        cacheWrite: ev.tokens.cacheWrite,
        costUsd: Number.isFinite(cost) ? cost : 0,
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
    // Stickiness of `interrupted` / `error` now lives in `deriveStatus` itself
    // (it returns them unchanged for trailing events), so there is no guard
    // here that could silently swallow a live turn's events. `backgroundTasks`
    // is already updated for this event (see `#trackBackgroundTasks`), so a
    // `result` sees the current count.
    this.#transition(
      id,
      run,
      deriveStatus(run.state, ev, { backgroundTasks: run.backgroundTasks.length }),
    );
  }

  /** Apply a state transition. A `note` is an audit breadcrumb and always fires. */
  #transition(id: string, run: Running, next: SessionState, note?: string): void {
    if (sameSessionState(run.state, next) && note === undefined) return;
    run.state = next;
    this.#hooks.onStatus(id, next, note);
  }

  // --- keep-warm -----------------------------------------------------

  /** Turn keep-warm on/off for a live session. No-op once it's gone. */
  setKeepWarm(id: string, on: boolean): void {
    if (!this.#running.has(id)) return;
    const was = this.#keepWarm.has(id);
    if (on) this.#keepWarm.add(id);
    else this.#keepWarm.delete(id);
    // Reset the unanswered-ping give-up counter only on a real off→on / on→off
    // edge — a redundant re-assert (TUI bounce, reconnect) must not let a
    // session nobody answers get re-primed forever.
    if (was !== on) this.#warmPings.delete(id);
  }

  /** Whether keep-warm is on for `id`. */
  keepWarm(id: string): boolean {
    return this.#keepWarm.has(id);
  }

  /** Live session ids with keep-warm on. */
  keepWarmIds(): string[] {
    return [...this.#keepWarm].filter((id) => {
      const run = this.#running.get(id);
      return run !== undefined && !run.ended;
    });
  }

  /** Keep-warm pings sent since the last real user message (loop guard). */
  warmPingCount(id: string): number {
    return this.#warmPings.get(id) ?? 0;
  }

  // --- turn control ----------------------------------------------------

  /**
   * Run `op` after every op already queued on this session's gate has settled —
   * the per-session serialization for `send` / `compact` / `rewind`. The gate
   * swap MUST stay synchronous (no `await` before it): a re-entrant caller
   * (`#maybeAutoRebase` → `void this.send(...)`) then chains *after* the current
   * op instead of racing it. `interrupt` / `close` deliberately do NOT go
   * through here — they preempt.
   */
  async #enqueue<T>(run: Running, op: () => Promise<T>): Promise<T> {
    const prev = run.gate;
    let release!: () => void;
    run.gate = new Promise<void>((r) => {
      release = r;
    });
    await prev.catch(() => {});
    try {
      return await op();
    } finally {
      release();
    }
  }

  /**
   * Deliver `text` to the session. Returns whether it was an injection into an
   * already-live turn (`injected: true`) vs. the start of a fresh turn — read
   * synchronously from the tracked status before handing off, since the adapter
   * `send()` returns before any turn events land.
   */
  async send(
    id: string,
    text: string,
    opts: { keepWarm?: boolean } = {},
  ): Promise<{ injected: boolean }> {
    const run = this.#require(id);
    if (run.ended) throw new Error("session has ended");
    // A real user message resets the keep-warm loop guard; an automated
    // keep-warm ping bumps it (see {@link SessionManager.warmPingCount}).
    if (opts.keepWarm) this.#warmPings.set(id, (this.#warmPings.get(id) ?? 0) + 1);
    else this.#warmPings.delete(id);
    // Defensive backstop — the real fast-fail is in the daemon `session.send`
    // handler (a distinct `code: "busy"` the TUI re-routes to its own queue).
    // A send that reached the gate mid-restructure would otherwise park for the
    // whole (up-to-15-min) compaction.
    if (run.restructuring) throw new Error(`session is ${run.restructuring}ing`);
    return this.#enqueue(run, async () => {
      const injected = isLiveState(run.state);
      const before = run.state;
      await run.session.send(text);
      // Closed out from under us mid-send — let teardown settle the state.
      if (this.#running.get(id) !== run) return { injected };
      // For an injection, leave the state (and its pending requests) alone; the
      // turn's own events drive it. Otherwise this send is a fresh engagement —
      // it supersedes any prior `interrupted` / `idle` / `error`.
      if (injected) return { injected };
      // S2: only claim `running` if nothing already moved the state while the
      // adapter `send()` was in flight (a fast turn that already blocked / ended)
      // — an unconditional `stateRunning` here would mask a real state.
      if (sameSessionState(run.state, before)) this.#transition(id, run, stateRunning);
      return { injected };
    });
  }

  async compact(id: string, instructions?: string): Promise<void> {
    const run = this.#require(id);
    if (run.ended) throw new Error("session has ended");
    return this.#enqueue(run, async () => {
      run.restructuring = "compact";
      try {
        await run.session.compact(instructions);
        // Status is left to the event stream: `/compact` runs a turn that ends
        // with its own `result`, and a session compacted while idle stays idle.
      } finally {
        run.restructuring = null;
      }
    });
  }

  async interrupt(id: string): Promise<void> {
    const run = this.#require(id);
    // A fork / rewind is mid-flight — there is no turn to stop and clobbering
    // state here would race the rewind's own idle transition.
    if (run.rewinding) return;
    if (run.restructuring === "compact") {
      // A2: cancel an in-flight compaction. No state clobber — a manual compact
      // of an idle session leaves `run.state === "idle"`, so a plain
      // `!isLiveState` guard would wrongly no-op and leave the compaction running.
      try {
        await run.session.interrupt();
      } catch (err) {
        this.#hooks.log.warn("adapter interrupt failed", {
          id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    // S13: an interrupt on a session that already ended cleanly (idle / error /
    // interrupted / done) must not overwrite that settled state.
    if (run.ended || !isLiveState(run.state)) return;
    run.pending.clear();
    // The SDK's interrupt kills the session's background tasks too; clear the
    // overlay now rather than wait for a `background_tasks` event that a
    // torn-down stream might never send.
    if (run.backgroundTasks.length > 0) {
      run.backgroundTasks = [];
      this.#hooks.onBackgroundTasks(id);
    }
    // Reflect the interrupt immediately and unconditionally — the adapter call
    // below can be slow (or, on a wedged turn, throw), and the UI must not be
    // left showing `running` either way. `interrupted` is sticky in
    // `deriveStatus`, so trailing events from the killed turn won't undo it.
    this.#transition(id, run, stateInterrupted("user"), "user");
    try {
      await run.session.interrupt();
    } catch (err) {
      this.#hooks.log.warn("adapter interrupt failed", {
        id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Move a settled `awaiting_input` session back to `running` — unless a user
   *  interrupt landed in between (the interrupt sticks), or other requests from
   *  the same turn are still open (parallel tool calls each raise their own
   *  permission_request; the turn stays blocked until the last is answered). */
  #resumeAfterAnswer(id: string, run: Running): void {
    if (run.state.kind === "interrupted") return;
    if (run.pending.size > 0) return;
    this.#transition(id, run, stateRunning);
  }

  async respondToPermission(
    id: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<RespondResult> {
    const run = this.#require(id);
    if (run.ended) return { ok: false, alreadyResolved: true };
    if (!run.pending.has(requestId)) return { ok: false, alreadyResolved: true };
    run.pending.delete(requestId);
    await run.session.respondToPermission(requestId, decision);
    // Optimistic: the approved tool call will confirm `running` on its own.
    this.#resumeAfterAnswer(id, run);
    return { ok: true, alreadyResolved: false };
  }

  async answerQuestion(id: string, questionId: string, text: string): Promise<RespondResult> {
    const run = this.#require(id);
    if (run.ended) return { ok: false, alreadyResolved: true };
    if (!run.pending.has(questionId)) return { ok: false, alreadyResolved: true };
    run.pending.delete(questionId);
    await run.session.answerQuestion(questionId, text);
    // The `answer` event the adapter emits will also carry status back to
    // running; set it now so a client sees the change without waiting.
    this.#resumeAfterAnswer(id, run);
    return { ok: true, alreadyResolved: false };
  }

  async respondToPlan(
    id: string,
    requestId: string,
    decision: PlanDecision,
  ): Promise<RespondResult> {
    const run = this.#require(id);
    if (run.ended) return { ok: false, alreadyResolved: true };
    if (!run.pending.has(requestId)) return { ok: false, alreadyResolved: true };
    run.pending.delete(requestId);
    await run.session.respondToPlan(requestId, decision);
    // Every branch of respondToPlan either leaves plan mode or (for `discuss`)
    // stays in it deliberately; either way, push whatever the adapter landed
    // on into the registry so clients stop seeing a stale "plan" chip.
    this.#hooks.onMode(id, run.session.snapshot().mode);
    this.#resumeAfterAnswer(id, run);
    return { ok: true, alreadyResolved: false };
  }

  async setMode(id: string, mode: SessionMode): Promise<void> {
    const run = this.#require(id);
    if (run.ended) throw new Error("session has ended");
    await run.session.setMode(mode);
  }

  async setModel(id: string, model: string): Promise<void> {
    const run = this.#require(id);
    if (run.ended) throw new Error("session has ended");
    await run.session.setModel(model);
  }

  async setEffort(id: string, effort: EffortLevel): Promise<void> {
    const run = this.#require(id);
    if (run.ended) throw new Error("session has ended");
    await run.session.setEffort(effort);
  }

  /**
   * Undo: drop everything after an earlier turn. `keep` is a message count
   * (aisdk); `at` is the kept turn's chain-entry ref (Claude — see
   * {@link AdapterSnapshot.rewindRef}).
   */
  async rewind(id: string, keep: number, at?: string): Promise<void> {
    const run = this.#require(id);
    if (run.ended) throw new Error("session has ended");
    // S13: only a settled, non-terminal session (`idle` / `error` /
    // `interrupted`) may rewind — anything live or `done` must be interrupted
    // first so a clean end isn't overwritten.
    if (isLiveState(run.state) || run.state.kind === "done") {
      throw new Error("interrupt the session before rewinding it");
    }
    return this.#enqueue(run, async () => {
      run.restructuring = "rewind";
      run.rewinding = true;
      try {
        await run.session.rewind(keep, at);
        if (this.#running.get(id) === run) this.#transition(id, run, stateIdle, "rewind");
      } finally {
        run.restructuring = null;
        run.rewinding = false;
      }
    });
  }

  // --- teardown ------------------------------------------------------

  /** Close and forget a single session (e.g. tearing down a failed fork). */
  async close(id: string): Promise<void> {
    const run = this.#running.get(id);
    if (!run) return;
    this.#running.delete(id);
    this.#keepWarm.delete(id);
    this.#warmPings.delete(id);
    try {
      await run.session.close();
    } catch {
      // best effort
    }
    // Let any queued `send` / `compact` / `rewind` unwind against the now-closed
    // adapter before we drop the run — otherwise `#enqueue`'s `finally` fires
    // after teardown.
    await run.gate.catch(() => {});
    await run.pump.catch(() => {});
  }

  async shutdown(): Promise<void> {
    const runs = [...this.#running.values()];
    this.#running.clear();
    this.#keepWarm.clear();
    this.#warmPings.clear();
    await Promise.all(
      runs.map(async (run) => {
        try {
          await run.session.close();
        } catch {
          // best effort
        }
        await run.gate.catch(() => {});
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
