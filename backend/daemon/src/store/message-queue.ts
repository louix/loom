/**
 * The per-session message queue's rows (migration 31) and the session's hold.
 *
 * Client mutations quote the `revision` they saw and fail with `conflict` on a
 * stale one, changing nothing; the session manager's own transitions
 * (dispatch, consumption, interrupt) do not, and bump it for the clients that
 * do. Failures are values: every one of them is something a caller tells the
 * user, never a fault.
 */
import {
  QUEUE_LIMITS,
  type QueueDelivery,
  type QueueEntry,
  type QueueEntryState,
  type QueueHold,
  type QueueHoldBy,
  type QueueHoldCause,
} from "@loom/core/message-queue";
import { createHash } from "node:crypto";
import { type Db, withTransaction } from "./db.ts";

export type QueueFailureCode = "not_found" | "conflict" | "refused" | "queue_full";
export interface QueueFailure {
  readonly ok: false;
  readonly code: QueueFailureCode;
  readonly message: string;
}
export type QueueResult<T> = { readonly ok: true; readonly value: T } | QueueFailure;

const ok = <T>(value: T): QueueResult<T> => ({ ok: true, value });
const fail = (code: QueueFailureCode, message: string): QueueFailure => ({
  ok: false,
  code,
  message,
});

/** A mutation's target as the client saw it. */
export interface QueueTarget {
  readonly entryId: string;
  readonly revision: number;
}

/**
 * What `enqueue` answers. A retried id answers with the entry as it is now —
 * or, settled and pruned since, with only how it settled (`entry: null`).
 */
export type Enqueued =
  | { readonly created: true; readonly entry: QueueEntry; readonly state: QueueEntryState }
  | {
      readonly created: false;
      readonly entry: QueueEntry | null;
      readonly state: QueueEntryState;
    };

/**
 * A change to a session's hold, as {@link MessageQueueStore.applyHold}
 * combines it with the hold already there (docs/message-queue.md, "Holds").
 */
export type HoldChange =
  /** `by`'s stop, or no one's: `interrupt` on an unheld queue while entries
   *  wait — or, `empty`, even without. On a hold already set a user's makes
   *  it the user's; anyone else's changes nothing. */
  | { readonly t: "stop"; readonly by: QueueHoldBy | null; readonly empty: boolean }
  /** Loom's own hold: set on an unheld queue, never over one already set. */
  | { readonly t: "loom"; readonly reason: Exclude<QueueHold, "interrupt"> }
  /** A message that lifts the hold, or a release: clears it. Whether a
   *  message lifts or waits is the enqueue's decision (H2), made once. */
  | { readonly t: "lift" }
  /** Undo the change `ticket` came from, unless the hold was written since. */
  | { readonly t: "restore"; readonly ticket: HoldTicket };

/** What undoes a hold change: the hold before it, and the write it was. */
export interface HoldTicket {
  readonly prior: QueueHoldCause | null;
  readonly generation: number;
}

/** A hold change applied: the hold before and after, and its undo. */
export interface HoldApplied {
  readonly before: QueueHoldCause | null;
  readonly after: QueueHoldCause | null;
  readonly changed: boolean;
  readonly ticket: HoldTicket;
}

/** A live entry as dispatch reads it: no text. */
export type QueueSlot = Pick<QueueEntry, "id" | "state" | "delivery" | "uncertain" | "author">;

interface Row {
  id: string;
  seq: number;
  text: string;
  author: string;
  delivery: QueueDelivery;
  state: QueueEntryState;
  uncertain: number;
  revision: number;
  created_at: number;
  delivered_at: number | null;
  consumed_at: number | null;
  settled_seq: number | null;
}

