/**
 * A session's queue, hand-over, hold and supervision state as one value, and
 * the one transition over it: `step(machine, event, world) → { machine,
 * effects }` (docs/message-queue.md, "Holds"; docs/loom-agents.md,
 * "Communication"). Pure and total. `world` is what the machine reads but
 * does not own — the queue's live entries, without text, and what the run is
 * doing; the session manager reads it, steps, keeps the new machine and runs
 * the effects.
 */
import { absurd } from "@loom/core/absurd";
import { isAgentAuthor } from "@loom/core/agents";
import type { QueueEntryState, QueueHold, QueueHoldCause } from "@loom/core/message-queue";
import {
  isLiveState,
  sameSessionState,
  type SessionState,
  type StopCause,
} from "@loom/core/session-state";
import type { QueueSlot } from "../store/message-queue.ts";
import { nextAction, type DispatchView } from "./message-queue.ts";

/** A hold: one row of the Holds table each. */
export type Hold =
  | { readonly kind: "free" }
  /** The supervisor's stop: `agent_interrupt`, `agent_stop`, a compaction it stopped. */
  | { readonly kind: "supervisor" }
  /** Loom's own: a discard put back with no one's stop under way (`interrupt`),
   *  a crash, a restart, a doubtful hand-over. */
  | { readonly kind: "loom"; readonly reason: QueueHold }
  /** The user's stop — or a hold the user's stop landed on, which keeps its reason (H1). */
  | { readonly kind: "user"; readonly reason: QueueHold };

/** Who a queued message is from (H2): a person, a Loom supervisor, a child's report. */
export type Sender = "user" | "supervisor" | "child";

/** What undoes a hold change (H5, H6): the hold before it, and the write it was. */
export interface HoldTicket {
  readonly prior: Hold;
  readonly write: number;
}

/** An entry that goes ahead of the ordinary rules. Runtime-only: a restart forgets it. */
export type Push =
  | { readonly kind: "none" }
  /** Goes next and alone whatever the hold (H3, H4): a message that lifted a
   *  hold, or send now on a settled or held session. `now`: sent now. */
  | { readonly kind: "forced"; readonly entryId: string; readonly now: boolean }
  /** Send now on a live, unheld turn: at the head, handed in marked `now`. */
  | { readonly kind: "now"; readonly entryId: string };

/** The hand-over. `op` names one trip through the op gate; a stale one's events are ignored. */
export type Delivery =
  | { readonly kind: "ready" }
  /** The provider refused a hand-over: none until the run moves or the user acts. */
  | { readonly kind: "backoff" }
  | { readonly kind: "scheduled"; readonly op: number }
  /** On the gate, `ids` go in order; `at` is the one on the wire. */
  | {
      readonly kind: "handing_over";
      readonly op: number;
      readonly ids: readonly string[];
      readonly fresh: boolean;
      readonly at: number;
    };

/**
 * The stops asked of this run. `by`: whom the current turn's end is
 * attributed to, until the next turn starts (the user over a supervisor).
 * `lifted`: the latest stop's hold was lifted and nothing has held since, so
 * a discard it reports late holds nothing (H1).
 */
export type Stop =
  | { readonly kind: "none" }
  | { readonly kind: "holding"; readonly by: StopCause | null }
  | { readonly kind: "lifted"; readonly by: StopCause | null };

/** Which state spell the session is in: every status write that changes the
 *  state starts a new one, so a settled turn has an identity its next turn —
 *  and a second failure — does not share. */
export type Spell =
  | { readonly kind: "unwritten" }
  | { readonly kind: "in"; readonly state: SessionState; readonly turn: number };

/** As a Loom agent's child: its supervisor's report of its settled turns. */
export type Report =
  | { readonly kind: "idle"; readonly last: number | null }
  /** Decided on, its facts being read; not yet in the supervisor's queue. */
  | { readonly kind: "making"; readonly turn: number };

