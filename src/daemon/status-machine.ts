/**
 * Derive session status from the adapter's event stream (design spec §4). The
 * client never sets status; the daemon runs every session's `HarnessEvent`s
 * through this pure function.
 *
 *   starting ─▶ running ⇄ awaiting_input
 *   running ─▶ interrupted        (user stop / stream ended abruptly — set directly)
 *   running ─▶ idle               (clean `result`)
 *   running ─▶ error              (fatal error, or a failed `result`)
 */
import type { HarnessEvent, SessionStatus } from "../protocol/events.ts";

export interface Derived {
  status: SessionStatus;
  reason: string | null;
}

/** The next status, or `null` when this event leaves status unchanged. */
export function deriveStatus(current: SessionStatus, ev: HarnessEvent): Derived | null {
  switch (ev.type) {
    // Return the new blocked-reason even when already `awaiting_input` — a
    // session can move permission → question → plan_review without a `running`
    // event in between, and #set propagates an awaiting_input reason change.
    case "permission_request":
      return { status: "awaiting_input", reason: "permission" };

    case "question":
      // The agent called `ask_user` and is blocked on a human answer.
      return { status: "awaiting_input", reason: "question" };

    case "plan_review":
      // The agent presented a plan (ExitPlanMode) and is blocked on a decision.
      return { status: "awaiting_input", reason: "plan_review" };

    case "answer":
    case "assistant_text":
    case "thinking":
    case "tool_call":
    case "tool_result":
      // Any model activity means the turn is live again — including the tool
      // call that follows an approved permission and the answer to a question.
      return current === "running" ? null : { status: "running", reason: null };

    case "result":
      return ev.ok ? { status: "idle", reason: "result" } : { status: "error", reason: "run_error" };

    case "error":
      return ev.fatal ? { status: "error", reason: truncate(ev.message) } : null;

    default:
      // usage, subagent_*, status_changed — not status-bearing on their own.
      return null;
  }
}

function truncate(s: string): string {
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}
