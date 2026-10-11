/**
 * Owns every live adapter session: one pump task per session drains the
 * adapter's normalized `HarnessEvent` stream, forwards each frame to the daemon,
 * derives status (design spec §4) and rolls usage up. Turn control funnels
 * through here so the daemon stays thin. The three ops that restructure the
 * transcript / turn ownership — `send`, `compact`, `rewind` — are serialized
 * per session through `#enqueue`; `interrupt` / `close` deliberately preempt
 * that chain rather than queue behind it.
 */
import { VmTerminationError, type HostStopReason } from "../../../../core/src/vm-termination.ts";
import { signalOf } from "./startup.ts";
import type {
  AgentCallEvent,
  BackgroundTaskInfo,
  DiscardedInput,
  HarnessEvent,
} from "@loom/core/events";
import { interactionFor, type SessionInteraction } from "@loom/core/interaction";
import {
  isLiveState,
  sameSessionState,
  type SessionState,
  stateError,
  stateAwaitingInput,
  stateIdle,
  stateInterrupted,
  stateRunning,
  stateStarting,
  stateWorkingBackground,
} from "@loom/core/session-state";
import type { Logger } from "@loom/core/logger";
import type { UsageDelta } from "../store/sessions.ts";
import type {
  AdapterSnapshot,
  AgentCallResult,
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  EffortLevel,
  PermissionDecision,
  PlanDecision,
  SessionMode,
  SessionRef,
} from "@loom/core/types";
import {
  DeliveryUncertainError,
  QUEUE_PREVIEW_CHARS,
  type QueueEntry,
  type SessionQueue,
} from "@loom/core/message-queue";
import { deriveStatus } from "./status-machine.ts";
import { RpcError } from "./rpc.ts";
import { dequeueHints, nextAction, type DispatchView } from "./message-queue.ts";
import type {
  Enqueued,
  MessageQueueStore,
  QueueResult,
  QueueTarget,
} from "../store/message-queue.ts";

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
   * A user-submitted root turn ended at `at` (epoch ms) — the fleet's recency
   * key. Mutation only, like {@link onUsage}: the transition or overlay that
   * goes out for the same event carries it.
   */
  onTurnCompleted(sessionId: string, at: number): void;
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
  /**
   * An interrupt dropped input queued behind the stopped turn that never
   * reached the agent (an `input_discarded` event). Not transcript: this
   * hook is the event's only consumer. May land just before or after
   * {@link SessionManager.interrupt} settles.
   */
  onInputDiscarded?(sessionId: string, items: readonly DiscardedInput[]): void;
  /**
   * A queued user message is starting a fresh turn — the text the turn's
   * checkpoint and auto-title are seeded from. Not called for one folded into
   * a live turn, nor for Loom's own sends.
   */
  onFreshTurn?(sessionId: string, text: string): void;
  /**
   * The agent called a `loom-agents` tool. The handler answers it with
   * {@link SessionManager.respondToAgentCall}, whenever it is done; nothing
   * waits for it here.
   */
  onAgentCall?(sessionId: string, call: AgentCallEvent): void;
  /**
   * The sessions' message queues (`docs/message-queue.md`). Without one,
   * {@link SessionManager.enqueue} refuses and only direct sends work.
   */
  queue?: MessageQueueStore;
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
  /**
   * Every outstanding request is a background child's, raised while the main
   * loop sat settled in `working_background`: answering lets the child go on,
   * not the turn — it neither runs the session nor starts a user turn.
   */
  blockedInBackground: boolean;
  ended: boolean;
  /**
   * The provider ref last handed to `onProviderRef`. Compared, not latched: a
   * provider may move to another native session within one attach (Claude
   * resumes a fork on undo, and starts a new CLI session on `/clear` and on a
   * fresh plan implementation), and a revive must resume where the
   * conversation now lives.
   */
  reportedRef: string | null;
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
  /**
   * The user gave this session input (opening prompt, send, answer, approval,
   * plan decision) and the root turn it drives has not reported an outcome
   * yet. That outcome is the session's fleet turn boundary — see `#turnEnded`.
   */
  userTurn: boolean;
  /** The adapter reports `input_consumed`; without it a queued message is
   *  consumed the moment it is handed over. */
  inputReceipts: boolean;
  /** Root tool calls without a result yet, id → tool name: while one runs,
   *  the queue's boundary window is open. */
  rootTools: Map<string, string>;
  /** A queue hand-over is scheduled on, or running through, the op gate. */
  handingOver: boolean;
  /** The provider refused a hand-over; no retry until the state moves. */
  backoff: boolean;
  /** What the dispatch policy last read off this run (`#dispatchKey`), or
   *  null once the queue may have moved under it. An event that leaves the
   *  key as it was cannot change the policy's answer: no re-evaluation. */
  evaluated: string | null;
  /** Loom is closing the adapter: its stream ending is no crash. */
  closing: boolean;
}