export interface QueueMachine {
  readonly hold: Hold;
  /** Writes of the hold so far: a ticket undoes only the write it came from. */
  readonly write: number;
  readonly push: Push;
  readonly delivery: Delivery;
  /** Gate trips so far. */
  readonly ops: number;
  readonly stop: Stop;
  /** A clone's guest Git runs for the daemon (H7). */
  readonly busy: boolean;
  readonly spell: Spell;
  readonly report: Report;
}

/** What the policy reads off the run. A cold session is not `attached`. */
export interface RunView {
  readonly attached: boolean;
  readonly state: SessionState;
  readonly restructuring: boolean;
  readonly cancelling: boolean;
  readonly rootTool: string | null;
  readonly inputReceipts: boolean;
  /** A start, idle shutdown or environment refresh is under way: a message
   *  that goes waits it out as for a cold session. */
  readonly lifecycle: boolean;
}

export interface World {
  readonly slots: readonly QueueSlot[];
  readonly run: RunView;
}

/**
 * What a stop is of. `turn`: the run's turn, whose end is then theirs (the
 * user's over a supervisor's). `session`: one no turn hears of — a session
 * still starting, a cold one. `compaction`: a compaction cancelled on a
 * settled session, which stops no turn.
 */
export type StopScope = "turn" | "session" | "compaction";

/** Whether a stop of each scope is what the turn ends in, and whether the
 *  user's holds an empty queue (anyone's holds one where entries wait). */
const STOP_SCOPE: Record<
  StopScope,
  { readonly attributed: boolean; readonly userHoldsEmpty: boolean }
> = {
  turn: { attributed: true, userHoldsEmpty: true },
  session: { attributed: false, userHoldsEmpty: true },
  compaction: { attributed: false, userHoldsEmpty: false },
};

export type SendOutcome =
  | { readonly kind: "ok" }
  /** Refused: nothing went out. */
  | { readonly kind: "refused"; readonly message: string }
  /** It may have arrived (`DeliveryUncertainError`). */
  | { readonly kind: "uncertain"; readonly message: string }
  /** The adapter was replaced while it went. */
  | { readonly kind: "detached" };

export type QueueEvent =
  /** A message stored (`created`) or found again. Its place — at the head
   *  when it lifts — was {@link messageWaits}' answer. */
  | {
      readonly kind: "message";
      readonly entryId: string;
      readonly sender: Sender;
      readonly created: boolean;
      readonly state: QueueEntryState;
    }
  /** Its revival failed (H5): take the message back and restore the hold. */
  | {
      readonly kind: "message_withdrawn";
      readonly entryId: string;
      readonly ticket: HoldTicket | null;
    }
  | { readonly kind: "release" }
  /** Send now, the entry already at the head. */
  | { readonly kind: "send_now"; readonly entryId: string }
  /** A client changed the queue, or asked it to go: a refused hand-over may be retried. */
  | { readonly kind: "touched" }
  /** `by` asked for a stop: an interrupt (`interrupt`: what was pushed
   *  ahead is no longer), joining one, a close. See {@link STOP_SCOPE}. */
  | {
      readonly kind: "stop";
      readonly by: StopCause;
      readonly scope: StopScope;
      readonly interrupt: boolean;
    }
  /** The close or archive that stop was part of did not happen (H6). */
  | { readonly kind: "stop_undone"; readonly ticket: HoldTicket }
  /** The adapter confirmed the stop. */
  | { readonly kind: "interrupt_stopped" }
  | { readonly kind: "attached" }
  /** Something the policy reads off the run may have moved. */
  | { readonly kind: "run_moved" }
  | { readonly kind: "status_moved"; readonly from: SessionState; readonly to: SessionState }
  /** Loom's own message went straight to the adapter. */
  | { readonly kind: "direct_send" }
  | { readonly kind: "busy"; readonly busy: boolean }
  /** A fatal root error, or the stream ending unexpectedly. */
  | { readonly kind: "crashed" }
  /** The daemon started with entries left `delivering`. */
  | { readonly kind: "restart_recovered" }
  | { readonly kind: "consumed"; readonly entryId: string; readonly midTurn: boolean }
  | { readonly kind: "discarded"; readonly refs: readonly string[] }
  | { readonly kind: "gate_reached"; readonly op: number }
  | {
      readonly kind: "sent";
      readonly op: number;
      readonly entryId: string;
      readonly outcome: SendOutcome;
    }
  /** The gate trip is over, however it went. */
  | { readonly kind: "handover_ended"; readonly op: number }
  | { readonly kind: "status_written"; readonly state: SessionState }
  /** A turn settled in `state` as spell `turn`; `cause`, who asked it to stop. */
  | {
      readonly kind: "turn_settled";
      readonly turn: number;
      readonly state: SessionState;
      readonly cause: StopCause | null;
      readonly supervisor: "none" | "gone" | "live";
    }
  /** Its report's facts are read. */
  | { readonly kind: "report_ready"; readonly turn: number };

