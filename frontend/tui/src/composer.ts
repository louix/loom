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
import { mkStore, type Store } from "./store.ts";
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
  | { t: "sending"; operation: symbol; text: string; rest: readonly string[]; barrier: number }
  /**
   * The reply to `text`'s send never came — dropped connection or timeout — so
   * whether the daemon ran it is unknowable from here. It is not re-sent: it
   * waits for the user to open that session's `send` prompt, which hands it
   * back as editable text. `rest` waits with it rather than overtaking a
   * message still under review.
   */
  | {
      t: "held";
      failure: "uncertain" | "rejected";
      text: string;
      rest: readonly string[];
      barrier: number;
    };

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

/**
 * The messages a reader can still see waiting, oldest first — what the
 * transcript marks as queued.
 *
 * Not the same set as {@link pending}: the message on the wire is left out,
 * because the daemon is about to emit its own `user_message` for it and two
 * lines for one message is worse than none. A held message is out for the same
 * reason as in `pending` — it waits for the user, not for a turn — but the
 * ones stacked behind it are still queued.
 */
export const waiting = (b: Outbox): readonly string[] => {
  switch (b.t) {
    case "idle":
      return [];
    case "queued":
      return [b.text, ...b.rest];
    case "sending":
    case "held":
      return [...b.rest];
  }
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
  b.t === "held" || b.t === "sending" ? { ...b, rest: [] } : { t: "idle", barrier: b.barrier };

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

/** Opening the editor does not release the held message's tail. */
export const release = (b: Outbox): { text: string; box: Outbox } | null =>
  b.t === "held" ? { text: b.text, box: b } : null;

// ---- the handle ------------------------------------------------------------

export interface ComposerDeps {
  send: (sessionId: string, text: string) => Promise<void>;
  /** The newest snapshots. */
  fleet: () => readonly SessionSnapshot[];
  recover: (text: string) => void;
  /** Every notice the composer raises is bad news; nothing else needs saying. */
  note: (text: string) => void;
}

export interface Composer extends Pick<Store<Outboxes>, "get" | "subscribe"> {
  enqueue: (id: string, text: string) => void;
  clear: (id: string) => void;
  advance: () => void;
  retry: (id: string, text: string) => Promise<void>;
  dispose: () => void;
}

export const mkComposer = ({ send, fleet, recover, note }: ComposerDeps): Composer => {
  const store = mkStore<Outboxes>({});
  const boxes = store.get;
  const commit = (id: string, box: Outbox | null): void => {
    const { [id]: _old, ...rest } = boxes();
    store.set(box === null ? rest : { ...rest, [id]: box });
  };
  let disposed = false;
  const deliver = async (id: string, text: string, b: Outbox): Promise<void> => {
    if (disposed || b.t === "idle" || b.t === "sending") return;
    const operation = Symbol();
    commit(id, { t: "sending", operation, text, rest: b.rest, barrier: b.barrier });
    const current = (): Extract<Outbox, { t: "sending" }> | null => {
      const box = boxes()[id];
      return !disposed && box?.t === "sending" && box.operation === operation ? box : null;
    };
    const turns = (): number => fleet().find((s) => s.id === id)?.turns ?? b.barrier;
    try {
      await send(id, text);
      const box = current();
      if (box) commit(id, advance(box, turns()));
    } catch (e) {
      const box = current();
      if (!box) return;
      const uncertain = isAmbiguousFailure(e);
      commit(id, {
        t: "held",
        failure: uncertain ? "uncertain" : "rejected",
        text,
        rest: box.rest,
        barrier: turns(),
      });
      note(
        uncertain
          ? "queued message may already have been sent — ⏎ to review it"
          : "send failed: " + (e instanceof Error ? e.message : String(e)) + " — ⏎ to review it",
      );
    }
  };
  const settle = (): void => {
    if (disposed) return;
    for (const id of Object.keys(boxes())) {
      const b = boxes()[id];
      if (!b) continue;
      const s = fleet().find((x) => x.id === id);
      if (stranded(s)) {
        commit(id, null);
        if (b.t !== "idle") {
          recover([b.text, ...b.rest].join("\n\n"));
          const uncertain = b.t === "sending" || (b.t === "held" && b.failure === "uncertain");
          const outcome = uncertain ? "send may have arrived" : "queued messages not sent";
          note(
            "session " +
              (s?.status.kind ?? "gone") +
              " — " +
              outcome +
              "; saved as a draft — n to review",
          );
        }
      } else if (s && due(b, s) !== null) {
        void deliver(id, b.t === "idle" ? "" : b.text, b);
      }
    }
  };
  return {
    get: store.get,
    subscribe: store.subscribe,
    advance: settle,
    enqueue: (id, text) => {
      if (disposed) return;
      commit(id, enqueue(outboxOf(boxes(), id), text));
      settle();
    },
    clear: (id) => commit(id, cleared(outboxOf(boxes(), id))),
    retry: async (id, text) => {
      const b = boxes()[id];
      if (b?.t === "held") await deliver(id, text, b);
    },
    dispose: () => {
      disposed = true;
    },
  };
};

// ---- drafts ----------------------------------------------------------------

/**
 * Unsent text with no session behind it yet: the last cancelled `new` / `send`
 * buffer, and the submitted messages `↑` / `↓` walk back through. Both are
 * global rather than per-session on purpose — a message typed at `new` and
 * abandoned should come back at `send`, because the user's next move is often
 * the other prompt.
 */
export interface Drafts {
  /** The last unsubmitted `new` / `send` buffer; "" = nothing stashed. */
  last: string;
  /** Submitted `new` / `send` prompts, oldest last, capped. */
  history: readonly string[];
}

export const noDrafts: Drafts = { last: "", history: [] };

const HISTORY_CAP = 50;

/** Remember a submitted message: newest last, one entry per distinct text, so
 *  re-sending something old moves it to the front of the walk rather than
 *  filling the history with repeats. */
export const recorded = (d: Drafts, raw: string): Drafts => {
  const text = raw.trim();
  if (!text) return d;
  const history = d.history.filter((x) => x !== text).concat(text);
  return { ...d, history: history.slice(-HISTORY_CAP) };
};

/** `idx` steps back from the newest — the walk counts up from the live buffer,
 *  the history counts up from the oldest, and this is where they meet. */
export const recalled = (d: Drafts, idx: number): string => d.history[d.history.length - idx] ?? "";
