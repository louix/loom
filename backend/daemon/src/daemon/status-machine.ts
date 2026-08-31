/**
 * Derive session status from the adapter's event stream (design spec §4). The
 * client never sets status; the daemon runs every session's `HarnessEvent`s
 * through this pure function.
 *
 *   starting ─▶ running          (first model output)
 *   idle ─▶ running              (model output after an interim `result`)
 *   running ─▶ awaiting_input    (permission_request / question / plan_review)
 *   awaiting_input ─▶ running    (the daemon's answer/approve path, NOT this fn)
 *   running ─▶ interrupted       (user stop / stream ended abruptly — set directly)
 *   running ─▶ idle              (clean `result`)
 *   running ─▶ error             (fatal error, or a failed `result`)
 */
import type { HarnessEvent, SessionStatus } from "@loom/core/events";

export interface Derived {
  status: SessionStatus;
  reason: string | null;
}

/** The next status, or `null` when this event leaves status unchanged. */
export const deriveStatus = (current: SessionStatus, ev: HarnessEvent): Derived | null => {
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

    case "assistant_text":
    case "thinking":
    case "tool_call":
      // Fresh model output. It moves a `starting` turn to `running`, and it
      // also *heals* a session wrongly parked at `idle`: a connector can emit
      // an interim `result` and then keep streaming the same engagement — the
      // Claude adapter does exactly this after a denied `ExitPlanMode` (it
      // queues an "implement it now" turn itself) and around `/compact`. That
      // turn's events never flow through the daemon's `send()` path, so
      // without this the turn runs to completion while every client shows the
      // session as IDLE.
      //
      // It must NOT pull the session out of `awaiting_input` — that transition
      // is owned by the daemon's answer / approve path (`#resumeAfterAnswer`).
      // A provider that flushes buffered assistant text *after* the
      // `permission_request` (some OpenAI-compatible endpoints do) would
      // otherwise clear the blocked state and hide the approval prompt while
      // the turn is still parked on the gate. `interrupted` / `error` stay
      // sticky until the user acts.
      return current === "starting" || current === "idle"
        ? { status: "running", reason: null }
        : null;

    case "answer":
    case "tool_result":
      // Reactive plumbing, not fresh model output: only unstick a `starting`
      // turn. `answer` has its own resume path in the daemon, and a stray
      // `tool_result` should never be what revives an otherwise-settled turn.
      return current === "starting" ? { status: "running", reason: null } : null;

    case "result":
      return ev.ok
        ? { status: "idle", reason: "result" }
        : { status: "error", reason: "run_error" };

    case "error":
      return ev.fatal ? { status: "error", reason: truncate(ev.message) } : null;

    default:
      // usage, subagent_*, status_changed — not status-bearing on their own.
      return null;
  }
};

const truncate = (s: string): string => {
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
};