export type QueueEffect =
  | { readonly kind: "persist_hold"; readonly hold: Hold }
  | { readonly kind: "publish" }
  /** Bring the cold session back for the message just queued (H2). */
  | { readonly kind: "revive" }
  | { readonly kind: "schedule_handover"; readonly op: number }
  | { readonly kind: "mark_delivering"; readonly ids: readonly string[] }
  | {
      readonly kind: "send";
      readonly op: number;
      readonly entryId: string;
      readonly midTurn: boolean;
      readonly now: boolean;
    }
  | { readonly kind: "requeue"; readonly ids: readonly string[] }
  | { readonly kind: "mark_uncertain"; readonly ids: readonly string[] }
  | { readonly kind: "consume"; readonly entryId: string; readonly midTurn: boolean }
  | { readonly kind: "withdraw"; readonly entryId: string }
  /** A non-fatal error on the session. */
  | { readonly kind: "warn"; readonly message: string }
  | { readonly kind: "make_report"; readonly turn: number; readonly state: SessionState }
  | { readonly kind: "send_report"; readonly turn: number };

export interface Stepped {
  readonly machine: QueueMachine;
  readonly effects: readonly QueueEffect[];
}

export const initialMachine = (hold: Hold): QueueMachine => ({
  hold,
  write: 0,
  push: { kind: "none" },
  delivery: { kind: "ready" },
  ops: 0,
  stop: { kind: "none" },
  busy: false,
  spell: { kind: "unwritten" },
  report: { kind: "idle", last: null },
});

// ---------------------------------------------------------------------------
// holds
// ---------------------------------------------------------------------------

const FREE: Hold = { kind: "free" };
const PUBLISH: QueueEffect = { kind: "publish" };

/**
 * H2, decided once as a message is queued: does it wait behind the hold
 * (true) or lift it (false)? The user's send lifts any; a supervisor's
 * message any but the user's; a child's report none.
 */
const WAITS: Record<Hold["kind"], Record<Sender, boolean>> = {
  free: { user: false, supervisor: false, child: false },
  user: { user: false, supervisor: true, child: true },
  supervisor: { user: false, supervisor: false, child: true },
  loom: { user: false, supervisor: false, child: true },
};

export const messageWaits = (hold: Hold, sender: Sender): boolean => WAITS[hold.kind][sender];

/** The reason as the wire and the dispatch policy carry it. */
export const holdReason = (h: Hold): QueueHold | null => {
  switch (h.kind) {
    case "free":
      return null;
    case "supervisor":
      return "interrupt";
    case "loom":
    case "user":
      return h.reason;
    default:
      return absurd(h);
  }
};

export const holdCause = (h: Hold): QueueHoldCause | null => {
  const reason = holdReason(h);
  if (reason === null) return null;
  const by: Record<Hold["kind"], QueueHoldCause["by"]> = {
    free: null,
    supervisor: "supervisor",
    loom: null,
    user: "user",
  };
  return { reason, by: by[h.kind] };
};

