/**
 * Permission-mode selection: the mode the user has cycled to, before the daemon
 * has taken it.
 *
 * The server-confirmed mode lives in the session snapshot — nothing
 * here ever writes it. What lives
 * here is the local half of a selection in progress: a target the user has
 * chosen (`choosing`, waiting out the debounce) or one that is on the wire
 * (`applying`, optionally with the next target behind it). Idle is the absence
 * of an entry, so there is no second way to spell "nothing is being changed".
 *
 * The chip shows the target in grey while the change is pending. Once the
 * server responds, its snapshot owns the display, including any mode deferred
 * until the next turn.
 */
import { mkStore, type Store } from "./store.ts";
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
  | { t: "choosing"; target: SessionMode; timer: ReturnType<typeof setTimeout> }
  /** `session.setMode` is on the wire with `sent`; `next` is what the user has
   *  cycled to since, to be applied when this call settles. */
  | { t: "applying"; operation: symbol; sent: SessionMode; next: SessionMode | null };

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

// ---- the handle ------------------------------------------------------------

export interface ModeControlDeps {
  setMode: (sessionId: string, mode: SessionMode) => Promise<void>;
  /** The newest snapshots — the only source of the applied mode. */
  fleet: () => readonly SessionSnapshot[];
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

export interface ModeControl extends Pick<Store<ModeChoices>, "get" | "subscribe"> {
  /** `⇧⇥`: choose the next mode for `sessionId` and show it immediately. */
  cycle: (sessionId: string) => void;
  /** Drop the choice, and any timer, for every session the daemon has stopped
   *  listing. Called on each snapshot. */
  settle: () => void;
  cancel: () => void;
  /** Cancel every timer — the UI is going away. */
  dispose: () => void;
}

const codeOf = (e: unknown): unknown =>
  e instanceof Error && "code" in e ? (e as { code?: unknown }).code : undefined;

export const mkModeControl = ({
  setMode,
  fleet,
  note,
  planPending,
  debounceMs = 500,
}: ModeControlDeps): ModeControl => {
  // Choosing owns its timer; leaving that variant cancels it.
  const store = mkStore<ModeChoices>({});
  const choices = store.get;
  const commit = (id: string, choice: ModeChoice | null): void => {
    const old = choices()[id];
    if (old?.t === "choosing") clearTimeout(old.timer);
    const { [id]: _old, ...rest } = choices();
    store.set(choice === null ? rest : { ...rest, [id]: choice });
  };
  let disposed = false;
  const choose = (id: string, target: SessionMode): void => {
    const choice: Extract<ModeChoice, { t: "choosing" }> = {
      t: "choosing",
      target,
      timer: setTimeout(() => {
        if (choices()[id] === choice) apply(id);
      }, debounceMs),
    };
    commit(id, choice);
  };

  /** The debounce elapsed: send whatever the presses settled on. */
  const apply = (sessionId: string): void => {
    const c = choices()[sessionId];
    if (disposed || c?.t !== "choosing") return;
    if (!fleet().some((x) => x.id === sessionId)) return void commit(sessionId, null);
    const target = c.target;
    const operation = Symbol();
    commit(sessionId, { t: "applying", operation, sent: target, next: null });
    const current = () => {
      const choice = choices()[sessionId];
      return !disposed && choice?.t === "applying" && choice.operation === operation;
    };
    setMode(sessionId, target).then(
      () => {
        if (current()) resume(sessionId);
      },
      (e: unknown) => {
        if (!current()) return;
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
    choose(sessionId, c.next);
  };

  return {
    get: store.get,
    subscribe: store.subscribe,
    cycle: (sessionId) => {
      if (disposed) return;
      const s = fleet().find((x) => x.id === sessionId);
      if (!s) return void note("session is gone", "dim");
      const c = choices()[sessionId];
      // Cycle on from where the selection is heading, not from the snapshot:
      // three quick presses move three modes, whatever the daemon has taken.
      const target = nextMode(targetOf(c) ?? s.mode);
      if (c?.t === "applying") commit(sessionId, { ...c, next: target });
      else choose(sessionId, target);
      note(`mode → ${modeLabel(target)}`, "good");
    },
    settle: () => {
      for (const id of Object.keys(choices()))
        if (!fleet().some((s) => s.id === id)) commit(id, null);
    },
    cancel: () => {
      for (const id of Object.keys(choices())) {
        commit(id, null);
      }
    },
    dispose: () => {
      disposed = true;
      for (const choice of Object.values(choices()))
        if (choice.t === "choosing") clearTimeout(choice.timer);
    },
  };
};