export class SessionManager {
  readonly #hooks: ManagerHooks;
  readonly #running = new Map<string, Running>();
  /** Session ids with keep-warm on (see {@link setKeepWarm}). Runtime-only. */
  readonly #keepWarm = new Set<string>();
  /** Consecutive keep-warm pings since the last real user message, per session. */
  readonly #warmPings = new Map<string, number>();
  /**
   * Per session, the queue entry that goes next and alone, whatever the hold
   * says: a send-now, or a message sent to a held queue. Runtime-only — a
   * restart forgets the request and the entry waits under the ordinary rules.
   */
  readonly #forced = new Map<string, string>();

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
    this.#attach(provider, opts.sessionId, session, stateStarting, started, opts.mode);
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
    this.#attach(provider, ref.sessionId, session, stateIdle, undefined, ref.mode);
  }

  #attach(
    provider: AgentProvider,
    id: string,
    session: AgentSession,
    state: SessionState = stateStarting,
    started = performance.now(),
    requestedMode?: SessionMode,
  ): void {
    const run: Running = {
      provider: provider.id,
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
      blockedInBackground: false,
      ended: false,
      reportedRef: null,
      pump: Promise.resolve(),
      gate: Promise.resolve(),
      operations: 0,
      restructuring: null,
      restructuringSince: null,
      rewinding: false,
      compaction: null,
      cancellation: "none",
      interruptOperation: null,
      // A create carries its opening prompt; a resume parks until the next send.
      userTurn: state.kind === "starting",
      inputReceipts: provider.capabilities.inputReceipts ?? false,
      rootTools: new Map(),
      handingOver: false,
      backoff: false,
      evaluated: null,
      closing: false,
    };
    this.#running.set(id, run);
    // The adapter may have landed on another mode than the one it was given:
    // Codex maps `acceptEdits` onto Manual and reports a resumed thread's
    // effective mode.
    if (requestedMode !== undefined && session.snapshot().mode !== requestedMode)
      this.#hooks.onMode(id);
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
        // What a Stop dropped is neither transcript nor state: it goes to its
        // own hook alone.
        if (ev.type === "input_discarded") {
          this.#hooks.log.info("interrupt discarded queued input", {
            id,
            kinds: ev.items.map((item) => item.kind),
          });
          run.evaluated = null;
          try {
            this.#requeueDiscarded(id, ev.items);
            this.#hooks.onInputDiscarded?.(id, ev.items);
          } catch (err) {
            this.#hooks.log.error("input-discarded hook threw; continuing drain", {
              id,
              err: err instanceof Error ? err.message : String(err),
            });
          }
          continue;
        }
        // A `loom-agents` call is the daemon's to run; the tool call and its
        // result reach the transcript as the adapter's own events.
        if (ev.type === "agent_call") {
          try {
            this.#hooks.onAgentCall?.(id, ev);
          } catch (err) {
            this.#hooks.log.error("agent-call hook threw; continuing drain", {
              id,
              err: err instanceof Error ? err.message : String(err),
            });
          }
          continue;
        }
        // Neither is a receipt the transcript carries: the message it names
        // enters the log now, as the `user_message` this emits.
        if (ev.type === "input_consumed") {
          run.evaluated = null;
          try {
            this.#consume(id, ev.inputId, ev.midTurn);
            this.#hooks.onOverlay(id);
          } catch (err) {
            this.#hooks.log.error("queue consumption failed; continuing drain", {
              id,
              err: err instanceof Error ? err.message : String(err),
            });
          }
          continue;
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
            this.#trackTurnBoundary(id, run, ev),
            this.#trackRootTools(id, run, ev),
            this.#trackCrash(id, ev),
          ].some((c) => c);
          this.#trackRef(id, run);
          // Publishes when it fires, carrying everything applied above.
          const transitioned = this.#applyStatus(id, run, ev);
          if (changed && !transitioned) this.#hooks.onOverlay(id);
          // Last, and only now: the turn's usage and turn count are recorded,
          // so the checkpoint is taken against the turn that produced them.
          // Titling is deliberately asynchronous — a later transition of its own.
          if (ev.type === "result") this.#hooks.onResult(id, ev.kind === "ok");
          // A tool starting, a turn ending: the queue may have something to
          // hand over now. Only an event that moved what the policy reads can
          // change its answer — a text delta never does, and skips the store.
          if (this.#dispatchKey(run) !== run.evaluated) void this.#pumpQueue(id);
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
      // An adapter that went away by itself may have taken queued input with
      // it; one Loom closed (a swap, an idle suspension, teardown) did not.
      const deliberate = run.ended || run.closing;
      run.ended = true;
      if (!deliberate) this.#holdQueue(id, "crash");
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
      if (!run.ended && !run.closing) this.#holdQueue(id, "crash");
      run.ended = true;
      this.#clearOverlays(run);
      const message = err instanceof Error ? err.message : String(err);
      this.#hooks.log.warn("session pump failed", { id, err: message });
      this.#hooks.emitEvent({
        type: "error",
        sessionId: id,
        ts: Date.now(),
        message,
        fatal: true,
        ...(err instanceof VmTerminationError ? { termination: err.termination } : {}),
      });
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

  /**
   * Report the provider ref whenever it differs from the one last reported —
   * once per change, so a steady ref costs no write per event.
   */
  #trackRef(id: string, run: Running): void {
    const ref = run.session.providerRef;
    if (!ref || ref === run.reportedRef) return;
    run.reportedRef = ref;
    this.#hooks.onProviderRef(id, ref);
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
      // Every outstanding request a child's, the first raised in background.
      run.blockedInBackground =
        ev.agentId !== undefined &&
        (run.pending.size === 0
          ? run.state.kind === "working_background"
          : run.blockedInBackground);
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
        ...(ev.providerTotal ? { providerTotal: ev.providerTotal } : {}),
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

  /**
   * The fleet's turn boundary: the agent finished responding to the user. Only
   * a root outcome of a user-driven turn counts, whatever that outcome was —
   * matching main-new, where every root `outcome` record (`completed`,
   * `failed`, `interrupted`, `unknown`) is a boundary and nothing else is:
   *
   * - completed: a root `result` with `kind: "ok"`;
   * - failed: a root `result` with `kind: "error"`, or a fatal root `error`
   *   (Codex reports a failed turn that way);
   * - interrupted: a user stop the provider confirmed (see {@link interrupt}).
   *
   * Never a boundary: streaming, tool and sub-agent events, usage, a result
   * nobody asked for (keep-warm ping, Loom nudge, background re-drive after
   * the turn already ended), and a turn that vanished without an outcome
   * (stream ended, daemon restart) — there is no outcome to date it by.
   * Returns whether it recorded one.
   */
  #trackTurnBoundary(id: string, run: Running, ev: HarnessEvent): boolean {
    if (ev.agentId !== undefined) return false;
    if (ev.type !== "result" && !(ev.type === "error" && ev.fatal)) return false;
    return this.#turnEnded(id, run, ev.ts);
  }

  #turnEnded(id: string, run: Running, at: number): boolean {
    if (!run.userTurn) return false;
    run.userTurn = false;
    this.#hooks.onTurnCompleted(id, at);
    return true;
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
      this.#interactionState(
        run,
        deriveStatus(run.state, ev, { backgroundTasks: run.backgroundTasks.length }),
      ),
    );
  }

  /** Blocked state is a projection of the outstanding requests, not a second
   * independently maintained reason. Adapter settlement uses this too. */
  #interactionState(run: Running, state: SessionState): SessionState {
    if (state.kind !== "awaiting_input" && state.kind !== "running") return state;
    const request = [...run.pending.values()].at(-1);
    return request ? stateAwaitingInput(request.kind) : stateRunning;
  }

  /** Apply a state transition. A `note` is an audit breadcrumb and always fires.
   *  Returns whether it fired — the caller then knows a snapshot went out. */
  #transition(id: string, run: Running, next: SessionState, note?: string): boolean {
    if (sameSessionState(run.state, next) && note === undefined) return false;
    run.state = next;
    // A refused hand-over is retried once the session has moved on.
    run.backoff = false;
    this.#hooks.onStatus(id, next, note);
    return true;
  }

  /**
   * Root tool calls in flight — the queue's boundary window. Returns whether
   * the window moved while something waits in the queue, whose hints then
   * need publishing.
   */
  #trackRootTools(id: string, run: Running, ev: HarnessEvent): boolean {
    if (ev.agentId !== undefined) return false;
    let changed = false;
    if (ev.type === "tool_call") {
      run.rootTools.set(ev.id, ev.name);
      changed = true;
    } else if (ev.type === "tool_result") changed = run.rootTools.delete(ev.id);
    else if (ev.type === "result" || (ev.type === "error" && ev.fatal)) {
      changed = run.rootTools.size > 0;
      run.rootTools.clear();
    }
    return changed && this.#hasQueued(id);
  }

  /** A fatal root error may have taken handed-over input with it. */
  #trackCrash(id: string, ev: HarnessEvent): boolean {
    return ev.type === "error" && ev.fatal && ev.agentId === undefined
      ? this.#holdQueue(id, "crash")
      : false;
  }

  // --- message queue (docs/message-queue.md) -----------------------------

  #hasQueued(id: string): boolean {
    return this.#hooks.queue?.slots(id).some((e) => e.state === "queued") ?? false;
  }

  /** The part of the dispatch view the policy decides on (`handingOver`
   *  aside: the pump never evaluates while one runs). */
  #dispatchKey(run: Running): string {
    const v = this.#dispatchView(run);
    return `${v.attached}|${v.state.kind}|${v.restructuring}|${v.cancelling}|${v.backoff}|${v.rootTool !== null}`;
  }

  /** What the dispatch policy reads off the session's run. */
  #dispatchView(run: Running | undefined): DispatchView {
    return {
      attached: run !== undefined && !run.ended,
      state: run?.state ?? stateIdle,
      restructuring: (run?.restructuring ?? null) !== null,
      cancelling: run?.cancellation === "stopping" || run?.cancellation === "failed",
      handingOver: run?.handingOver ?? false,
      rootTool: run ? ([...run.rootTools.values()][0] ?? null) : null,
      backoff: run?.backoff ?? false,
    };
  }

  /**
   * Stop the queue after something that may have lost handed-over input — a
   * crash, a fatal error: delivering entries become uncertain and the queue
   * waits for the user. A hold already set stays (its reason came first).
   * Returns whether anything changed.
   */
  #holdQueue(id: string, hold: "crash" | "interrupt"): boolean {
    const q = this.#hooks.queue;
    if (!q || q.slots(id).length === 0) return false;
    q.markUncertain(id);
    this.#forced.delete(id);
    const run = this.#running.get(id);
    if (run) run.evaluated = null;
    if (q.hold(id) === null) q.setHold(id, hold);
    return true;
  }

  /** The agent took entry `entryId`: it enters the log here, as a `user_message`. */
  #consume(id: string, entryId: string, midTurn: boolean): void {
    const entry = this.#hooks.queue?.markConsumed(id, entryId);
    if (!entry) return;
    this.#hooks.emitEvent({
      type: "user_message",
      sessionId: id,
      ts: entry.consumedAt ?? Date.now(),
      text: entry.text,
      injected: midTurn,
      queueEntryId: entry.id,
      author: entry.author,
    });
  }

  /**
   * A stop discarded input before the agent saw it: the queue's entries go
   * back to `queued` at their old places, held. Anything else — Loom's own
   * direct sends, the provider's notifications — is dropped.
   */
  #requeueDiscarded(id: string, items: readonly DiscardedInput[]): void {
    const q = this.#hooks.queue;
    if (!q) return;
    let back = 0;
    for (const item of items) if (item.ref !== undefined && q.requeue(id, item.ref)) back++;
    if (back === 0) return;
    if (q.hold(id) === null) q.setHold(id, "interrupt");
    this.#hooks.onOverlay(id);
  }

  /**
   * Evaluate the dispatch policy and, if it says so, run the hand-over on the
   * op gate. Called after every transition, queue change and op, and after
   * every event that moved the dispatch key.
   */
  #pumpQueue(id: string): Promise<void> | undefined {
    const q = this.#hooks.queue;
    const run = this.#running.get(id);
    if (!q || !run || run.ended || run.handingOver) return undefined;
    run.evaluated = this.#dispatchKey(run);
    const action = nextAction(
      q.slots(id),
      q.hold(id),
      this.#dispatchView(run),
      this.#forced.get(id) ?? null,
    );
    if (action.t === "none") return undefined;
    run.handingOver = true;
    return this.#enqueue(run, () => this.#handOver(id, run))
      .catch((err) => {
        this.#hooks.log.error("queue hand-over failed", {
          id,
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        run.handingOver = false;
        void this.#pumpQueue(id);
      });
  }

  /** On the op gate: decide again (things moved while waiting) and hand over. */
  async #handOver(id: string, run: Running): Promise<void> {
    const q = this.#hooks.queue;
    if (!q || this.#running.get(id) !== run || run.ended) return;
    const forced = this.#forced.get(id) ?? null;
    const action = nextAction(
      q.slots(id),
      q.hold(id),
      { ...this.#dispatchView(run), handingOver: false },
      forced,
    );
    if (action.t !== "handover") return;
    if (forced !== null && action.ids.includes(forced)) this.#forced.delete(id);
    const entries = action.ids.flatMap((entryId) => q.entry(id, entryId) ?? []);
    // Recorded before the provider is called, so a crash in between leaves
    // them delivering — uncertain after a restart, never silently re-sent.
    q.markDelivering(
      id,
      entries.map((e) => e.id),
    );
    this.#hooks.onOverlay(id);
    for (const [i, entry] of entries.entries()) {
      // The first of a fresh batch starts the turn; the rest join it.
      const midTurn = !action.fresh || i > 0;
      if (await this.#deliver(id, run, entry, midTurn)) continue;
      if (entry.id === forced) this.#forced.set(id, forced);
      for (const rest of entries.slice(i + 1)) q.requeue(id, rest.id);
      break;
    }
    this.#hooks.onOverlay(id);
  }

  /** Hand one entry to the adapter. False when it did not go. */
  async #deliver(id: string, run: Running, entry: QueueEntry, midTurn: boolean): Promise<boolean> {
    const q = this.#hooks.queue!;
    const before = run.state;
    if (!midTurn) run.firstOutputSince = performance.now();
    // Armed before the hand-off, as in `send`: a fast turn can report its
    // outcome before the adapter's `send()` resolves. A fold joins the turn.
    const armed = run.userTurn;
    run.userTurn = true;
    run.cancellation = "none";
    this.#warmPings.delete(id);
    try {
      await run.session.send(entry.text, { inputId: entry.id, midTurn });
    } catch (err) {
      run.userTurn = armed;
      const message = err instanceof Error ? err.message : String(err);
      const uncertain = err instanceof DeliveryUncertainError;
      if (uncertain) {
        // It may have arrived: never retried by itself — the user decides.
        q.markUncertain(id, [entry.id]);
        q.setHold(id, "rejected");
        this.#hooks.emitEvent({
          type: "error",
          sessionId: id,
          ts: Date.now(),
          fatal: false,
          message: `A queued message may not have reached the agent (${message}); the queue is held — review it with q.`,
        });
      } else {
        // Refused, so nothing went out: it waits for the session to move on,
        // or for the user to touch the queue. Folding into a turn that just
        // ended is refused routinely (Codex's `expectedTurnId`); a refused
        // turn start is worth saying.
        q.requeue(id, entry.id);
        run.backoff = true;
        if (!midTurn)
          this.#hooks.emitEvent({
            type: "error",
            sessionId: id,
            ts: Date.now(),
            fatal: false,
            message,
          });
      }
      this.#hooks.log.warn("queued message not handed over", {
        id,
        entryId: entry.id,
        uncertain,
        err: message,
      });
      return false;
    }
    if (this.#running.get(id) !== run) return false;
    if (!midTurn) {
      this.#hooks.onFreshTurn?.(id, entry.text);
      // S2, as in `send`: only claim `running` if nothing moved the state yet.
      if (sameSessionState(run.state, before)) this.#transition(id, run, stateRunning);
    }
    // Without receipts the hand-over is all the evidence there will be.
    if (!run.inputReceipts) this.#consume(id, entry.id, midTurn);
    return true;
  }

  /**
   * Queue a user message (`session.send`). Sent to a held queue it goes first
   * and alone, and sending it releases the hold; the held entries then follow
   * the ordinary rules relative to the turn it starts.
   *
   * `behindHold` is for what is not the user speaking (a Loom agent's
   * notification): it joins a held queue at the back and leaves the hold —
   * only the user, sending or releasing, lifts a stop.
   */
  async enqueue(
    id: string,
    e: { entryId: string; text: string; author: string; delivery: QueueEntry["delivery"] },
    opts: { behindHold?: boolean } = {},
  ): Promise<QueueResult<Enqueued>> {
    const q = this.#hooks.queue;
    if (!q) throw new Error("this daemon has no message queue");
    const held = q.hold(id) !== null && !opts.behindHold;
    const r = q.enqueue(
      id,
      { id: e.entryId, text: e.text, author: e.author, delivery: e.delivery },
      { head: held },
    );
    if (!r.ok || !r.value.created) return r;
    if (held) {
      this.#forced.set(id, e.entryId);
      q.setHold(id, null);
    }
    this.#retry(id);
    this.#hooks.onOverlay(id);
    // Settles once a hand-over this triggered has run (or straight away when
    // the message waits), so the caller reports how far it got.
    await this.#pumpQueue(id);
    return r;
  }

  /** The queue changed outside the manager (a client edit): publish, re-evaluate. */
  queueChanged(id: string): void {
    this.#retry(id);
    this.#hooks.onOverlay(id);
    void this.#pumpQueue(id);
  }

  /** The user acted on the queue: a refused hand-over may be tried again. */
  #retry(id: string): void {
    const run = this.#running.get(id);
    if (run) run.backoff = false;
  }

  /**
   * Send now. On a running, unheld session the entry moves to the head of the
   * next tool boundary; on an idle or held one it starts a turn alone and the
   * rest stay as they are. An uncertain entry needs `confirm` — it may
   * duplicate.
   */
  sendNow(id: string, target: QueueTarget, confirm: boolean): QueueResult<QueueEntry> {
    const q = this.#hooks.queue;
    if (!q) throw new Error("this daemon has no message queue");
    if (q.entry(id, target.entryId)?.uncertain && !confirm)
      return {
        ok: false,
        code: "refused",
        message: "This message may already have reached the agent; confirm to send it again.",
      };
    const r = q.toHead(id, target);
    if (!r.ok) return r;
    const run = this.#running.get(id);
    const live = run !== undefined && !run.ended && isLiveState(run.state);
    if (!live || q.hold(id) !== null) this.#forced.set(id, target.entryId);
    this.queueChanged(id);
    return r;
  }

  /** Clear the hold; uncertain entries stay where they are. False when unheld. */
  releaseQueue(id: string): boolean {
    const q = this.#hooks.queue;
    if (!q || q.hold(id) === null) return false;
    q.setHold(id, null);
    this.queueChanged(id);
    return true;
  }

  /** The queue as the snapshot carries it; null when empty and unheld. */
  queueView(id: string): SessionQueue | null {
    const q = this.#hooks.queue;
    if (!q) return null;
    const entries = q.live(id);
    const hold = q.hold(id);
    if (entries.length === 0 && hold === null) return null;
    const hints = dequeueHints(entries, hold, this.#dispatchView(this.#running.get(id)));
    return {
      hold,
      entries: entries.map((e) => ({
        id: e.id,
        author: e.author,
        delivery: e.delivery,
        state: e.state,
        uncertain: e.uncertain,
        revision: e.revision,
        preview: e.text.slice(0, QUEUE_PREVIEW_CHARS),
        bytes: new TextEncoder().encode(e.text).length,
        dequeue: hints.get(e.id) ?? { t: "handed_over" },
      })),
    };
  }

  /** Something in the queue would be handed over now (keep-warm stays away). */
  queueDispatchable(id: string): boolean {
    const q = this.#hooks.queue;
    return q !== undefined && q.hold(id) === null && this.#hasQueued(id);
  }

  /** Entries handed over and not yet taken — undo must wait for them. */
  queueDelivering(id: string): boolean {
    return (
      this.#hooks.queue?.slots(id).some((e) => e.state === "delivering" && !e.uncertain) ?? false
    );
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
   *
   * `automated` marks Loom's own messages (nudges, hook feedback, auto-resume);
   * like a keep-warm ping, their turn's outcome is not a fleet turn boundary.
   */
  async send(
    id: string,
    text: string,
    opts: { keepWarm?: boolean; automated?: boolean; signal?: AbortSignal } = {},
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
      // Armed before the hand-off: a fast turn can report its outcome before
      // the adapter's `send()` resolves. An injection joins the live turn.
      const armed = run.userTurn;
      if (!opts.keepWarm && !opts.automated) run.userTurn = true;
      try {
        await run.session.send(text);
      } catch (err) {
        run.userTurn = armed;
        throw err;
      }
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
        // Messages that waited out the compaction go now (after this op
        // releases the gate: the hand-over queues behind it).
        void this.#pumpQueue(id);
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
    // Hold the queue first, so nothing is dispatched into the stop: after an
    // interrupt nothing queued reaches the agent until the user says so.
    const q = this.#hooks.queue;
    this.#forced.delete(id);
    if (q && q.hold(id) === null && q.live(id).length > 0) q.setHold(id, "interrupt");
    this.#hooks.onOverlay(id);
    const operation = Promise.resolve().then(async () => {
      try {
        await run.session.interrupt();
        run.cancellation = "stopped";
        run.rootTools.clear();
        // Handed over, and neither taken up nor reported discarded: whether
        // the agent saw them is unknown. A discard reported after this still
        // puts one back in the queue. (Without receipts nothing is left
        // delivering: an entry is consumed at hand-over.)
        if (q && run.inputReceipts) q.markUncertain(id);
        this.#clearOverlays(run);
        if (!run.ended && !compactOnly) {
          // A confirmed user stop is the turn's (interrupted) outcome — unless
          // a trailing result already reported one first.
          this.#turnEnded(id, run, Date.now());
          this.#transition(id, run, stateInterrupted("user"), "user");
        }
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
        void this.#pumpQueue(id);
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
    // Only a still-blocked turn resumes: an answer can also end the turn (a
    // Codex plan handoff settles it), and its result may already be drained.
    if (run.cancellation === "none" && run.state.kind === "awaiting_input") {
      let next = this.#interactionState(run, stateRunning);
      // A background child's request: the main loop is still settled.
      if (next.kind === "running" && run.blockedInBackground && run.backgroundTasks.length > 0)
        next = stateWorkingBackground;
      if (this.#transition(id, run, next)) return;
    }
    this.#hooks.onOverlay(id);
  }

  /**
   * Take outstanding request `requestId` off the set for an answer of one of
   * `kinds`. False when it is no longer outstanding. An answer of the wrong kind
   * throws and leaves the request in place: adapters park each kind separately
   * and ignore an id they don't hold under it, so consuming it here would hide
   * the prompt from every client while the turn stays blocked on it for good
   * (an `approve` aimed at an `ask_user` question did exactly that).
   */
  #claimPending(
    run: Running,
    requestId: string,
    kinds: readonly SessionInteraction["kind"][],
    action: string,
  ): boolean {
    const request = run.pending.get(requestId);
    if (!request) return false;
    if (!kinds.includes(request.kind)) {
      throw new RpcError(
        "bad_request",
        `request ${requestId} is a ${request.kind.replace("_", " ")}; it can't be resolved with ${action}`,
      );
    }
    run.pending.delete(requestId);
    return true;
  }

  async respondToPermission(
    id: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<RespondResult> {
    const run = this.#require(id);
    if (run.ended) return { ok: false, alreadyResolved: true };
    if (!this.#claimPending(run, requestId, ["permission", "user_question"], "approve or deny"))
      return { ok: false, alreadyResolved: true };
    // The user's answer drives the turn on (an approved plan can even start a
    // new SDK turn), so its outcome is theirs. Armed before the adapter call,
    // as in `send`; the same holds for questions and plan decisions. Not for
    // a background child's request: the turn its answer lets go on is not
    // the user's, and the main loop's next outcome is a CLI-driven wake-up.
    if (!run.blockedInBackground) run.userTurn = true;
    await run.session.respondToPermission(requestId, decision);
    // Optimistic: the approved tool call will confirm `running` on its own.
    this.#resumeAfterAnswer(id, run);
    return { ok: true, alreadyResolved: false };
  }

  async answerQuestion(id: string, questionId: string, text: string): Promise<RespondResult> {
    const run = this.#require(id);
    if (run.ended) return { ok: false, alreadyResolved: true };
    if (!this.#claimPending(run, questionId, ["question"], "answer"))
      return { ok: false, alreadyResolved: true };
    if (!run.blockedInBackground) run.userTurn = true;
    await run.session.answerQuestion(questionId, text);
    // The `answer` event the adapter emits will also carry status back to
    // running; set it now so a client sees the change without waiting.
    this.#resumeAfterAnswer(id, run);
    return { ok: true, alreadyResolved: false };
  }

  /**
   * Answer a `loom-agents` call. A session that has gone away meanwhile (an
   * interrupt or close already drained the call) has nothing to answer: false.
   */
  async respondToAgentCall(id: string, callId: string, result: AgentCallResult): Promise<boolean> {
    const run = this.#running.get(id);
    if (!run || run.ended || !run.session.respondToAgentCall) return false;
    await run.session.respondToAgentCall(callId, result);
    return true;
  }

  /** Tell a live session its base's new name; false when none is running
   *  (a later start or resume reads the stored base anyway). */
  async setBase(id: string, base: string): Promise<boolean> {
    const run = this.#running.get(id);
    if (!run || run.ended || !run.session.setBase) return false;
    await run.session.setBase(base);
    return true;
  }

  async respondToPlan(
    id: string,
    requestId: string,
    decision: PlanDecision,
  ): Promise<RespondResult> {
    const run = this.#require(id);
    if (run.ended) return { ok: false, alreadyResolved: true };
    if (!this.#claimPending(run, requestId, ["plan_review"], "review"))
      return { ok: false, alreadyResolved: true };
    if (!run.blockedInBackground) run.userTurn = true;
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
        // reportedRef=null) and starts its own drain.
        this.#attach(newProvider, id, session, stateIdle, undefined, ref.mode);
      } catch (err) {
        this.#running.delete(id);
        throw err;
      } finally {
        run.restructuring = null;
        run.restructuringSince = null;
        this.#hooks.onOverlay(id);
        // The queue survives the swap; the new adapter takes it from here.
        void this.#pumpQueue(id);
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
        if (this.#running.get(id) === run) {
          // The rewind may have moved the provider onto another native session
          // (Claude resumes a fork) with no event for the drain to notice yet.
          // The rewind itself has happened; a store hiccup here must not
          // report it as failed.
          try {
            this.#trackRef(id, run);
          } catch (err) {
            this.#hooks.log.error("provider ref persist failed after rewind", {
              id,
              err: err instanceof Error ? err.message : String(err),
            });
          }
          this.#transition(id, run, stateIdle, "rewind");
        }
      } finally {
        run.restructuring = null;
        run.restructuringSince = null;
        this.#hooks.onOverlay(id);
        run.rewinding = false;
        void this.#pumpQueue(id);
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
      ![...run.subagents.values()].some((s) => s.active) &&
      // Input handed over and not yet taken would go with the adapter.
      !this.queueDelivering(id)
    );
  }

  async suspendIdle(id: string): Promise<boolean> {
    if (!this.canRefresh(id)) return false;
    const run = this.#require(id);
    run.ended = true;
    try {
      await this.close(id, "idle_suspension");
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
  async close(id: string, reason: HostStopReason = "session_close"): Promise<void> {
    const run = this.#running.get(id);
    if (!run) return;
    run.closing = true;
    await run.session.close(reason);
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
        run.closing = true;
        try {
          await run.session.close("daemon_shutdown");
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