const sameHold = (a: Hold, b: Hold): boolean =>
  a.kind === b.kind && holdReason(a) === holdReason(b);

/** Whose stop sets which hold on a free queue. */
const STOP_HOLD: Record<StopCause | "loom", Hold> = {
  user: { kind: "user", reason: "interrupt" },
  supervisor: { kind: "supervisor" },
  loom: { kind: "loom", reason: "interrupt" },
};

/**
 * H1. A stop by `by` (null: no one's, a requeued discard) on `hold`. On a free
 * queue it holds while entries wait, or `empty`, even without; a hold
 * already set keeps its reason, and only the user's stop changes anything
 * about it — it becomes the user's.
 */
const stopOn = (hold: Hold, by: StopCause | null, holds: boolean): Hold => {
  if (hold.kind === "free") return holds ? STOP_HOLD[by ?? "loom"] : FREE;
  if (by !== "user" || hold.kind === "user") return hold;
  return { kind: "user", reason: holdReason(hold) ?? "interrupt" };
};

/** H1: Loom's own hold sets a free queue, and never changes one already set. */
const loomOn = (hold: Hold, reason: Exclude<QueueHold, "interrupt">): Hold =>
  hold.kind === "free" ? { kind: "loom", reason } : hold;

interface Draft {
  readonly machine: QueueMachine;
  readonly effects: readonly QueueEffect[];
  /** Re-evaluate the dispatch policy after this transition. */
  readonly evaluate: boolean;
}

const done = (machine: QueueMachine, effects: readonly QueueEffect[] = []): Draft => ({
  machine,
  effects,
  evaluate: false,
});
const thenEvaluate = (machine: QueueMachine, effects: readonly QueueEffect[] = []): Draft => ({
  machine,
  effects,
  evaluate: true,
});

/**
 * The one write of the hold. A write is a change — or `reasserted`, the
 * user's stop on the user's hold: either voids older tickets. Anything else
 * that leaves the hold as it was writes nothing (H6). A hold that is set
 * afterwards drops a forced entry not yet handed over, unless `keepForced`
 * (H3); a change lifts or re-holds the latest stop (H1).
 */
const writeHold = (
  m: QueueMachine,
  next: Hold,
  opts: { readonly reasserted: boolean; readonly keepForced: boolean },
): Stepped => {
  const changed = !sameHold(m.hold, next);
  const wrote = changed || opts.reasserted;
  const held = next.kind !== "free";
  const stop: Stop =
    !changed || m.stop.kind === "none"
      ? m.stop
      : { kind: held ? "holding" : "lifted", by: m.stop.by };
  const push: Push = held && !opts.keepForced ? unforced(m.push) : m.push;
  return {
    machine: { ...m, hold: next, write: wrote ? m.write + 1 : m.write, stop, push },
    effects: changed ? [{ kind: "persist_hold", hold: next }, { kind: "publish" }] : [],
  };
};

/** H3: a forced entry waits with the rest; sent now, it keeps its mark. */
const unforced = (p: Push): Push => {
  if (p.kind !== "forced") return p;
  return p.now ? { kind: "now", entryId: p.entryId } : { kind: "none" };
};

/** Lift whatever hold is set (the message or release decided it lifts). */
const lift = (m: QueueMachine): Stepped =>
  writeHold(m, FREE, { reasserted: false, keepForced: false });

/** Undo the change `ticket` came from, unless the hold was written since. */
const restore = (m: QueueMachine, ticket: HoldTicket | null): Stepped =>
  ticket !== null && ticket.write === m.write
    ? writeHold(m, ticket.prior, { reasserted: false, keepForced: false })
    : { machine: m, effects: [] };

/** The ticket that undoes the hold change from `before` to `after`. */
export const holdTicket = (before: QueueMachine, after: QueueMachine): HoldTicket => ({
  prior: before.hold,
  write: after.write,
});

// ---------------------------------------------------------------------------
// entries
// ---------------------------------------------------------------------------

