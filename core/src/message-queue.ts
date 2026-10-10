/**
 * A session's message queue (spec: `docs/message-queue.md`). Every message a
 * user sends a root session is an entry here first; it reaches the chat log
 * only once the agent has taken it, and every client reads the same queue —
 * and the same "when will it go" hint — off the session snapshot.
 */
import { z } from "zod";

/**
 * When an entry may reach the agent. `next_boundary`: at the live turn's next
 * tool boundary, else as the next turn. `end_of_turn`: once the session is
 * idle, one per idle (⌥q).
 */
export const queueDeliverySchema = z.enum(["next_boundary", "end_of_turn"]);
export type QueueDelivery = z.infer<typeof queueDeliverySchema>;

/**
 * - `queued`: still in Loom — editable, movable, removable.
 * - `delivering`: handed to the provider, not yet seen taken; read-only. With
 *   `uncertain` it may or may not have reached the agent.
 * - `consumed`: the agent took it; it is in the chat log from that point on.
 * - `cancelled`: removed or cleared.
 */
export const queueEntryStateSchema = z.enum(["queued", "delivering", "consumed", "cancelled"]);
export type QueueEntryState = z.infer<typeof queueEntryStateSchema>;

/** Why nothing is dispatched automatically; null when the queue runs. */
export const queueHoldSchema = z.enum(["interrupt", "restart", "crash", "rejected"]);
export type QueueHold = z.infer<typeof queueHoldSchema>;

/** One entry in full — `session.queueEntry`'s result. */
export const queueEntrySchema = z.object({
  /** Client-chosen UUID: the idempotency key and the provider's input id. */
  id: z.string(),
  text: z.string(),
  /** The submitting client's id. */
  author: z.string(),
  delivery: queueDeliverySchema,
  state: queueEntryStateSchema,
  /** Handed over, and whether the provider took it is unknown. */
  uncertain: z.boolean(),
  /** Bumped by every edit, move and state change; mutations must quote it. */
  revision: z.number(),
  createdAt: z.number(),
  deliveredAt: z.number().optional(),
  consumedAt: z.number().optional(),
});
export type QueueEntry = z.infer<typeof queueEntrySchema>;

/**
 * Where a live entry will be taken, computed by the daemon so every client
 * says the same thing.
 */
export const dequeueHintSchema = z.discriminatedUnion("t", [
  /** A root tool is running; the entry goes in when it finishes. */
  z.object({ t: z.literal("tool_boundary"), tool: z.string() }),
  /** The model is writing; at its next tool boundary, or as the next turn. */
  z.object({ t: z.literal("next_tool_or_turn_end") }),
  /** When the agent finishes; `ahead` entries go before it. */
  z.object({ t: z.literal("turn_end"), ahead: z.number() }),
  /** After the pending request is answered. */
  z.object({ t: z.literal("after_request") }),
  /** After the compaction (or another restructuring) finishes. */
  z.object({ t: z.literal("after_compaction") }),
  /** The queue is held; `r` releases it. */
  z.object({ t: z.literal("held"), reason: queueHoldSchema }),
  /** No live agent; sending revives the session. */
  z.object({ t: z.literal("session_stopped") }),
  /** Already handed to the agent, waiting to be taken. */
  z.object({ t: z.literal("handed_over") }),
]);
export type DequeueHint = z.infer<typeof dequeueHintSchema>;

/** The longest preview a snapshot carries; the full text is `session.queueEntry`'s. */
export const QUEUE_PREVIEW_CHARS = 200;

/** A live entry as the snapshot carries it. */
export const queueEntryViewSchema = z.object({
  id: z.string(),
  author: z.string(),
  delivery: queueDeliverySchema,
  state: queueEntryStateSchema,
  uncertain: z.boolean(),
  revision: z.number(),
  /** The first {@link QUEUE_PREVIEW_CHARS} characters. */
  preview: z.string(),
  /** UTF-8 size of the full text. */
  bytes: z.number(),
  dequeue: dequeueHintSchema,
});
export type QueueEntryView = z.infer<typeof queueEntryViewSchema>;

/** `SessionSnapshot.queue`: the live entries in dispatch order, and the hold. */
export const sessionQueueSchema = z.object({
  hold: z.union([queueHoldSchema, z.null()]),
  entries: z.array(queueEntryViewSchema),
});
export type SessionQueue = z.infer<typeof sessionQueueSchema>;

/** Main-new's limits: live entries per session, bytes per entry and per session. */
export const QUEUE_LIMITS = {
  entries: 100,
  entryBytes: 1024 * 1024,
  sessionBytes: 8 * 1024 * 1024,
  /** Consumed / cancelled rows kept for idempotent re-enqueues. */
  settled: 200,
} as const;

/**
 * The provider may or may not have taken input whose hand-over failed this
 * way — the transport went down with the request in flight. Distinct from an
 * explicit refusal, which leaves the input unsent.
 */
export class DeliveryUncertainError extends Error {
  override readonly name = "DeliveryUncertainError";
}

/** Options for `AgentSession.send`. Both optional: Loom's own sends carry none. */
export const sendOptionsSchema = z.object({
  /** The queue entry's id — the provider-side input id (Claude's uuid, Codex's
   *  `clientUserMessageId`) and the `inputId` of its `input_consumed`. */
  inputId: z.string().optional(),
  /** Handed into a live turn rather than starting one. */
  midTurn: z.boolean().optional(),
});
export type SendOptions = z.infer<typeof sendOptionsSchema>;

const ordinal = (n: number): string => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

/** A hint in words — the same phrase on every client. */
export const describeDequeue = (h: DequeueHint): string => {
  switch (h.t) {
    case "tool_boundary":
      return `lands when ${h.tool} finishes`;
    case "next_tool_or_turn_end":
      return "at the next tool boundary";
    case "turn_end":
      return h.ahead === 0
        ? "when the agent finishes"
        : `when the agent finishes, ${ordinal(h.ahead + 1)} in line`;
    case "after_request":
      return "after the pending request";
    case "after_compaction":
      return "after the compaction";
    case "held":
      return "held · r releases";
    case "session_stopped":
      return "session stopped · sending revives it";
    case "handed_over":
      return "handed to the agent";
  }
};

/** Is this entry still waiting on Loom or the agent? */
export const isLiveEntry = (e: { state: QueueEntryState }): boolean =>
  e.state === "queued" || e.state === "delivering";
