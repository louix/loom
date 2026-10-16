/** Pure dispatch policy; SessionManager executes decisions. See docs/message-queue.md. */
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
  /** A clone's guest Git runs for the daemon (docs/message-queue.md,
   *  "Holds"): nothing goes, by any path, until it ends. */
  readonly busy: boolean;
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

/** States that block all delivery. */
const blocked = (v: DispatchView): boolean =>
  !v.attached ||
  v.handingOver ||
  v.restructuring ||
  v.cancelling ||
  v.backoff ||
  v.busy ||
  v.state.kind === "starting" ||
  v.state.kind === "awaiting_input";

/** Forced entries go alone through a hold. Otherwise send boundary entries
 * together at a root tool boundary or turn end, then one end-of-turn entry
 * per settled turn. Text generation leaves entries editable. */
export const nextAction = (
  entries: readonly Pick<QueueEntry, "id" | "state" | "delivery">[],
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
