/**
 * The message queue's dispatch policy (spec: `docs/message-queue.md`, "Dispatch").
 * Pure: given a session's live entries, its hold and what its run is doing,
 * say what to hand the agent now — and, for the snapshot, when each entry
 * will go. The session manager re-evaluates it after every event, state
 * transition, queue mutation and hand-over, and carries out what it says.
 */
import type { DequeueHint, QueueEntry, QueueHold } from "@loom/core/message-queue";
import type { SessionState } from "@loom/core/session-state";

/** What the policy reads off a session's run. */
export interface DispatchView {
  /** A live adapter is attached; nothing reaches a cold session. */
  readonly attached: boolean;
  readonly state: SessionState;
  /** A compaction, rewind or provider swap holds the op gate. */
  readonly restructuring: boolean;
  /** A stop is in flight, or failed and must be retried first. */
  readonly cancelling: boolean;
  /** A hand-over is on the wire. */
  readonly handingOver: boolean;
  /** The name of a root tool call in flight (no result yet), or null. */
  readonly rootTool: string | null;
  /** The provider refused a hand-over and the state has not moved since: a
   *  retry now would be refused the same way. */
  readonly backoff: boolean;
}

export type QueueAction =
  | { readonly t: "none" }
  /** Hand `ids` over in order. `fresh`: they start a turn (the first starts
   *  it, the rest join it); otherwise they go into the live one. */
  | { readonly t: "handover"; readonly ids: readonly string[]; readonly fresh: boolean };

const NONE: QueueAction = { t: "none" };

/** The turn is over: nothing of the root agent's is running. A failed turn
 *  counts — a message starts the next one, as a send always has; the entries
 *  that were waiting when it failed are held (`crash`) by the manager. */
const turnEnded = (s: SessionState): boolean =>
  s.kind === "idle" ||
  s.kind === "interrupted" ||
  s.kind === "working_background" ||
  s.kind === "error";

/** Rule 1: states in which nothing is handed over at all. */
const blocked = (v: DispatchView): boolean =>
  !v.attached ||
  v.handingOver ||
  v.restructuring ||
  v.cancelling ||
  v.backoff ||
  v.state.kind === "starting" ||
  v.state.kind === "awaiting_input";

/**
 * What to hand over now.
 *
 * `forced` is an entry the user asked to go now — send now, or a message sent
 * to a held queue. It goes alone and ignores the hold: into the live turn
 * straight away, or as a fresh turn of its own.
 *
 * Otherwise, unheld:
 * - rule 2, a root tool in flight: every queued `next_boundary` entry, to be
 *   folded in at that tool's boundary;
 * - rule 3, the model only writing: nothing — entries stay editable;
 * - rule 4, the turn ended: every queued `next_boundary` entry, as one fresh
 *   turn;
 * - rule 5, settled with none of those left (idle, or a turn that was
 *   stopped or failed — not background work): the head `end_of_turn` entry,
 *   one per finish (the turn it starts makes the next finish a new one).
 */
export const nextAction = (
  entries: readonly QueueEntry[],
  hold: QueueHold | null,
  view: DispatchView,
  forced: string | null = null,
): QueueAction => {
  if (blocked(view)) return NONE;
  const queued = entries.filter((e) => e.state === "queued");
  const push = forced === null ? undefined : queued.find((e) => e.id === forced);
  if (push) return { t: "handover", ids: [push.id], fresh: turnEnded(view.state) };
  if (hold !== null) return NONE;
  const boundary = queued.filter((e) => e.delivery === "next_boundary").map((e) => e.id);
  if (view.state.kind === "running")
    return view.rootTool !== null && boundary.length > 0
      ? { t: "handover", ids: boundary, fresh: false }
      : NONE;
  if (!turnEnded(view.state)) return NONE;
  if (boundary.length > 0) return { t: "handover", ids: boundary, fresh: true };
  // "When the agent has finished" is ⌥q's old meaning: settled, background
  // work included — a stopped or failed turn has finished too.
  const last = queued.find((e) => e.delivery === "end_of_turn");
  return view.state.kind !== "working_background" && last
    ? { t: "handover", ids: [last.id], fresh: true }
    : NONE;
};

/** When each live entry will go, by id — what every client shows beside it. */
export const dequeueHints = (
  entries: readonly QueueEntry[],
  hold: QueueHold | null,
  view: DispatchView,
): Map<string, DequeueHint> => {
  const out = new Map<string, DequeueHint>();
  let ahead = 0;
  const live = view.state.kind === "running" || view.state.kind === "starting";
  for (const e of entries) {
    let hint: DequeueHint;
    if (e.state !== "queued") hint = { t: "handed_over" };
    else if (!view.attached) hint = { t: "session_stopped" };
    else if (hold !== null) hint = { t: "held", reason: hold };
    else if (view.state.kind === "awaiting_input") hint = { t: "after_request" };
    else if (view.restructuring) hint = { t: "after_compaction" };
    else if (e.delivery === "end_of_turn") hint = { t: "turn_end", ahead: ahead++ };
    else if (live && view.rootTool !== null) hint = { t: "tool_boundary", tool: view.rootTool };
    else if (live) hint = { t: "next_tool_or_turn_end" };
    else hint = { t: "turn_end", ahead: 0 };
    out.set(e.id, hint);
  }
  return out;
};