const toEntry = (r: Row): QueueEntry & { seq: number } => ({
  id: r.id,
  seq: r.seq,
  text: r.text,
  author: r.author,
  delivery: r.delivery,
  state: r.state,
  uncertain: r.uncertain === 1,
  revision: r.revision,
  createdAt: r.created_at,
  ...(r.delivered_at !== null ? { deliveredAt: r.delivered_at } : {}),
  ...(r.consumed_at !== null ? { consumedAt: r.consumed_at } : {}),
});

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const LIVE = "state IN ('queued', 'delivering')";
const SETTLED = "state IN ('consumed', 'cancelled')";
/** Dispatch order: every `next_boundary` entry before any `end_of_turn` one. */
const ORDER = "CASE delivery WHEN 'next_boundary' THEN 0 ELSE 1 END, seq";

export const ALREADY_HANDED = "Already handed to the agent.";
const REUSED = "That message id is already used for different text.";

export class MessageQueueStore {
  readonly #db: Db;
  /** Per session, the last write of its hold in this process, numbered off
   *  {@link #writes}: a restore applies only to the write it undoes. */
  readonly #generations = new Map<string, number>();
  /** Hold writes numbered across sessions, never reused: a session forgotten
   *  ({@link forget}) and written again cannot match an older ticket. */
  #writes = 0;

  constructor(db: Db) {
    this.#db = db;
  }

  /** The live entries, in dispatch order. */
  live(sessionId: string): QueueEntry[] {
    return this.#live(sessionId).map(({ seq: _seq, ...e }) => e);
  }

