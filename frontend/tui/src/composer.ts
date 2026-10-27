/** Client-side send recovery, not the daemon queue. Reuse entry IDs after uncertain replies to avoid duplicate delivery. */
import { mkStore, type Store } from "./store.ts";
import type { QueueDelivery } from "@loom/core/message-queue";
import { isAmbiguousFailure } from "@loom/client";
import type { ImageAttachment } from "@loom/core/images";

/** Reuse entryId when retrying unchanged text; the daemon deduplicates it. */
export type Outbox =
  | { t: "idle" }
  /** `session.send` is on the wire with `text`. */
  | { t: "sending"; operation: symbol; entryId: string; text: string; images?: ImageAttachment[] }
  /**
   * The send failed. `uncertain`: the reply never came (dropped connection,
   * timeout) and the daemon may have queued it; `rejected`: it said no. Never
   * re-sent by itself: opening that session's `send` prompt hands the text
   * back, and sending it unchanged reuses `entryId`.
   */
  | {
      t: "held";
      failure: "uncertain" | "rejected";
      entryId: string;
      text: string;
      images?: ImageAttachment[];
    };

export type Outboxes = Record<string, Outbox>;

const EMPTY: Outbox = { t: "idle" };

export const outboxOf = (boxes: Outboxes, id: string | null): Outbox =>
  (id ? boxes[id] : undefined) ?? EMPTY;

/** Opening the editor hands a held message back as editable text. */
export const release = (
  b: Outbox,
): { text: string; entryId: string; images?: ImageAttachment[] } | null =>
  b.t === "held"
    ? { text: b.text, entryId: b.entryId, ...(b.images?.length ? { images: b.images } : {}) }
    : null;

/** The id a send of `text` goes under: a held message's own when the text is
 *  unchanged (it may already be queued), else a fresh one. */
export const entryIdFor = (b: Outbox, text: string, images?: ImageAttachment[]): string =>
  b.t === "held" &&
  b.text === text &&
  JSON.stringify(b.images ?? []) === JSON.stringify(images ?? [])
    ? b.entryId
    : crypto.randomUUID();

// ---- the handle ------------------------------------------------------------

export interface SendReply {
  readonly entryId: string;
  /** `queued`, `delivering` or `consumed` — how far it got before the reply. */
  readonly state: string;
}

export interface ComposerDeps {
  send: (
    sessionId: string,
    params: { text: string; entryId: string; delivery: QueueDelivery; images?: ImageAttachment[] },
  ) => Promise<SendReply>;
}

export interface Composer extends Pick<Store<Outboxes>, "get" | "subscribe"> {
  /** Queue `text` on session `id`; settles as the RPC did. A failure leaves
   *  the message held. */
  send: (
    id: string,
    text: string,
    delivery: QueueDelivery,
    images?: ImageAttachment[],
  ) => Promise<SendReply>;
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
    send: async (id, text, delivery, images) => {
      const attachments = images?.length ? { images } : {};
      const entryId = entryIdFor(outboxOf(boxes(), id), text, images);
      const operation = Symbol();
      commit(id, { t: "sending", operation, entryId, text, ...attachments });
      // A later send on the same session owns the box from here on.
      const current = (): boolean => {
        const box = boxes()[id];
        return !disposed && box?.t === "sending" && box.operation === operation;
      };
      try {
        const reply = await send(id, { text, entryId, delivery, ...attachments });
        if (current()) commit(id, null);
        return reply;
      } catch (e) {
        if (current())
          commit(id, {
            t: "held",
            failure: isAmbiguousFailure(e) ? "uncertain" : "rejected",
            entryId,
            text,
            ...attachments,
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
  lastImages?: ImageAttachment[];
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