const deliveringIds = (slots: readonly QueueSlot[], certain: boolean): string[] =>
  slots.filter((s) => s.state === "delivering" && (!certain || !s.uncertain)).map((s) => s.id);

/** A queue entry a person wrote, not a Loom agent's or supervisor's message. */
const writtenByUser = (author: string): boolean =>
  !isAgentAuthor(author) && !author.startsWith("supervisor:");

/** The slots as they are once `effects` ran: the policy decides on those. */
const afterEffects = (slots: readonly QueueSlot[], effects: readonly QueueEffect[]): QueueSlot[] =>
  effects.reduce<QueueSlot[]>(
    (acc, e) => {
      const set = (ids: readonly string[], patch: Partial<QueueSlot>) =>
        acc.map((s) => (ids.includes(s.id) ? { ...s, ...patch } : s));
      switch (e.kind) {
        case "mark_delivering":
          return set(e.ids, { state: "delivering", uncertain: false });
        case "requeue":
          return set(
            e.ids.filter((id) => acc.some((s) => s.id === id && s.state === "delivering")),
            { state: "queued", uncertain: false },
          );
        case "mark_uncertain":
          return set(e.ids, { uncertain: true });
        case "consume":
          return acc.filter((s) => s.id !== e.entryId);
        case "withdraw":
          return acc.filter((s) => s.id !== e.entryId || s.state !== "queued");
        default:
          return acc;
      }
    },
    [...slots],
  );

// ---------------------------------------------------------------------------
// the transition
// ---------------------------------------------------------------------------

const pushedId = (p: Push): string | null => (p.kind === "none" ? null : p.entryId);

const dispatchView = (m: QueueMachine, run: RunView, handingOver: boolean): DispatchView => ({
  attached: run.attached,
  state: run.state,
  restructuring: run.restructuring,
  cancelling: run.cancelling,
  rootTool: run.rootTool,
  handingOver,
  backoff: m.delivery.kind === "backoff",
  busy: m.busy,
});

/** Hand entry `at` of the trip over; the stop it may follow is no longer the turn's. */
const sendAt = (
  m: QueueMachine,
  d: Extract<Delivery, { kind: "handing_over" }>,
  slots: readonly QueueSlot[],
): Stepped => {
  const entryId = d.ids[d.at] ?? "";
  const midTurn = !d.fresh || d.at > 0;
  const author = slots.find((s) => s.id === entryId)?.author ?? "";
  const sentNow =
    (m.push.kind === "now" || (m.push.kind === "forced" && m.push.now)) &&
    m.push.entryId === entryId;
  return {
    machine: {
      ...m,
      delivery: d,
      stop: m.stop.kind === "none" ? m.stop : { ...m.stop, by: null },
    },
    effects: [
      {
        kind: "send",
        op: d.op,
        entryId,
        midTurn,
        now: midTurn && sentNow && writtenByUser(author),
      },
    ],
  };
};

