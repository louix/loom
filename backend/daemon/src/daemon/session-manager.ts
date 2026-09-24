/**
 * Owns every live adapter session: one pump task per session drains the
 * adapter's normalized `HarnessEvent` stream, forwards each frame to the daemon,
 * derives status (design spec §4) and rolls usage up. Turn control funnels
 * through here so the daemon stays thin. The three ops that restructure the
 * transcript / turn ownership — `send`, `compact`, `rewind` — are serialized
 * per session through `#enqueue`; `interrupt` / `close` deliberately preempt
 * that chain rather than queue behind it.
 */
import { signalOf } from "./startup.ts";
import type { BackgroundTaskInfo, HarnessEvent } from "@loom/core/events";
import { interactionFor, type SessionInteraction } from "@loom/core/interaction";
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
  /**
   * A usage delta to accumulate. Mutation only: publication for the event that
   * produced it happens once, after its status has been derived — a snapshot
   * from between the two would carry a turn count and the previous turn's
   * status at the same time.
   */
  onUsage(sessionId: string, delta: UsageDelta): void;
  /** A turn ended (clean or not). Fires after the usage rollup for that turn. */
  onResult(sessionId: string, ok: boolean): void;
  /**
   * Publish the session's snapshot: something about it changed and no status
   * transition carried it out. That covers the outstanding-request set, the
   * sub-agent set, the live background-task set, the restructuring gate,
   * compaction progress, a rate-limit window, and a usage rollup mid-turn.
   *
   * Called at most once per drained event, and only after everything that
   * event changed has been applied — see `#drain`. The daemon reads current
   * authoritative values rather than anything passed in here.
   */
  onOverlay(sessionId: string): void;
  /** The provider's persisted id became known. */
  onProviderRef(sessionId: string, providerRef: string): void;
  /**
   * This live session's mode changed outside an explicit `session.setMode`
   * call — a plan decision, or the adapter's own mid-turn switch. Carries no
   * value on purpose: the handler may run long after the notification (it is
   * serialized behind the session's other commands), by which time a command
   * that overtook this one may have moved the mode again. Ask
   * {@link SessionManager.snapshot} when you handle it.
   */
  onMode(sessionId: string): void;
  log: Logger;
}

export interface RespondResult {
  ok: boolean;
  alreadyResolved: boolean;
}

/**
 * `setMode`'s outcome. `plan_pending`: an outstanding `ExitPlanMode` review
 * already blocks the turn on a human decision (`respondToPlan`) — the mode
 * must not silently answer it either way, so the caller has to point the user
 * back at the plan-review UI instead of the mode having just changed under it.
 */
export type SetModeResult = { ok: true } | { ok: false; reason: "plan_pending" };

interface Running {
  provider: string;
  session: AgentSession;
  /** The one source of truth for turn state — `deriveStatus` in, `onStatus` out. */
  state: SessionState;
  ordinal: number;
  /**
   * Outstanding blocking requests, insertion-ordered: request id → the complete
   * interaction. `awaiting_input` iff non-empty, and its `AwaitReason` is
   * derived from these entries rather than tracked beside them.
   */
  pending: Map<string, SessionInteraction>;
  subagents: Map<string, { name: string; startedAt: number; active: boolean }>;
  /** Live, non-ambient background tasks — last `background_tasks` event's set. */
  backgroundTasks: BackgroundTaskInfo[];
  ended: boolean;
  refReported: boolean;
  firstOutputSince: number | null;
  pump: Promise<void>;
  /** Per-session op chain — `send` / `compact` / `rewind` run one at a time through {@link SessionManager.#enqueue}. */
  gate: Promise<unknown>;
  operations: number;
  /** Set for the duration of a gated `compact` / `rewind` / provider swap; a straight `send` is fast-failed while non-null. */
  restructuring: "compact" | "rewind" | "provider" | null;
  /** Epoch ms the gate opened — seeds the snapshot's `compacting` overlay. */
  restructuringSince: number | null;
  /** Set around a gated `rewind` — `interrupt` no-ops rather than clobber a fork in progress. */
  rewinding: boolean;
  /**
   * A compaction in flight, tracked from its `compact_progress` beats — which
   * are neither persisted nor state-bearing, so this overlay is the only thing
   * a client attaching mid-compaction can read it off. Covers a
   * *provider-triggered* auto-compaction too, which never holds the op gate.
   * Cleared by the landing `compact` event or any `error`; a gated `compact`
   * keeps its own fallback overlay until the gate releases.
   */
  compaction: { startedAt: number; before: number; generated: number } | null;
  /** Cancellation is independent of turn state; failed stops must be retried before sending. */
  cancellation: "none" | "stopping" | "failed" | "stopped";
  interruptOperation: Promise<void> | null;
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

