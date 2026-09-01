/**
 * Derive a session's turn state from the adapter's event stream (design
 * spec §4). The client never sets it; the daemon runs every `HarnessEvent`
 * through this pure, total function and de-dupes unchanged transitions.
 *
 *   starting ─▶ running          (first model output)
 *   idle ─▶ running              (model output after an interim `result`)
 *   running ─▶ awaiting_input    (permission_request / question / plan_review)
 *   awaiting_input ─▶ running    (the daemon's answer/approve path, NOT this fn)
 *   running ─▶ interrupted       (user stop / stream ended — set by the manager)
 *   running ─▶ idle              (clean `result`)
 *   running ─▶ error             (fatal error, or a failed `result`)
 *
 * `interrupted` / `error` don't unwind on their own turn's trailing output or
 * `result` — only the manager's send / answer path, a fatal error, or a *new*
 * turn's blocking request (permission / question / plan) moves them on.
 */
import type { HarnessEvent } from "@loom/core/events";
import {
  type SessionState,
  stateAwaitingInput,
  stateError,
  stateIdle,
  stateRunning,
} from "@loom/core/session-state";

/** True while a turn is being torn down — its own trailing events are noise. */
const terminal = (s: SessionState): boolean => s.kind === "interrupted" || s.kind === "error";

/** The next state, or `current` unchanged. Pure and total. */
export const deriveStatus = (current: SessionState, ev: HarnessEvent): SessionState => {
  switch (ev.type) {
    case "permission_request":
      // The SDK's own AskUserQuestion tool is a multiple-choice prompt, not a
      // yes/no gate — flag it so the TUI offers "answer" instead of
      // "approve/deny". A reason change while already blocked still transitions
      // (the manager de-dupes on kind + payload).
      return stateAwaitingInput(ev.tool === "AskUserQuestion" ? "user_question" : "permission");

    case "question":
      // The agent called `ask_user` and is blocked on a human answer.
      return stateAwaitingInput("question");

    case "plan_review":
      // The agent presented a plan (ExitPlanMode) and is blocked on a decision.
      return stateAwaitingInput("plan_review");

    case "assistant_text":
    case "thinking":
    case "tool_call":
      // Fresh model output. It moves a `starting` turn to `running`, and it
      // also *heals* a session wrongly parked at `idle`: a connector can emit
      // an interim `result` and then keep streaming the same engagement — the
      // Claude adapter does this after a denied `ExitPlanMode`, around
      // `/compact`, and when a background `Task` completing re-drives the loop.
      // Those events never flow through the daemon's `send()` path, so without
      // this the turn runs to completion while every client shows IDLE.
      //
      // It must NOT pull the session out of `awaiting_input` — that transition
      // is the manager's answer / approve path (`#resumeAfterAnswer`). A
      // provider that flushes buffered assistant text *after* the
      // `permission_request` (some OpenAI-compatible endpoints do) would
      // otherwise clear the blocked state and hide the approval prompt.
      // `interrupted` / `error` stay put until the user acts.
      return current.kind === "starting" || current.kind === "idle" ? stateRunning : current;

    case "answer":
    case "tool_result":
      // Reactive plumbing, not fresh model output: only unstick a `starting`
      // turn. `answer` has its own resume path in the manager, and a stray
      // `tool_result` should never revive an otherwise-settled turn.
      return current.kind === "starting" ? stateRunning : current;

    case "result":
      // A trailing `result` from a turn the user already killed must not
      // un-stick `interrupted` (nor a settled `error`).
      if (terminal(current)) return current;
      return ev.kind === "ok" ? stateIdle : stateError(ev.error);

    case "error":
      return ev.fatal ? stateError(truncate(ev.message)) : current;

    default:
      // usage, subagent_*, status_changed, compact*, rewind, user_message,
      // rate_limit — not state-bearing on their own.
      return current;
  }
};

const truncate = (s: string): string => {
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
};