/** One send's outcome; the trip goes on, or ends. */
const onSent = (
  m: QueueMachine,
  d: Extract<Delivery, { kind: "handing_over" }>,
  ev: Extract<QueueEvent, { kind: "sent" }>,
  world: World,
): Draft => {
  const rest = d.ids.slice(d.at + 1);
  const midTurn = !d.fresh || d.at > 0;
  const outcome = ev.outcome;
  switch (outcome.kind) {
    case "ok": {
      const push: Push = pushedId(m.push) === ev.entryId ? { kind: "none" } : m.push;
      // Without receipts the hand-over is all the evidence there will be.
      const consume: QueueEffect[] = world.run.inputReceipts
        ? []
        : [{ kind: "consume", entryId: ev.entryId, midTurn }];
      if (rest.length > 0) {
        const next = sendAt({ ...m, push }, { ...d, at: d.at + 1 }, world.slots);
        return done(next.machine, [...consume, ...next.effects]);
      }
      return thenEvaluate({ ...m, push, delivery: { kind: "ready" } }, [
        ...consume,
        { kind: "publish" },
      ]);
    }
    case "refused":
      // Folding into a turn that just ended is refused routinely (Codex's
      // `expectedTurnId`); a refused turn start is worth saying.
      return done({ ...m, delivery: { kind: "backoff" } }, [
        { kind: "requeue", ids: [ev.entryId, ...rest] },
        ...(midTurn ? [] : [{ kind: "warn", message: outcome.message } as const]),
        { kind: "publish" },
      ]);
    case "uncertain": {
      // It may have arrived: never retried by itself — the user decides.
      const held = writeHold({ ...m, delivery: { kind: "ready" } }, loomOn(m.hold, "rejected"), {
        reasserted: false,
        keepForced: false,
      });
      return thenEvaluate(held.machine, [
        { kind: "mark_uncertain", ids: [ev.entryId] },
        { kind: "requeue", ids: rest },
        ...held.effects,
        {
          kind: "warn",
          message: `A queued message may not have reached the agent (${outcome.message}); the queue is held — review it with q.`,
        },
        { kind: "publish" },
      ]);
    }
    case "detached":
      return done({ ...m, delivery: { kind: "ready" } }, [
        { kind: "requeue", ids: rest },
        { kind: "publish" },
      ]);
    default:
      return absurd(outcome);
  }
};

/** The settled states a supervisor hears of; not a wait, which the user answers. */
const REPORTED: Record<SessionState["kind"], boolean> = {
  idle: true,
  error: true,
  interrupted: true,
  starting: false,
  running: false,
  working_background: false,
  awaiting_input: false,
  done: false,
};

const reported = (r: Report, turn: number): boolean =>
  r.kind === "making" ? r.turn === turn : r.last === turn;