  isStopping(id: string): boolean {
    return this.#running.get(id)?.cancellation === "stopping";
  }

  stopFailed(id: string): boolean {
    return this.#running.get(id)?.cancellation === "failed";
  }

  has(id: string): boolean {
    return this.#running.has(id);
  }

  isEnded(id: string): boolean {
    return this.#running.get(id)?.ended ?? false;
  }

  ids(): string[] {
    return [...this.#running.keys()];
  }

  snapshot(id: string): AdapterSnapshot | null {
    return this.#running.get(id)?.session.snapshot() ?? null;
  }

  /** Non-null while a `compact` / `rewind` / provider swap holds the session's
   *  op gate — the daemon `session.send` and `session.setProvider` handlers
   *  both fast-fail with `code: "busy"` on it. */
  isRestructuring(id: string): "compact" | "rewind" | "provider" | null {
    return this.#running.get(id)?.restructuring ?? null;
  }

  /**
   * The `compacting` snapshot overlay: the live progress of a compaction, from
   * its `compact_progress` beats when there are any, else the bare fact that a
   * gated `compact` still holds the op gate. Beats are neither persisted nor
   * state-bearing, so this is the only thing a freshly attached client
   * (reopened TUI, second window) can read the compaction off. `before: 0`
   * means "not reported yet" — the caller substitutes the session's current
   * context fill.
   */
  compacting(id: string): { startedAt: number; before: number; generated: number } | null {
    const run = this.#running.get(id);
    if (run === undefined) return null;
    if (run.compaction) return run.compaction;
    return run.restructuring === "compact" && run.restructuringSince !== null
      ? { startedAt: run.restructuringSince, before: 0, generated: 0 }
      : null;
  }

  /**
   * The session's outstanding blocking requests, oldest first — complete enough
   * for a client with no transcript to render and answer them.
   */
  requestsOf(id: string): SessionInteraction[] {
    const run = this.#running.get(id);
    return run === undefined ? [] : [...run.pending.values()];
  }

  // --- lifecycle --------------------------------------------------------

  async create(provider: AgentProvider, opts: CreateSessionOptions): Promise<void> {
    const started = performance.now();
    const session = await provider.createSession(opts);
    if (signalOf(opts)?.aborted) {
      await session.close();
      signalOf(opts)!.throwIfAborted();
    }
    this.#hooks.log.info("adapter_ready", {
      sessionId: opts.sessionId,
      providerId: provider.id,
      operation: "create",
      elapsedMs: Math.round(performance.now() - started),
    });
    this.#attach(provider.id, opts.sessionId, session, stateStarting, started);
  }

  async resume(provider: AgentProvider, ref: SessionRef): Promise<void> {
    const started = performance.now();
    const session = await provider.resumeSession(ref);
    this.#hooks.log.info("adapter_ready", {
      sessionId: ref.sessionId,
      providerId: provider.id,
      operation: "resume",
      elapsedMs: Math.round(performance.now() - started),
    });
    // A resume re-mounts the adapter with the prior transcript but no turn in
    // flight (both adapters park until the next send), so the tracked state
    // seeds `idle`, not `starting`. Seeding a live state here made the first
    // follow-up send read as a mid-turn injection (`injected: true`), which the
    // TUI renders as "sent mid-turn" and the daemon treats as not-a-turn-start
    // (no transition to running, no checkpoint user-text seed).
    this.#attach(provider.id, ref.sessionId, session, stateIdle);
  }

  #attach(
    providerId: string,
    id: string,
    session: AgentSession,
    state: SessionState = stateStarting,
    started = performance.now(),
  ): void {
    const run: Running = {
      provider: providerId,
      firstOutputSince: state.kind === "starting" ? started : null,
      session,
      state,
      // S11: seed from wall-clock, not 0 — a session resumed after a restart
      // would otherwise re-issue ordinals 0,1,2… that collide with the ones
      // already stamped on its persisted events. Still monotonic per session
      // (`ordinal++`), and only ever compared within one session's stream.
      ordinal: Date.now(),
      pending: new Map(),
      subagents: new Map(),
      backgroundTasks: [],
      ended: false,
      refReported: false,
      pump: Promise.resolve(),
      gate: Promise.resolve(),
      operations: 0,
      restructuring: null,
      restructuringSince: null,
      rewinding: false,
      compaction: null,
      cancellation: "none",
      interruptOperation: null,
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
        if (run.ended) break;
        const ev = { ...raw, ordinal: run.ordinal++ } as HarnessEvent;
        if (ev.type === "assistant_text" && run.firstOutputSince !== null) {
          this.#hooks.log.info("first_output", {
            sessionId: id,
            providerId: run.provider,
            elapsedMs: Math.round(performance.now() - run.firstOutputSince),
          });
          run.firstOutputSince = null;
        }
        if (ev.type === "result" || (ev.type === "error" && ev.fatal)) run.firstOutputSince = null;
        if (ev.type === "error" && ev.fatal) {
          this.#hooks.log.warn("session error", { id, message: ev.message });
        }
        // Persisting and broadcasting the raw event is its own concern, and its
        // own failure. It runs first (the transcript should carry the event
        // before anything derived from it is published) but it must not take
        // the bookkeeping below with it: a store write hiccup would otherwise
        // freeze this session's state while the agent kept running, and no
        // client would be told. Log it — never pretend it succeeded.
        try {
          this.#hooks.emitEvent(ev);
        } catch (err) {
          this.#hooks.log.error("event persist/broadcast failed; state still advancing", {
            id,
            evType: ev.type,
            err: err instanceof Error ? err.message : String(err),
          });
        }
        // A transient failure in a downstream hook (a store write hiccup inside
        // onStatus / onUsage) must not end the drain and tear down a live agent
        // session — log it and keep consuming the stream.
        try {
          // One event, one transition, one publication. Everything the event
          // changes is applied first — requests, compaction progress,
          // sub-agents, background tasks, rate-limit windows, usage — then the
          // status is derived from the result, and only then does anything go
          // out. None of these hooks publishes; a subscriber that saw a
          // snapshot from the middle of this would be shown, say, a turn count
          // that has gone up beside the status of the turn that produced it.
          // Every tracker runs — `||` would short-circuit and skip the rest.
          const changed = [
            this.#trackPending(run, ev),
            this.#trackCompaction(run, ev),
            this.#trackSubagents(run, ev),
            this.#trackBackgroundTasks(run, ev),
            ev.type === "rate_limit",
            this.#trackUsage(id, ev),
          ].some((c) => c);
          this.#trackRef(id, run);
          // Publishes when it fires, carrying everything applied above.
          const transitioned = this.#applyStatus(id, run, ev);
          if (changed && !transitioned) this.#hooks.onOverlay(id);
          // Last, and only now: the turn's usage and turn count are recorded,
          // so the checkpoint is taken against the turn that produced them.
          // Titling is deliberately asynchronous — a later transition of its own.
          if (ev.type === "result") this.#hooks.onResult(id, ev.kind === "ok");
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
      const cleared = this.#clearOverlays(run);
      if (isLiveState(run.state)) {
        this.#transition(id, run, stateInterrupted("stream_ended"), "stream_ended");
      } else if (cleared) {
        // A settled session whose stream ended still has to tell clients the
        // requests are gone — no transition will carry it.
        this.#hooks.onOverlay(id);
      }
    } catch (err) {
      run.ended = true;
      this.#clearOverlays(run);
      const message = err instanceof Error ? err.message : String(err);
      this.#hooks.log.warn("session pump failed", { id, err: message });
      this.#hooks.emitEvent({ type: "error", sessionId: id, ts: Date.now(), message, fatal: true });
      this.#transition(id, run, stateError(message.slice(0, 120)));
    }
  }

  /**
   * Drop every overlay a dead adapter can no longer update — outstanding
   * requests (unanswerable now), foreground/background tasks and any
   * compaction in flight. Returns whether anything actually changed, so the
   * caller can publish when no status transition will.
   */
  #clearOverlays(run: Running): boolean {
    let changed = run.pending.size > 0 || run.compaction !== null;
    run.pending.clear();
    run.compaction = null;
    if (run.backgroundTasks.length > 0) {
      run.backgroundTasks = [];
      changed = true;
    }
    for (const subagent of run.subagents.values()) {
      if (!subagent.active) continue;
      subagent.active = false;
      changed = true;
    }
    return changed;
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
   * Entries are the complete interaction, not just its reason, so a client can
   * render and answer one off a snapshot alone. A `tool_result` clears a
   * permission (not `tool_call`: the aisdk adapter emits the call *before* its
   * gate's `permission_request`, so only the result reliably marks it done;
   * Claude emits them the other way and this works too); an `answer` clears a
   * question. Plans are cleared by `respondToPlan`.
   *
   * Returns whether the set changed — the caller publishes a snapshot on that,
   * so a second parallel permission arriving (or one of several being answered)
   * reaches clients even though the session stays `awaiting_input` throughout.
   */
  #trackPending(run: Running, ev: HarnessEvent): boolean {
    if (run.cancellation !== "none") return false;
    const request = interactionFor(ev);
    if (request) {
      run.pending.set(request.id, request);
      return true;
    }
    if (ev.type === "answer" || ev.type === "tool_result") return run.pending.delete(ev.id);
    return false;
  }

  /**
   * Track a compaction from its `compact_progress` beats, so the snapshot
   * carries the progress the UI used to piece together from the event stream.
   * The landing `compact` clears it, and so does *any* `error` — a summariser
   * that times out or fails reports a non-fatal one and then never sends a
   * `compact`, so waiting for a fatal error would pin "compacting…" forever.
   * A gated `compact` keeps its own fallback overlay until the gate releases.
   */
  #trackCompaction(run: Running, ev: HarnessEvent): boolean {
    if (ev.type === "compact_progress") {
      run.compaction = {
        startedAt: ev.ts - ev.elapsedMs,
        before: ev.before,
        generated: ev.generated,
      };
      return true;
    }
    if (ev.type === "compact" || ev.type === "error") {
      if (run.compaction === null) return false;
      run.compaction = null;
      return true;
    }
    return false;
  }

  #trackSubagents(run: Running, ev: HarnessEvent): boolean {
    if (ev.type === "subagent_started") {
      if (run.cancellation === "stopped") return false;
      run.subagents.set(ev.subagentId, { name: ev.name, startedAt: ev.ts, active: true });
      return true;
    }
    if (ev.type === "subagent_stopped") {
      const cur = run.subagents.get(ev.subagentId);
      if (!cur || !cur.active) return false;
      run.subagents.set(ev.subagentId, { ...cur, active: false });
      return true;
    }
    return false;
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
  #trackBackgroundTasks(run: Running, ev: HarnessEvent): boolean {
    if (ev.type !== "background_tasks") return false;
    if (run.cancellation === "stopped") return false;
    run.backgroundTasks = ev.tasks;
    return true;
  }

  /** Live background tasks this session has spawned (async subagents, shells). */
  backgroundTasksOf(id: string): BackgroundTaskInfo[] {
    return this.#running.get(id)?.backgroundTasks ?? [];
  }

  /** Returns whether it moved the session's totals. `onUsage` accumulates and
   *  does not publish — this event's publication happens once, above. */
  #trackUsage(id: string, ev: HarnessEvent): boolean {
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
        costUsd: Number.isFinite(cost) && cost >= 0 ? cost : 0,
        ...(ev.costDeltaUsd !== undefined && Number.isFinite(cost) && cost >= 0
          ? { costSource: "provider" as const }
          : {}),
        ...(ev.cacheCreation ? { cacheCreation: ev.cacheCreation } : {}),
        contextUsed: ev.contextUsed,
        ...(ev.contextLimit > 0 ? { contextLimit: ev.contextLimit } : {}),
        ...(ev.tokens.cacheRead > 0 || ev.tokens.cacheWrite > 0 ? { lastTurnAt: ev.ts } : {}),
        ...(ev.tokens.input > 0 || ev.tokens.cacheRead > 0 || ev.tokens.cacheWrite > 0
          ? { requestAt: ev.ts }
          : {}),
        lastCacheRead: ev.tokens.cacheRead,
        lastCacheWrite: ev.tokens.cacheWrite,
        ...(ev.cacheTtlMinutes ? { lastCacheTtlMinutes: ev.cacheTtlMinutes } : {}),
      });
      return true;
    }
    if (ev.type === "context") {
      // Fill only: a mid-turn request has no settled token delta to accumulate
      // and no turn boundary to arm the cache countdown with. `UsageDelta`'s
      // context fields are absolute and every field is optional, so a partial
      // delta moves the meter and leaves the rest of the row untouched.
      this.#hooks.onUsage(id, {
        contextUsed: ev.contextUsed,
        ...(ev.contextLimit ? { contextLimit: ev.contextLimit } : {}),
      });
      return true;
    }
    if (ev.type === "result") {
      this.#hooks.onUsage(id, { turns: 1 });
      return true;
    }
    return false;
  }

  /** Returns whether it published a transition. */
  #applyStatus(id: string, run: Running, ev: HarnessEvent): boolean {
    if (run.cancellation !== "none") {
      if (ev.type === "error" && ev.fatal) {
        if (run.cancellation !== "stopping") run.cancellation = "failed";
        return this.#transition(id, run, stateError(ev.message));
      }
      return false;
    }
    // Outside explicit cancellation, provider events drive the normal machine.
    // Background membership is already current when a result is derived.
    return this.#transition(
      id,
      run,
      deriveStatus(run.state, ev, { backgroundTasks: run.backgroundTasks.length }),
    );
  }

  /** Apply a state transition. A `note` is an audit breadcrumb and always fires.
   *  Returns whether it fired — the caller then knows a snapshot went out. */
  #transition(id: string, run: Running, next: SessionState, note?: string): boolean {
    if (sameSessionState(run.state, next) && note === undefined) return false;
    run.state = next;
    this.#hooks.onStatus(id, next, note);
    return true;
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
    run.operations++;
    const prev = run.gate;
    let release!: () => void;
    run.gate = new Promise<void>((r) => {
      release = r;
    });
    await prev.catch(() => {});
    try {
      return await op();
    } finally {
      run.operations--;
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
    opts: { keepWarm?: boolean; signal?: AbortSignal } = {},
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
    if (run.cancellation === "stopping" || run.cancellation === "failed")
      throw new Error("cancellation is unresolved — retry interrupt before sending");
    return this.#enqueue(run, async () => {
      opts.signal?.throwIfAborted();
      if (run.cancellation === "stopping" || run.cancellation === "failed")
        throw new Error("cancellation is unresolved — retry interrupt before sending");
      run.cancellation = "none";
      const injected = isLiveState(run.state);
      const before = run.state;
      if (!injected) run.firstOutputSince = performance.now();
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
      if (run.cancellation === "stopping" || run.cancellation === "failed")
        throw new Error("cancellation is unresolved — retry interrupt first");
      run.restructuring = "compact";
      run.restructuringSince = Date.now();
      // Snapshots carry a `compacting` overlay for the whole gate hold, so a
      // client that attaches mid-compaction still shows "compacting…".
      this.#hooks.onOverlay(id);
      try {
        await run.session.compact(instructions);
        // Status is left to the event stream: `/compact` runs a turn that ends
        // with its own `result`, and a session compacted while idle stays idle.
      } finally {
        run.restructuring = null;
        run.restructuringSince = null;
        run.compaction = null;
        this.#hooks.onOverlay(id);
      }
    });
  }

  async interrupt(id: string): Promise<void> {
    const run = this.#require(id);
    if (run.interruptOperation) return run.interruptOperation;
    // A fork / rewind is mid-flight — there is no turn to stop and clobbering
    // state here would race the rewind's own idle transition.
    if (run.rewinding) return;
    const compactOnly = run.restructuring === "compact" && !isLiveState(run.state);
    // S13: an interrupt on a session that already ended cleanly (idle / error /
    // interrupted / done) must not overwrite that settled state.
    if (
      run.ended ||
      (!compactOnly &&
        !isLiveState(run.state) &&
        run.cancellation !== "failed" &&
        !run.backgroundTasks.length &&
        ![...run.subagents.values()].some((s) => s.active))
    )
      return;
    // Keep child activity until the provider confirms cancellation. Pending
    // requests are withdrawn as soon as the user requests a stop.
    run.pending.clear();
    run.cancellation = "stopping";
    this.#hooks.onOverlay(id);
    const operation = Promise.resolve().then(async () => {
      try {
        await run.session.interrupt();
        run.cancellation = "stopped";
        this.#clearOverlays(run);
        if (!run.ended && !compactOnly) this.#transition(id, run, stateInterrupted("user"), "user");
      } catch (err) {
        run.cancellation = "failed";
        const message = `Could not stop all session work: ${err instanceof Error ? err.message : String(err)} — retry interrupt`;
        this.#hooks.log.warn("adapter interrupt failed", { id, err: message });
        if (!run.ended) {
          this.#hooks.emitEvent({
            type: "error",
            sessionId: id,
            ts: Date.now(),
            fatal: false,
            message,
          });
          this.#transition(id, run, stateError(message));
        }
        throw new Error(message);
      } finally {
        run.interruptOperation = null;
        this.#hooks.onOverlay(id);
      }
    });
    run.interruptOperation = operation;
    return operation;
  }

  /** Move a settled `awaiting_input` session back to `running` — unless a user
   *  interrupt landed in between (the interrupt sticks), or other requests from
   *  the same turn are still open (parallel tool calls each raise their own
   *  permission_request; the turn stays blocked until the last is answered).
   *  Either way the request set just shrank, so publish a snapshot: a
   *  transition carries it, and when the turn stays blocked the overlay hook
   *  does — otherwise the other clients keep offering an answered request. */
  #resumeAfterAnswer(id: string, run: Running): void {
    const resume =
      run.cancellation === "none" && run.state.kind !== "interrupted" && run.pending.size === 0;
    if (resume && this.#transition(id, run, stateRunning)) return;
    this.#hooks.onOverlay(id);
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
    this.#hooks.onMode(id);
    this.#resumeAfterAnswer(id, run);
    return { ok: true, alreadyResolved: false };
  }

  async setMode(id: string, mode: SessionMode): Promise<SetModeResult> {
    const run = this.#require(id);
    if (run.ended) throw new Error("session has ended");
    // A pending `ExitPlanMode` review already blocks the turn on a human
    // decision (`respondToPlan`) — the chip must not be able to answer it one
    // way or the other by proxy. Refuse instead of guessing; the caller (the
    // daemon's `session.setMode` RPC) points the user back at the real
    // plan-review UI so they resolve it deliberately.
    if (mode !== "plan" && [...run.pending.values()].some((i) => i.kind === "plan_review")) {
      return { ok: false, reason: "plan_pending" };
    }
    await run.session.setMode(mode);
    return { ok: true };
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
   * Swap a settled session onto `newProvider` in place — the session id, the
   * transcript store and the worktree are unchanged; only the adapter (and the
   * vendor SDK behind it) is rebuilt. `ref` carries the resolved model / effort
   * / mode / cwd. The caller has already checked the provider is known and, for
   * now, that both sides are aisdk (a shared, provider-agnostic transcript — the
   * new adapter resumes with full history).
   *
   * On any failure the run is dropped from the live set; the caller leaves the
   * DB row untouched, so the next `send` revives the session on the *old*
   * provider.
   */
  async setProvider(id: string, newProvider: AgentProvider, ref: SessionRef): Promise<void> {
    const run = this.#require(id);
    if (run.ended) throw new Error("session has ended");
    // Mirror `rewind`: only a settled, non-terminal session may be reprovisioned
    // — a live turn would be dropped, and `done` would be silently un-ended.
    if (isLiveState(run.state) || run.state.kind === "done") {
      throw new Error("interrupt the session before switching its provider");
    }
    return this.#enqueue(run, async () => {
      run.restructuring = "provider";
      run.restructuringSince = Date.now();
      this.#hooks.onOverlay(id);
      // Stop the old adapter and let its drain unwind before the swap, so its
      // stream-ended transition can't land on the freshly attached run.
      run.ended = true;
      this.#clearOverlays(run);
      try {
        await run.session.close();
      } catch {
        // best effort — it's being replaced regardless
      }
      await run.pump.catch(() => {});
      try {
        const session = await newProvider.resumeSession(ref);
        // #attach replaces #running[id] with a fresh Running (new gate,
        // refReported=false) and starts its own drain.
        this.#attach(newProvider.id, id, session, stateIdle);
      } catch (err) {
        this.#running.delete(id);
        throw err;
      } finally {
        run.restructuring = null;
        run.restructuringSince = null;
        this.#hooks.onOverlay(id);
      }
    });
  }

  /**
   * Undo: drop everything after an earlier turn. `keep` is a message count
   * (aisdk); `at` is the kept turn's chain-entry ref (Claude — see
   * {@link AdapterSnapshot.rewindRef}).
   */
  async rewind(id: string, keep: number, at?: string): Promise<void> {
    const run = this.#require(id);
    if (run.cancellation === "stopping" || run.cancellation === "failed")
      throw new Error("cancellation is unresolved — retry interrupt first");
    if (run.ended) throw new Error("session has ended");
    // S13: only a settled, non-terminal session (`idle` / `error` /
    // `interrupted`) may rewind — anything live or `done` must be interrupted
    // first so a clean end isn't overwritten.
    if (isLiveState(run.state) || run.state.kind === "done") {
      throw new Error("interrupt the session before rewinding it");
    }
    return this.#enqueue(run, async () => {
      run.restructuring = "rewind";
      run.restructuringSince = Date.now();
      this.#hooks.onOverlay(id);
      run.rewinding = true;
      try {
        await run.session.rewind(keep, at);
        if (this.#running.get(id) === run) this.#transition(id, run, stateIdle, "rewind");
      } finally {
        run.restructuring = null;
        run.restructuringSince = null;
        this.#hooks.onOverlay(id);
        run.rewinding = false;
      }
    });
  }

  // --- teardown ------------------------------------------------------

  /** Only an entirely settled session can have its VM replaced. */
  canRefresh(id: string): boolean {
    const run = this.#running.get(id);
    return (
      !!run &&
      !run.ended &&
      run.state.kind === "idle" &&
      run.operations === 0 &&
      !run.restructuring &&
      !run.compaction &&
      run.pending.size === 0 &&
      run.backgroundTasks.length === 0 &&
      ![...run.subagents.values()].some((s) => s.active)
    );
  }

  async suspendIdle(id: string): Promise<boolean> {
    if (!this.canRefresh(id)) return false;
    const run = this.#require(id);
    run.ended = true;
    try {
      await this.close(id);
    } finally {
      // Even a cleanup failure leaves this adapter unusable. A later resume
      // must recover its VM instead of sending into the retired session.
      if (this.#running.get(id) === run) this.#running.delete(id);
      this.#keepWarm.delete(id);
      this.#warmPings.delete(id);
    }
    return true;
  }

  /** Close and forget a single session (e.g. tearing down a failed fork). */
  async close(id: string): Promise<void> {
    const run = this.#running.get(id);
    if (!run) return;
    await run.session.close();
    this.#running.delete(id);
    this.#keepWarm.delete(id);
    this.#warmPings.delete(id);
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
