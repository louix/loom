/**
 * Text on its way to a session: what the user typed at a session that was still
 * working, what is on the wire right now, and what came back uncertain.
 *
 * One union per session says all three. It replaces four containers that had to
 * agree with each other — a queue, a held-text map, a set of sessions with a
 * send in flight, and a map of the turn each last released at — where every
 * combination but a handful was unrepresentable in intent and perfectly
 * representable in types. Here the message belongs to the variant that owns it,
 * so a message cannot be queued and in flight at once, and a session cannot be
 * draining with nothing to drain.
 */
import type { SessionSnapshot } from "@loom/core/wire";
import { isAmbiguousFailure } from "@loom/client";

/**
 * A session's outgoing messages, oldest first, and how far the last one got.
 *
 * `barrier` is the `turns` value the last release happened at: a queued message
 * waits for a turn strictly newer than that, so one idle snapshot cannot drain
 * two messages and a session that has not started the previous one yet cannot
 * be handed the next. It outlives an empty queue — `idle` is exactly "nothing
 * to send, but this is where the last one went".
 */
export type Outbox =
  | { t: "idle"; barrier: number }
  /** Waiting for the session to reach a turn past `barrier`. */
  | { t: "queued"; text: string; rest: readonly string[]; barrier: number }
  /** `session.send` is on the wire with `text`. */
  | { t: "sending"; text: string; rest: readonly string[]; barrier: number }
  /**
   * The reply to `text`'s send never came — dropped connection or timeout — so
   * whether the daemon ran it is unknowable from here. It is not re-sent: it
   * waits for the user to open that session's `send` prompt, which hands it
   * back as editable text. `rest` waits with it rather than overtaking a
   * message still under review.
   */
  | { t: "held"; text: string; rest: readonly string[]; barrier: number };

export type Outboxes = Record<string, Outbox>;

const EMPTY: Outbox = { t: "idle", barrier: -1 };

export const outboxOf = (boxes: Outboxes, id: string | null): Outbox =>
  (id ? boxes[id] : undefined) ?? EMPTY;

/** Still waiting to go out, oldest first. A held message is not in here — it has
 *  left the drain path and waits for the user, not for a turn. */
export const pending = (b: Outbox): readonly string[] => {
  if (b.t === "idle") return [];
  return b.t === "held" ? [...b.rest] : [b.text, ...b.rest];
};

/** Add `text` behind whatever is already outgoing. Blank text is not a message. */
export const enqueue = (b: Outbox, raw: string): Outbox => {
  const text = raw.trim();
  if (!text) return b;
  return b.t === "idle"
    ? { t: "queued", text, rest: [], barrier: b.barrier }
    : { ...b, rest: [...b.rest, text] };
};

/** Drop everything still waiting to go out (`⌥x`), keeping the barrier. A held
 *  message is not dropped: it is text the user has not seen the fate of yet, and
 *  only opening the `send` prompt disposes of it. */
export const cleared = (b: Outbox): Outbox =>
  b.t === "held" ? { ...b, rest: [] } : { t: "idle", barrier: b.barrier };

/** The head is done with: promote the tail, and gate it behind `turns`. */
const advance = (b: Outbox, turns: number): Outbox => {
  const [next, ...rest] = b.t === "idle" ? [] : b.rest;
  return next === undefined
    ? { t: "idle", barrier: turns }
    : { t: "queued", text: next, rest, barrier: turns };
};

/**
 * The text to send now, or null. A session that is compacting is skipped
 * outright: the daemon holds its op gate for the whole (multi-minute)
 * summarise and would reject the send with `code:"busy"`.
 */
export const due = (b: Outbox, s: SessionSnapshot): string | null =>
  b.t === "queued" && s.status.kind === "idle" && s.compacting === undefined && s.turns > b.barrier
    ? b.text
    : null;

/** Nothing can ever be sent to a session in this state. */
export const stranded = (s: SessionSnapshot | undefined): boolean =>
  s === undefined || s.status.kind === "done" || s.status.kind === "error";