const transition = (m: QueueMachine, ev: QueueEvent, world: World): Draft => {
  const { slots, run } = world;
  switch (ev.kind) {
    case "message": {
      const waits = messageWaits(m.hold, ev.sender);
      const cold = !run.attached || run.lifecycle;
      const revive: QueueEffect[] =
        cold && !waits && ev.state === "queued" ? [{ kind: "revive" }] : [];
      if (!ev.created) return done(m, revive);
      const ready: QueueMachine =
        m.delivery.kind === "backoff" ? { ...m, delivery: { kind: "ready" } } : m;
      if (waits || m.hold.kind === "free") return done(ready, [{ kind: "publish" }, ...revive]);
      // It lifts the hold and goes first, alone.
      const lifted = lift(ready);
      return done(
        { ...lifted.machine, push: { kind: "forced", entryId: ev.entryId, now: false } },
        [...lifted.effects, { kind: "publish" }, ...revive],
      );
    }
    case "message_withdrawn": {
      // Handed over meanwhile: it went, and the lift stands.
      if (!slots.some((s) => s.id === ev.entryId && s.state === "queued")) return done(m);
      const push: Push = pushedId(m.push) === ev.entryId ? { kind: "none" } : m.push;
      const restored = restore({ ...m, push }, ev.ticket);
      return done(restored.machine, [
        { kind: "withdraw", entryId: ev.entryId },
        ...restored.effects,
        { kind: "publish" },
      ]);
    }
    case "release": {
      if (m.hold.kind === "free") return done(m);
      const lifted = lift(m);
      return thenEvaluate({ ...lifted.machine, delivery: retried(m.delivery) }, [
        ...lifted.effects,
        { kind: "publish" },
      ]);
    }
    case "send_now": {
      const live = run.attached && isLiveState(run.state);
      const push: Push =
        !live || m.hold.kind !== "free"
          ? { kind: "forced", entryId: ev.entryId, now: true }
          : { kind: "now", entryId: ev.entryId };
      return thenEvaluate({ ...m, push, delivery: retried(m.delivery) }, [{ kind: "publish" }]);
    }
    case "touched":
      return thenEvaluate({ ...m, delivery: retried(m.delivery) }, [{ kind: "publish" }]);
    case "stop": {
      const was = m.stop.kind === "none" ? null : m.stop.by;
      const scope = STOP_SCOPE[ev.scope];
      const by = !scope.attributed || was === "user" ? was : ev.by;
      const asked: QueueMachine = {
        ...m,
        stop: { kind: "holding", by },
        push: ev.interrupt ? { kind: "none" } : m.push,
      };
      const holds = (scope.userHoldsEmpty && ev.by === "user") || slots.length > 0;
      const held = writeHold(asked, stopOn(m.hold, ev.by, holds), {
        // The user's stop is a write even when it changes nothing: no older
        // change is undone past it (H6).
        reasserted: ev.by === "user",
        keepForced: false,
      });
      return done(held.machine, [...held.effects, ...(ev.interrupt ? [PUBLISH] : [])]);
    }
    case "stop_undone": {
      const restored = restore(m, ev.ticket);
      return done(restored.machine, restored.effects);
    }
    case "interrupt_stopped": {
      // Handed over, and neither taken up nor reported discarded: whether the
      // agent saw them is unknown. A discard reported later still puts one
      // back. (Without receipts nothing is left delivering.)
      const ids = run.inputReceipts ? deliveringIds(slots, true) : [];
      return done(m, ids.length > 0 ? [{ kind: "mark_uncertain", ids }] : []);
    }
    case "attached":
      return done({ ...m, delivery: { kind: "ready" }, stop: { kind: "none" } });
    case "run_moved":
      return thenEvaluate(m);
    case "status_moved": {
      // A turn starts, however it came about: an earlier stop is not what it ends in.
      const starts = !isLiveState(ev.from) && isLiveState(ev.to) && m.stop.kind !== "none";
      const stop: Stop = starts ? { ...m.stop, by: null } : m.stop;
      // A refused hand-over is retried once the session has moved on.
      return thenEvaluate({ ...m, stop, delivery: retried(m.delivery) });
    }
    case "direct_send":
      return done({ ...m, stop: m.stop.kind === "none" ? m.stop : { ...m.stop, by: null } });
    case "busy":
      return ev.busy || !m.busy
        ? done({ ...m, busy: ev.busy })
        : thenEvaluate({ ...m, busy: false });
    case "crashed":
    case "restart_recovered": {
      if (ev.kind === "restart_recovered" && deliveringIds(slots, true).length === 0)
        return done(m);
      if (slots.length === 0) return done(m);
      const ids = deliveringIds(slots, true);
      const held = writeHold(m, loomOn(m.hold, ev.kind === "crashed" ? "crash" : "restart"), {
        reasserted: false,
        keepForced: false,
      });
      return thenEvaluate(held.machine, [
        ...(ids.length > 0 ? [{ kind: "mark_uncertain", ids } as const] : []),
        ...held.effects,
        PUBLISH,
      ]);
    }
    case "consumed":
      return thenEvaluate(m, [
        { kind: "consume", entryId: ev.entryId, midTurn: ev.midTurn },
        PUBLISH,
      ]);
    case "discarded": {
      const back = ev.refs.filter((ref) =>
        slots.some((s) => s.id === ref && s.state === "delivering"),
      );
      if (back.length === 0) return done(m);
      const requeue: QueueEffect = { kind: "requeue", ids: back };
      // No stop of its own (H1): it belongs to the latest stop. Reported
      // after that stop's hold was lifted it holds nothing, and its entries
      // go behind what lifted it; it never drops a forced entry (H3).
      if (m.stop.kind === "lifted" || m.hold.kind !== "free")
        return thenEvaluate(m, [requeue, PUBLISH]);
      const by = m.stop.kind === "none" ? null : m.stop.by;
      const held = writeHold(m, stopOn(m.hold, by, true), {
        reasserted: false,
        keepForced: true,
      });
      return thenEvaluate(held.machine, [requeue, ...held.effects, PUBLISH]);
    }
    case "gate_reached": {
      if (m.delivery.kind !== "scheduled" || m.delivery.op !== ev.op) return done(m);
      // Things moved while it waited for the gate: decide again.
      const action = nextAction(
        slots,
        holdReason(m.hold),
        dispatchView(m, run, false),
        forcedId(m.push),
      );
      if (action.t === "none") return done({ ...m, delivery: { kind: "ready" } });
      const trip = sendAt(
        m,
        { kind: "handing_over", op: ev.op, ids: action.ids, fresh: action.fresh, at: 0 },
        slots,
      );
      // Recorded before the provider is called, so a crash in between leaves
      // them delivering — uncertain after a restart, never silently re-sent.
      return done(trip.machine, [
        { kind: "mark_delivering", ids: action.ids },
        PUBLISH,
        ...trip.effects,
      ]);
    }
    case "sent":
      return m.delivery.kind === "handing_over" &&
        m.delivery.op === ev.op &&
        m.delivery.ids[m.delivery.at] === ev.entryId
        ? onSent(m, m.delivery, ev, world)
        : done(m);
    case "handover_ended":
      return (m.delivery.kind === "scheduled" || m.delivery.kind === "handing_over") &&
        m.delivery.op === ev.op
        ? thenEvaluate({ ...m, delivery: { kind: "ready" } })
        : done(m);
    case "status_written": {
      if (m.spell.kind === "in" && sameSessionState(m.spell.state, ev.state)) return done(m);
      const turn = m.spell.kind === "in" ? m.spell.turn + 1 : 1;
      return done({ ...m, spell: { kind: "in", state: ev.state, turn } });
    }
    case "turn_settled": {
      const current =
        m.spell.kind === "in" && m.spell.turn === ev.turn && m.spell.state.kind === ev.state.kind;
      // A stop the supervisor made itself: its tool's answer already said so.
      const theirs =
        ev.cause === "supervisor" ||
        (ev.state.kind === "interrupted" && ev.state.by === "supervisor");
      if (
        ev.supervisor !== "live" ||
        !REPORTED[ev.state.kind] ||
        !current ||
        reported(m.report, ev.turn) ||
        theirs
      )
        return done(m);
      return done({ ...m, report: { kind: "making", turn: ev.turn } }, [
        { kind: "make_report", turn: ev.turn, state: ev.state },
      ]);
    }
    case "report_ready": {
      // A turn it has moved on from is reported when the one it moved on to ends.
      const current = m.spell.kind === "in" && m.spell.turn === ev.turn;
      const report: Report =
        m.report.kind === "making" && m.report.turn === ev.turn
          ? { kind: "idle", last: ev.turn }
          : m.report;
      return done({ ...m, report }, current ? [{ kind: "send_report", turn: ev.turn }] : []);
    }
    default:
      return absurd(ev);
  }
};

/** The user acted on the queue, or the run moved: a refused hand-over may go again. */
const retried = (d: Delivery): Delivery => (d.kind === "backoff" ? { kind: "ready" } : d);

const forcedId = (p: Push): string | null => (p.kind === "forced" ? p.entryId : null);

/** Dispatch rules 1–6 (docs/message-queue.md, "Dispatch") on the slots as the effects leave them. */
const evaluate = (d: Draft, world: World): Stepped => {
  const m = d.machine;
  if (!d.evaluate || m.delivery.kind !== "ready") return d;
  const action = nextAction(
    afterEffects(world.slots, d.effects),
    holdReason(m.hold),
    dispatchView(m, world.run, false),
    forcedId(m.push),
  );
  if (action.t === "none") return d;
  const op = m.ops + 1;
  return {
    machine: { ...m, ops: op, delivery: { kind: "scheduled", op } },
    effects: [...d.effects, { kind: "schedule_handover", op }],
  };
};

export const step = (m: QueueMachine, ev: QueueEvent, world: World): Stepped =>
  evaluate(transition(m, ev, world), world);
