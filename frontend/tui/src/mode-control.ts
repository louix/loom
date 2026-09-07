/**
 * Permission-mode selection: the mode the user has cycled to, before the daemon
 * has taken it.
 *
 * The *applied* mode lives in the session snapshot and nowhere else — nothing
 * here ever writes it, and no local value is ever substituted for it. What lives
 * here is the local half of a selection in progress: a target the user has
 * chosen (`choosing`, waiting out the debounce) or one that is on the wire
 * (`applying`, optionally with the next target behind it). Idle is the absence
 * of an entry, so there is no second way to spell "nothing is being changed".
 *
 * The chip renders both halves — `manual → plan` — which is the honest reading:
 * the session is still in `manual`, and `plan` is where it is going. Replacing
 * the applied field with the target would claim a change the daemon may yet
 * reject.
 */
import type { SessionSnapshot } from "@loom/core/wire";
import { SESSION_MODES, type SessionMode } from "@loom/core/types";
import { isAmbiguousFailure } from "@loom/client";
import { modeLabel } from "./theme.ts";

/**
 * One session's in-progress mode selection.
 *
 * `applying` carries at most one `next`: further cycling while a call is out
 * replaces it rather than queueing, because the intermediate modes of a fast
 * cycle are exactly what the debounce exists to skip.
 */
export type ModeChoice =
  /** Chosen, waiting out the debounce window before it is applied. */
  | { t: "choosing"; target: SessionMode }
  /** `session.setMode` is on the wire with `sent`; `next` is what the user has
   *  cycled to since, to be applied when this call settles. */
  | { t: "applying"; sent: SessionMode; next: SessionMode | null };

/** Per session; a session with no entry has nothing in progress. */
export type ModeChoices = Record<string, ModeChoice>;

/** The four modes cycle in the order `⇧⇥` walks them. Takes the snapshot's raw
 *  string — the wire types `mode` loosely — and starts the cycle over for
 *  anything the four don't cover. */
export const nextMode = (m: string): SessionMode =>
  SESSION_MODES[((SESSION_MODES as readonly string[]).indexOf(m) + 1) % SESSION_MODES.length] ??
  "default";

/** Where a choice is heading — the last mode the user asked for, which is the
 *  one the next `⇧⇥` cycles on from. */
export const targetOf = (c: ModeChoice | undefined): SessionMode | null => {
  if (c === undefined) return null;
  if (c.t === "choosing") return c.target;
  return c.next ?? c.sent;
};

/** The pending target for `id`, or null when its mode is settled. */
export const pendingMode = (
  choices: ModeChoices,
  id: string | null | undefined,
): SessionMode | null => targetOf(id ? choices[id] : undefined);

/** Fold a fresh choice in: a call already out keeps it as `next`, so one
 *  application is outstanding per session however fast the user cycles. */
const chose = (c: ModeChoice | undefined, target: SessionMode): ModeChoice =>
  c?.t === "applying" ? { ...c, next: target } : { t: "choosing", target };

// ---- the handle ------------------------------------------------------------

export interface ModeControlDeps {
  setMode: (sessionId: string, mode: SessionMode) => Promise<void>;
  /** The newest snapshots — the only source of the applied mode. */
  fleet: () => readonly SessionSnapshot[];
  choices: () => ModeChoices;
  /** Commit a transition; `null` forgets the session. */
  commit: (sessionId: string, choice: ModeChoice | null) => void;
  note: (text: string, tone: "good" | "bad" | "dim") => void;
  /**
   * The session refused to leave `plan` because an `ExitPlanMode` review is
   * outstanding. The chip must not answer a plan review, so this hands the user
   * to the real one.
   */
  planPending: (sessionId: string) => void;
  /**
   * How long a choice sits before it is applied. Passing through `plan` has real
   * provider effects — it flips the SDK session into plan mode, tools and all —
   * so a fast cycle through to `auto` must not stop there on the way.
   */
  debounceMs?: number;
}