const sending = (b: Outbox): Outbox => (b.t === "queued" ? { ...b, t: "sending" } : b);

/** The send landed. `turns` is re-read after the round trip, not taken from the
 *  pre-send snapshot: a manual send that interleaved would otherwise leave the
 *  barrier below its true value and let the next message drain mid-turn. */
const sent = (b: Outbox, turns: number): Outbox => advance(b, turns);

/** The reply never came. Gate the tail behind `turns` too — if the send did
 *  land, a turn is starting. */
const heldBack = (b: Outbox, turns: number): Outbox =>
  b.t === "sending" ? { ...b, t: "held", barrier: turns } : b;

/** The send failed outright. Back to queued on the same barrier, so the next
 *  snapshot retries it. */
const requeued = (b: Outbox): Outbox => (b.t === "sending" ? { ...b, t: "queued" } : b);

/** The user opened the `send` prompt on a held message: hand the text back for
 *  editing and let the tail behind it move again. */
export const release = (b: Outbox): { text: string; box: Outbox } | null =>
  b.t === "held" ? { text: b.text, box: advance(b, b.barrier) } : null;

// ---- the handle ------------------------------------------------------------

export interface ComposerDeps {
  send: (sessionId: string, text: string) => Promise<void>;
  /** The newest snapshots. */
  fleet: () => readonly SessionSnapshot[];
  boxes: () => Outboxes;
  /** Commit a change — before any send goes out and before anything is said
   *  about it, so the screen never shows a message as queued while it is on the
   *  wire. `null` forgets the session entirely. */
  commit: (sessionId: string, box: Outbox | null) => void;
  /** Every notice the composer raises is bad news; nothing else needs saying. */
  note: (text: string) => void;
}

export interface Composer {
  /** Fold the newest snapshot in: forget sessions that are gone, say so about
   *  anything they still owed, and release whatever is due. */
  advance: () => void;
}

export const mkComposer = ({ send, fleet, boxes, commit, note }: ComposerDeps): Composer => {
  const settle = (id: string, apply: (b: Outbox) => Outbox): void => {
    // Re-read: the user may have queued more behind this one while it was on
    // the wire, and `apply` folds into whatever is there now.
    const b = boxes()[id];
    if (b?.t === "sending") commit(id, apply(b));
  };

  const advance = (): void => {
    for (const id of Object.keys(boxes())) {
      // Re-read per iteration: `commit` and `note` both dispatch, and dispatch
      // re-enters this function.
      const b = boxes()[id];
      if (!b) continue;
      const s = fleet().find((x) => x.id === id);
      if (stranded(s)) {
        const n = pending(b).length;
        // Forget it BEFORE saying so. `note` dispatches, that dispatch
        // re-enters here, and it would find the very same stranded queue —
        // one notice per recursion until the stack runs out.
        commit(id, null);
        const gone = s ? s.status.kind : "gone";
        // A held message may well have been delivered, so it is never reported
        // as unsent — but it is still text the user typed and never resolved.
        if (b.t === "held") {
          note(`session ${gone} — a message that may already have been sent went with it`);
        } else if (n > 0) {
          note(`${n} queued message${n === 1 ? "" : "s"} not sent — session ${gone}`);
        }
        continue;
      }
      const text = due(b, s!);
      if (text === null) continue;
      commit(id, sending(b));
      // The turn the barrier moves to is read after the round trip, from the
      // snapshot as it is then.
      const turnsNow = (): number => fleet().find((x) => x.id === id)?.turns ?? s!.turns;
      send(id, text)
        .then(() => settle(id, (b2) => sent(b2, turnsNow())))
        .catch((e: unknown) => {
          if (isAmbiguousFailure(e)) {
            settle(id, (b2) => heldBack(b2, turnsNow()));
            note("queued message may already have been sent — ⏎ to review it");
            return;
          }
          settle(id, requeued);
          note(e instanceof Error ? e.message : String(e));
        });
    }
  };

  return { advance };
};
