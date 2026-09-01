/**
 * A session's turn state as one closed union (design spec §4). The client never
 * sets it; the daemon derives it from the adapter's `HarnessEvent` stream
 * (`deriveStatus`) and every consumer — the wire snapshot, the DB row, the
 * TUI — reads the same shape. Each variant carries exactly its own payload, so
 * "blocked but on nothing" or "running but with a permission reason" cannot be
 * represented.
 *
 * The `kind` strings are deliberately the ones the old flat `SessionStatus`
 * enum used, so DB values and `Record<kind, …>` lookups carry over unchanged.
 *
 * An audit *note* (`"rewind"`, `"resumed"`, `"marked_done"`, …) is not part of
 * the machine — it rides a transition as a human breadcrumb on the
 * `status_changed` event and the `status_history` row.
 */
import { absurd } from "./absurd.ts";
import type { AwaitReason } from "./events.ts";

export type SessionState =
  | { readonly kind: "starting" }
  | { readonly kind: "running" }
  | { readonly kind: "awaiting_input"; readonly on: AwaitReason }
  | { readonly kind: "interrupted"; readonly by: "user" | "stream_ended" }
  | { readonly kind: "idle" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "done" };

export type SessionStateKind = SessionState["kind"];

export const stateStarting: SessionState = { kind: "starting" };
export const stateRunning: SessionState = { kind: "running" };
export const stateIdle: SessionState = { kind: "idle" };
export const stateDone: SessionState = { kind: "done" };
export const stateAwaitingInput = (on: AwaitReason): SessionState => ({
  kind: "awaiting_input",
  on,
});
export const stateInterrupted = (by: "user" | "stream_ended"): SessionState => ({
  kind: "interrupted",
  by,
});
export const stateError = (message: string): SessionState => ({ kind: "error", message });

interface FoldSessionState<B> {
  readonly onStarting: () => B;
  readonly onRunning: () => B;
  readonly onAwaitingInput: (on: AwaitReason) => B;
  readonly onInterrupted: (by: "user" | "stream_ended") => B;
  readonly onIdle: () => B;
  readonly onError: (message: string) => B;
  readonly onDone: () => B;
}

export const foldSessionState =
  <B>(fns: FoldSessionState<B>) =>
  (s: SessionState): B => {
    switch (s.kind) {
      case "starting":
        return fns.onStarting();
      case "running":
        return fns.onRunning();
      case "awaiting_input":
        return fns.onAwaitingInput(s.on);
      case "interrupted":
        return fns.onInterrupted(s.by);
      case "idle":
        return fns.onIdle();
      case "error":
        return fns.onError(s.message);
      case "done":
        return fns.onDone();
      default:
        return absurd(s);
    }
  };

/** `starting` / `running` / `awaiting_input` — a turn that hasn't settled. */
export const isLiveState = (s: SessionState): boolean =>
  s.kind === "starting" || s.kind === "running" || s.kind === "awaiting_input";

/** Same-state check for de-duping transitions (kind + payload). */
export const sameSessionState = (a: SessionState, b: SessionState): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "awaiting_input" && b.kind === "awaiting_input") return a.on === b.on;
  if (a.kind === "interrupted" && b.kind === "interrupted") return a.by === b.by;
  if (a.kind === "error" && b.kind === "error") return a.message === b.message;
  return true;
};

/** A short human label, e.g. `awaiting_input · permission`. For CLI / logs. */
export const sessionStateLabel = (s: SessionState): string =>
  foldSessionState<string>({
    onStarting: () => "starting",
    onRunning: () => "running",
    onAwaitingInput: (on) => `awaiting_input · ${on}`,
    onInterrupted: (by) => `interrupted · ${by}`,
    onIdle: () => "idle",
    onError: (message) => (message ? `error · ${message}` : "error"),
    onDone: () => "done",
  })(s);

/**
 * Reconstruct a state from its persisted `(kind, detail)` columns. Total and
 * defensive — an unknown kind or a payload variant with no persisted detail
 * (a legacy row) falls back rather than throwing.
 */
export const parseSessionState = (kind: string, detail: string | null): SessionState => {
  switch (kind) {
    case "starting":
      return stateStarting;
    case "running":
      return stateRunning;
    case "idle":
      return stateIdle;
    case "done":
      return stateDone;
    case "awaiting_input":
      return stateAwaitingInput(isAwaitReason(detail) ? detail : "permission");
    case "interrupted":
      return stateInterrupted(detail === "stream_ended" ? "stream_ended" : "user");
    case "error":
      return stateError(detail ?? "");
    default:
      return stateIdle;
  }
};

/** The payload half persisted alongside `kind` in the `status_detail` column. */
export const sessionStateDetail = (s: SessionState): string | null =>
  foldSessionState<string | null>({
    onStarting: () => null,
    onRunning: () => null,
    onAwaitingInput: (on) => on,
    onInterrupted: (by) => by,
    onIdle: () => null,
    onError: (message) => message,
    onDone: () => null,
  })(s);

const isAwaitReason = (s: string | null): s is AwaitReason =>
  s === "permission" || s === "question" || s === "plan_review" || s === "user_question";
