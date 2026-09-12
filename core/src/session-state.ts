import { z } from "zod";
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
export const awaitReasonSchema = z.enum(["permission", "question", "plan_review", "user_question"]);
export type AwaitReason = z.infer<typeof awaitReasonSchema>;

export const sessionStateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("starting"),
  }),
  z.object({
    kind: z.literal("running"),
  }),
  z.object({
    kind: z.literal("awaiting_input"),
    on: awaitReasonSchema,
  }),
  z.object({
    kind: z.literal("interrupted"),
    by: z.union([z.literal("user"), z.literal("stream_ended")]),
  }),
  z.object({
    kind: z.literal("idle"),
  }),
  z.object({
    kind: z.literal("working_background"),
  }),
  z.object({
    kind: z.literal("error"),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("done"),
  }),
]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export type SessionStateKind = SessionState["kind"];

export const stateStarting: SessionState = { kind: "starting" };
export const stateRunning: SessionState = { kind: "running" };
export const stateIdle: SessionState = { kind: "idle" };
/**
 * The turn's main loop settled cleanly, but background work it spawned (an async
 * subagent, a backgrounded shell, a workflow) is still running and will re-drive
 * the session when it finishes. Distinct from `idle` so a client doesn't read
 * the session as done, and from `running` so it doesn't read as token-burning.
 * Entered only when ≥1 non-ambient background task is outstanding; left for
 * `running` on the re-drive or `idle` once the set drains.
 */
export const stateWorkingBackground: SessionState = { kind: "working_background" };
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
  readonly onWorkingBackground: () => B;
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
      case "working_background":
        return fns.onWorkingBackground();
      case "error":
        return fns.onError(s.message);
      case "done":
        return fns.onDone();
      default:
        return absurd(s);
    }
  };

/**
 * `starting` / `running` / `awaiting_input` / `working_background` — an
 * engagement that hasn't settled. `working_background` counts: the CLI process
 * is still up with work in flight that will resume the turn, so a stream that
 * ends there ended abnormally (→ `interrupted`), not cleanly.
 */
export const isLiveState = (s: SessionState): boolean =>
  s.kind === "starting" ||
  s.kind === "running" ||
  s.kind === "awaiting_input" ||
  s.kind === "working_background";

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
    onWorkingBackground: () => "working_background",
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
    case "working_background":
      // Round-trips faithfully — the daemon re-reads status from the DB on
      // every snapshot, so this is the live path, not just restart recovery.
      // A row genuinely orphaned by a crash is swept to `interrupted` by
      // `markMidRunInterrupted` on the next boot before anything reads it.
      return stateWorkingBackground;
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
    onWorkingBackground: () => null,
    onError: (message) => message,
    onDone: () => null,
  })(s);

const isAwaitReason = (s: string | null): s is AwaitReason =>
  awaitReasonSchema.safeParse(s).success;