  #live(sessionId: string): Array<QueueEntry & { seq: number }> {
    const rows = this.#db
      .prepare(`SELECT * FROM session_queue WHERE session_id = ? AND ${LIVE} ORDER BY ${ORDER}`)
      .all(sessionId) as unknown as Row[];
    return rows.map(toEntry);
  }

  /** The live entries in dispatch order without their text — what the
   *  dispatch policy reads, cheap enough to ask after any event. */
  slots(sessionId: string): QueueSlot[] {
    const rows = this.#db
      .prepare(
        `SELECT id, state, delivery, uncertain, author FROM session_queue ` +
          `WHERE session_id = ? AND ${LIVE} ORDER BY ${ORDER}`,
      )
      .all(sessionId) as unknown as Array<
      Pick<Row, "id" | "state" | "delivery" | "uncertain" | "author">
    >;
    return rows.map((r) => ({ ...r, uncertain: r.uncertain === 1 }));
  }

  entry(sessionId: string, id: string): QueueEntry | null {
    const row = this.#row(sessionId, id);
    if (!row) return null;
    const { seq: _seq, ...e } = toEntry(row);
    return e;
  }

  #row(sessionId: string, id: string): Row | null {
    return (
      (this.#db
        .prepare("SELECT * FROM session_queue WHERE session_id = ? AND id = ?")
        .get(sessionId, id) as unknown as Row | undefined) ?? null
    );
  }

  /** Session ids with a live entry or a hold — the ones a restart must look at. */
  sessionsWithQueues(): string[] {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT session_id AS id FROM session_queue WHERE ${LIVE} ` +
          "UNION SELECT id FROM sessions WHERE queue_hold IS NOT NULL",
      )
      .all() as unknown as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** The hold's reason; null when unheld. Read off {@link holdCause}. */
  hold(sessionId: string): QueueHold | null {
    return this.holdCause(sessionId)?.reason ?? null;
  }

  /** The hold and whose stop it is; null when unheld. */
  holdCause(sessionId: string): QueueHoldCause | null {
    const row = this.#db
      .prepare("SELECT queue_hold, queue_hold_by FROM sessions WHERE id = ?")
      .get(sessionId) as
      | { queue_hold: QueueHold | null; queue_hold_by: QueueHoldBy | null }
      | undefined;
    return row?.queue_hold ? { reason: row.queue_hold, by: row.queue_hold_by } : null;
  }

  /**
   * The one write of a session's hold (docs/message-queue.md, "Holds"):
   * `change` combined with the hold as it is. A hold already set keeps its
   * reason, and only a user's stop changes anything about it — it becomes
   * the user's (H1); a lift clears it (the enqueue decided it lifts, H2); a
   * restore undoes an earlier change unless the hold was written since (H5,
   * H6). Synchronous, so nothing comes between the read and the write.
   *
   * "Written" is a change to the hold — and a user's stop, even on the
   * user's hold already: that re-asserts it, and no older change is undone
   * past it. Anything else that leaves the hold as it was (a requeued
   * discard, a crash, a supervisor's stop on a hold already set) is no write,
   * and voids no ticket.
   */
  applyHold(sessionId: string, change: HoldChange): HoldApplied {
    const before = this.holdCause(sessionId);
    const generation = this.#generations.get(sessionId) ?? 0;
    // undefined: the hold stays as it is.
    let after: QueueHoldCause | null | undefined;
    switch (change.t) {
      case "stop":
        if (before !== null)
          after =
            change.by === "user" && before.by !== "user"
              ? { reason: before.reason, by: "user" }
              : undefined;
        else if (change.empty || this.#live(sessionId).length > 0)
          after = { reason: "interrupt", by: change.by };
        break;
      case "loom":
        if (before === null) after = { reason: change.reason, by: null };
        break;
      case "lift":
        if (before !== null) after = null;
        break;
      case "restore":
        if (change.ticket.generation === generation) after = change.ticket.prior;
        break;
    }
    const now = after === undefined ? before : after;
    const changed = before?.reason !== now?.reason || before?.by !== now?.by;
    const wrote = changed || (change.t === "stop" && change.by === "user");
    const next = wrote ? ++this.#writes : generation;
    if (wrote) this.#generations.set(sessionId, next);
    if (changed)
      this.#db
        .prepare("UPDATE sessions SET queue_hold = ?, queue_hold_by = ? WHERE id = ?")
        .run(now?.reason ?? null, now?.by ?? null, sessionId);
    return { before, after: now, changed, ticket: { prior: before, generation: next } };
  }

  /** Forget a removed session's hold writes. */
  forget(sessionId: string): void {
    this.#generations.delete(sessionId);
  }

  /**
   * Add an entry behind its group — or, with `head`, in front of every live
   * entry (a message sent to a held queue goes first). Re-enqueueing a known
   * id with the same text answers with that entry (`created: false`), however
   * far it has got — pruned since included; different text is a `conflict`.
   */
  enqueue(
    sessionId: string,
    e: { id: string; text: string; author: string; delivery: QueueDelivery },
    opts: { head?: boolean; at?: number } = {},
  ): QueueResult<Enqueued> {
    return withTransaction(this.#db, () => {
      const known = this.#row(sessionId, e.id);
      if (known) {
        if (known.text !== e.text) return fail("conflict", REUSED);
        const entry = this.entry(sessionId, e.id)!;
        return ok({ created: false, entry, state: entry.state });
      }
      const seen = this.#seen(sessionId, e.id);
      if (seen) {
        if (seen.text_sha256 !== sha256(e.text)) return fail("conflict", REUSED);
        return ok({ created: false, entry: null, state: seen.state });
      }
      const bytes = bytesOf(e.text);
      if (bytes > QUEUE_LIMITS.entryBytes)
        return fail("queue_full", "The message is larger than the queue accepts (1 MiB).");
      const live = this.#live(sessionId);
      if (live.length >= QUEUE_LIMITS.entries)
        return fail("queue_full", `The queue already holds ${QUEUE_LIMITS.entries} messages.`);
      const total = live.reduce((n, x) => n + bytesOf(x.text), 0);
      if (total + bytes > QUEUE_LIMITS.sessionBytes)
        return fail("queue_full", "The queued messages would exceed 8 MiB.");
      const seq = opts.head ? this.#minSeq(sessionId) - 1 : this.#maxSeq(sessionId) + 1;
      this.#db
        .prepare(
          "INSERT INTO session_queue (session_id, id, seq, text, author, delivery, state, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)",
        )
        .run(
          sessionId,
          e.id,
          seq,
          e.text,
          e.author,
          opts.head ? "next_boundary" : e.delivery,
          opts.at ?? Date.now(),
        );
      const entry = this.entry(sessionId, e.id)!;
      return ok({ created: true, entry, state: entry.state });
    });
  }

  /** A pruned settled row's trace: its text's hash and how it settled. */
  #seen(sessionId: string, id: string): { text_sha256: string; state: QueueEntryState } | null {
    return (
      (this.#db
        .prepare(
          "SELECT text_sha256, state FROM session_queue_seen WHERE session_id = ? AND id = ?",
        )
        .get(sessionId, id) as unknown as
        | { text_sha256: string; state: QueueEntryState }
        | undefined) ?? null
    );
  }

  #maxSeq(sessionId: string): number {
    const row = this.#db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM session_queue WHERE session_id = ?")
      .get(sessionId) as { n: number };
    return row.n;
  }

  #minSeq(sessionId: string): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(MIN(seq), 1) AS n FROM session_queue WHERE session_id = ? AND ${LIVE}`,
      )
      .get(sessionId) as { n: number };
    return row.n;
  }

  /** The live row `t` names at the revision the client saw, or why not. */
  #target(sessionId: string, t: QueueTarget): QueueResult<Row> {
    const row = this.#row(sessionId, t.entryId);
    if (!row || (row.state !== "queued" && row.state !== "delivering"))
      return fail("not_found", "That message is no longer queued.");
    if (row.revision !== t.revision)
      return fail("conflict", "The message changed since you looked; review it and retry.");
    return ok(row);
  }

  #queuedTarget(sessionId: string, t: QueueTarget): QueueResult<Row> {
    const r = this.#target(sessionId, t);
    if (r.ok && r.value.state !== "queued") return fail("refused", ALREADY_HANDED);
    return r;
  }

  #update(sessionId: string, id: string, set: string, ...args: Array<string | number | null>) {
    this.#db
      .prepare(
        `UPDATE session_queue SET ${set}, revision = revision + 1 WHERE session_id = ? AND id = ?`,
      )
      .run(...args, sessionId, id);
  }

  /** Settle a row (`set` names its final state). It takes the session's next
   *  settlement number: pruning keeps the most recently settled. */
  #settle(sessionId: string, id: string, set: string, ...args: Array<string | number | null>) {
    const { n } = this.#db
      .prepare(
        "SELECT MAX(" +
          "(SELECT COALESCE(MAX(settled_seq), 0) FROM session_queue WHERE session_id = ?), " +
          "(SELECT COALESCE(MAX(settled_seq), 0) FROM session_queue_seen WHERE session_id = ?)" +
          ") + 1 AS n",
      )
      .get(sessionId, sessionId) as { n: number };
    this.#update(sessionId, id, `${set}, settled_seq = ?`, ...args, n);
  }

  edit(sessionId: string, t: QueueTarget, text: string): QueueResult<QueueEntry> {
    return withTransaction(this.#db, () => {
      const r = this.#queuedTarget(sessionId, t);
      if (!r.ok) return r;
      if (bytesOf(text) > QUEUE_LIMITS.entryBytes)
        return fail("queue_full", "The message is larger than the queue accepts (1 MiB).");
      this.#update(sessionId, t.entryId, "text = ?", text);
      return ok(this.entry(sessionId, t.entryId)!);
    });
  }

  /** Swap with the neighbour in its own group. */
  move(sessionId: string, t: QueueTarget, direction: "up" | "down"): QueueResult<QueueEntry> {
    return withTransaction(this.#db, () => {
      const r = this.#queuedTarget(sessionId, t);
      if (!r.ok) return r;
      const group = this.#live(sessionId).filter((e) => e.delivery === r.value.delivery);
      const at = group.findIndex((e) => e.id === t.entryId);
      const other = group[direction === "up" ? at - 1 : at + 1];
      if (!other)
        return fail("refused", direction === "up" ? "First in its group." : "Last in its group.");
      if (other.state !== "queued") return fail("refused", ALREADY_HANDED);
      this.#update(sessionId, t.entryId, "seq = ?", other.seq);
      this.#update(sessionId, other.id, "seq = ?", r.value.seq);
      return ok(this.entry(sessionId, t.entryId)!);
    });
  }

  /** Switch the delivery mode; the entry joins the back of the other group. */
  setDelivery(sessionId: string, t: QueueTarget, delivery: QueueDelivery): QueueResult<QueueEntry> {
    return withTransaction(this.#db, () => {
      const r = this.#queuedTarget(sessionId, t);
      if (!r.ok) return r;
      if (r.value.delivery === delivery) return ok(this.entry(sessionId, t.entryId)!);
      this.#update(
        sessionId,
        t.entryId,
        "delivery = ?, seq = ?",
        delivery,
        this.#maxSeq(sessionId) + 1,
      );
      return ok(this.entry(sessionId, t.entryId)!);
    });
  }

  /**
   * Put an entry at the head of the queue for send now: `next_boundary`, in
   * front of every live entry. An uncertain one is taken back to `queued`
   * (the caller has confirmed it may duplicate).
   */
  toHead(sessionId: string, t: QueueTarget): QueueResult<QueueEntry> {
    return withTransaction(this.#db, () => {
      const r = this.#target(sessionId, t);
      if (!r.ok) return r;
      if (r.value.state === "delivering" && r.value.uncertain === 0)
        return fail("refused", ALREADY_HANDED);
      this.#update(
        sessionId,
        t.entryId,
        "state = 'queued', uncertain = 0, delivery = 'next_boundary', seq = ?",
        this.#minSeq(sessionId) - 1,
      );
      return ok(this.entry(sessionId, t.entryId)!);
    });
  }

  /**
   * Cancel queued and uncertain entries, all or nothing: a stale or
   * already-handed target refuses the whole request.
   */
  remove(sessionId: string, targets: readonly QueueTarget[]): QueueResult<QueueEntry[]> {
    return withTransaction(this.#db, () => {
      for (const t of targets) {
        const r = this.#target(sessionId, t);
        if (!r.ok) return r;
        if (r.value.state === "delivering" && r.value.uncertain === 0)
          return fail("refused", ALREADY_HANDED);
      }
      const out = targets.map((t) => {
        this.#settle(sessionId, t.entryId, "state = 'cancelled', consumed_at = NULL");
        return this.entry(sessionId, t.entryId)!;
      });
      this.#prune(sessionId);
      return ok(out);
    });
  }

  /**
   * Cancel exactly the observed ids that can still be cancelled — an entry
   * that arrived after the client looked is never swept. Returns what went.
   */
  clear(sessionId: string, ids: readonly string[]): QueueEntry[] {
    return withTransaction(this.#db, () => {
      const out: QueueEntry[] = [];
      for (const id of ids) {
        const row = this.#row(sessionId, id);
        if (!row) continue;
        if (row.state !== "queued" && !(row.state === "delivering" && row.uncertain === 1))
          continue;
        this.#settle(sessionId, id, "state = 'cancelled'");
        out.push(this.entry(sessionId, id)!);
      }
      this.#prune(sessionId);
      return out;
    });
  }

  // --- the session manager's transitions ---------------------------------

  /** Recorded before the provider is called: a crash in between leaves them
   *  `delivering`, and a restart marks them uncertain. */
  markDelivering(sessionId: string, ids: readonly string[], at = Date.now()): void {
    withTransaction(this.#db, () => {
      for (const id of ids)
        this.#update(sessionId, id, "state = 'delivering', uncertain = 0, delivered_at = ?", at);
    });
  }

  /** A hand-over the provider refused, or input a stop discarded unseen: back
   *  to `queued` at its old place. False when it is not delivering. */
  requeue(sessionId: string, id: string): boolean {
    const row = this.#row(sessionId, id);
    if (row?.state !== "delivering") return false;
    this.#update(sessionId, id, "state = 'queued', uncertain = 0, delivered_at = NULL");
    return true;
  }

  /**
   * Take back an enqueue that did not take (the session it was for could not
   * be revived): the row goes without a trace, so a retry with its id is a
   * new message. False when it is no longer queued.
   */
  withdraw(sessionId: string, id: string): boolean {
    const { changes } = this.#db
      .prepare("DELETE FROM session_queue WHERE session_id = ? AND id = ? AND state = 'queued'")
      .run(sessionId, id);
    return Number(changes) > 0;
  }

  /** Delivering entries whose fate is unknown. Returns the ids it marked. */
  markUncertain(sessionId: string, ids?: readonly string[]): string[] {
    return withTransaction(this.#db, () => {
      const marked: string[] = [];
      for (const e of this.#live(sessionId)) {
        if (e.state !== "delivering" || e.uncertain) continue;
        if (ids && !ids.includes(e.id)) continue;
        this.#update(sessionId, e.id, "uncertain = 1");
        marked.push(e.id);
      }
      return marked;
    });
  }

  /** The agent took it. Null when the entry is unknown or already settled. */
  markConsumed(sessionId: string, id: string, at = Date.now()): QueueEntry | null {
    return withTransaction(this.#db, () => {
      const row = this.#row(sessionId, id);
      if (!row || (row.state !== "delivering" && row.state !== "queued")) return null;
      this.#settle(sessionId, id, "state = 'consumed', uncertain = 0, consumed_at = ?", at);
      this.#prune(sessionId);
      return this.entry(sessionId, id);
    });
  }

  /**
   * After a daemon restart nothing is mid-hand-over any more: every
   * `delivering` entry may or may not have reached the agent. Marks them
   * uncertain and holds those sessions (`restart`; a hold already set
   * stays as it is). Returns their ids.
   */
  recoverAfterRestart(): string[] {
    return withTransaction(this.#db, () => {
      const rows = this.#db
        .prepare(
          "SELECT DISTINCT session_id AS id FROM session_queue WHERE state = 'delivering' AND uncertain = 0",
        )
        .all() as unknown as Array<{ id: string }>;
      for (const { id } of rows) {
        this.#db
          .prepare(
            "UPDATE session_queue SET uncertain = 1, revision = revision + 1 " +
              "WHERE session_id = ? AND state = 'delivering'",
          )
          .run(id);
        this.applyHold(id, { t: "loom", reason: "restart" });
      }
      return rows.map((r) => r.id);
    });
  }

  /**
   * Keep whole only the most recently settled rows — by settlement, never by
   * `seq`, which puts a head-inserted entry before everything older. The rest
   * leave their id, text hash and fate in `session_queue_seen` (bounded far
   * more generously), so a retried send is answered rather than re-queued.
   */
  #prune(sessionId: string): void {
    const doomed = this.#db
      .prepare(
        "SELECT id, text, state, settled_seq FROM session_queue " +
          `WHERE session_id = ? AND ${SETTLED} ORDER BY settled_seq DESC LIMIT -1 OFFSET ?`,
      )
      .all(sessionId, QUEUE_LIMITS.settled) as unknown as Array<
      Pick<Row, "id" | "text" | "state" | "settled_seq">
    >;
    if (doomed.length === 0) return;
    const trace = this.#db.prepare(
      "INSERT OR REPLACE INTO session_queue_seen " +
        "(session_id, id, text_sha256, state, settled_seq) VALUES (?, ?, ?, ?, ?)",
    );
    const drop = this.#db.prepare("DELETE FROM session_queue WHERE session_id = ? AND id = ?");
    for (const r of doomed) {
      trace.run(sessionId, r.id, sha256(r.text), r.state, r.settled_seq ?? 0);
      drop.run(sessionId, r.id);
    }
    this.#db
      .prepare(
        "DELETE FROM session_queue_seen WHERE session_id = ? AND settled_seq <= (" +
          "SELECT settled_seq FROM session_queue_seen WHERE session_id = ? " +
          "ORDER BY settled_seq DESC LIMIT 1 OFFSET ?)",
      )
      .run(sessionId, sessionId, QUEUE_LIMITS.seen);
  }
}
