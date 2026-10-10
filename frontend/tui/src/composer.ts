/**
 * Text on its way into a session's queue: the `session.send` on the wire, and
 * one whose reply never came back.
 *
 * The queue itself is the daemon's (`docs/message-queue.md`): every message
 * enters it, every client reads it off the session snapshot, and the daemon
 * decides when the agent gets each one. What is left here is only what the
 * RPC is doing — so a send whose fate is unknown is not lost, and is not
 * queued twice when the user sends it again.
 */
import { mkStore, type Store } from "./store.ts";
import type { QueueDelivery } from "@loom/core/message-queue";
import { isAmbiguousFailure } from "@loom/client";

/**
 * One session's send in progress, if any.
 *
 * `entryId` is the queue entry's id, chosen here: the daemon answers a
 * re-sent id with the entry it already has rather than queueing it again.
 */
export type Outbox =
  | { t: "idle" }
  /** `session.send` is on the wire with `text`. */
  | { t: "sending"; operation: symbol; entryId: string; text: string }
  /**
   * The send failed. `uncertain`: the reply never came (dropped connection,
   * timeout) and the daemon may have queued it; `rejected`: it said no. Never
   * re-sent by itself: opening that session's `send` prompt hands the text
   * back, and sending it unchanged reuses `entryId`.
   */
  | { t: "held"; failure: "uncertain" | "rejected"; entryId: string; text: string };

export type Outboxes = Record<string, Outbox>;

const EMPTY: Outbox = { t: "idle" };

export const outboxOf = (boxes: Outboxes, id: string | null): Outbox =>
  (id ? boxes[id] : undefined) ?? EMPTY;

/** Opening the editor hands a held message back as editable text. */
export const release = (b: Outbox): { text: string; entryId: string } | null =>
  b.t === "held" ? { text: b.text, entryId: b.entryId } : null;

/** The id a send of `text` goes under: a held message's own when the text is
 *  unchanged (it may already be queued), else a fresh one. */
export const entryIdFor = (b: Outbox, text: string): string =>
  b.t === "held" && b.text === text ? b.entryId : crypto.randomUUID();

// ---- the handle ------------------------------------------------------------

/** What the daemon says about a queued message. */
export interface SendReply {
  readonly entryId: string;
  /** `queued`, `delivering` or `consumed` — how far it got before the reply. */
  readonly state: string;
}

export interface ComposerDeps {
  send: (
    sessionId: string,
    params: { text: string; entryId: string; delivery: QueueDelivery },
  ) => Promise<SendReply>;
}

export interface Composer extends Pick<Store<Outboxes>, "get" | "subscribe"> {
  /** Queue `text` on session `id`; settles as the RPC did. A failure leaves
   *  the message held. */
  send: (id: string, text: string, delivery: QueueDelivery) => Promise<SendReply>;
  dispose: () => void;
}

export const mkComposer = ({ send }: ComposerDeps): Composer => {
  const store = mkStore<Outboxes>({});
  const boxes = store.get;
  const commit = (id: string, box: Outbox | null): void => {
    const { [id]: _old, ...rest } = boxes();
    store.set(box === null ? rest : { ...rest, [id]: box });
  };
  let disposed = false;
  return {
    get: store.get,
    subscribe: store.subscribe,
    send: async (id, text, delivery) => {
      const entryId = entryIdFor(outboxOf(boxes(), id), text);
      const operation = Symbol();
      commit(id, { t: "sending", operation, entryId, text });
      // A later send on the same session owns the box from here on.
      const current = (): boolean => {
        const box = boxes()[id];
        return !disposed && box?.t === "sending" && box.operation === operation;
      };
      try {
        const reply = await send(id, { text, entryId, delivery });
        if (current()) commit(id, null);
        return reply;
      } catch (e) {
        if (current())
          commit(id, {
            t: "held",
            failure: isAmbiguousFailure(e) ? "uncertain" : "rejected",
            entryId,
            text,
          });
        throw e;
      }
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
 * global for new prompts/cancelled text. Reply prompts load their session's
 * durable user messages separately; cancelling `new` can still recover its draft
 * at `send`.
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