export interface ModeControl {
  /** `⇧⇥`: choose the next mode for `sessionId` and show it immediately. */
  cycle: (sessionId: string) => void;
  /** Drop the choice, and any timer, for every session the daemon has stopped
   *  listing. Called on each snapshot. */
  settle: () => void;
  /** Cancel every timer — the UI is going away. */
  dispose: () => void;
}

const codeOf = (e: unknown): unknown =>
  e instanceof Error && "code" in e ? (e as { code?: unknown }).code : undefined;

export const mkModeControl = ({
  setMode,
  fleet,
  choices,
  commit,
  note,
  planPending,
  debounceMs = 300,
}: ModeControlDeps): ModeControl => {
  // A timer exists exactly while its session is `choosing`; every transition
  // out of that state goes through `disarm` first.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const disarm = (sessionId: string): void => {
    const t = timers.get(sessionId);
    if (t === undefined) return;
    clearTimeout(t);
    timers.delete(sessionId);
  };

  const arm = (sessionId: string): void => {
    disarm(sessionId);
    timers.set(
      sessionId,
      setTimeout(() => {
        timers.delete(sessionId);
        apply(sessionId);
      }, debounceMs),
    );
  };

  /** The debounce elapsed: send whatever the presses settled on. */
  const apply = (sessionId: string): void => {
    const c = choices()[sessionId];
    if (c?.t !== "choosing") return;
    if (!fleet().some((x) => x.id === sessionId)) return void commit(sessionId, null);
    const target = c.target;
    commit(sessionId, { t: "applying", sent: target, next: null });
    setMode(sessionId, target).then(
      () => resume(sessionId),
      (e: unknown) => {
        // Every failure ends the chain rather than going on to `next`: the
        // targets behind it were cycled on from a mode the daemon never took,
        // so applying one would land somewhere the user never chose. Dropping
        // the choice puts the authoritative mode back on the chip.
        commit(sessionId, null);
        if (isAmbiguousFailure(e)) {
          return void note("mode switch may not have arrived — ⇧⇥ to try again", "bad");
        }
        if (codeOf(e) === "plan_pending") {
          // The mode never left `plan`: an outstanding `ExitPlanMode` review has
          // to be resolved through the real review UI, not silently answered by
          // the chip. Open it, so there is no "chip says X, the live session is
          // parked on a plan" state to land in.
          planPending(sessionId);
          return void note("a plan review is pending — resolve it first", "bad");
        }
        note(`mode switch failed: ${e instanceof Error ? e.message : String(e)}`, "bad");
      },
    );
  };

  /** The call settled: take up the one target chosen while it was out, on the
   *  same debounce it would have had on its own. */
  const resume = (sessionId: string): void => {
    const c = choices()[sessionId];
    if (c?.t !== "applying") return;
    if (c.next === null) return void commit(sessionId, null);
    commit(sessionId, { t: "choosing", target: c.next });
    arm(sessionId);
  };

  return {
    cycle: (sessionId) => {
      const s = fleet().find((x) => x.id === sessionId);
      if (!s) return void note("session is gone", "dim");
      const c = choices()[sessionId];
      // Cycle on from where the selection is heading, not from the snapshot:
      // three quick presses move three modes, whatever the daemon has taken.
      const target = nextMode(targetOf(c) ?? s.mode);
      commit(sessionId, chose(c, target));
      note(`mode → ${modeLabel(target)}`, "good");
      // A call is already out; `resume` applies this when it settles.
      if (c?.t !== "applying") arm(sessionId);
    },
    settle: () => {
      const ids = Object.keys(choices());
      if (ids.length === 0) return;
      const live = new Set(fleet().map((s) => s.id));
      for (const id of ids) {
        if (live.has(id)) continue;
        disarm(id);
        commit(id, null);
      }
    },
    dispose: () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
};
