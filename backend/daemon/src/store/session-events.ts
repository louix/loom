/**
 * Durable per-session transcript. `session.events` pages over this table on
 * attach, reconnect and scrollback; live events carry these same row ids.
 *
 * A row's `id` is its identity everywhere: it is what the live push carries,
 * what a page returns, and what the next page's cursor is expressed in. Being
 * the rowid it is assigned by the insert, so it is monotonic within a session
 * across any number of daemon restarts — unlike the event timestamps, which
 * tie inside a millisecond and can arrive out of order.
 */
import type { HarnessEvent } from "@loom/core/events";
import type { HistoryPage, TranscriptEntry, TranscriptId } from "@loom/core/wire";
import type { Db } from "./db.ts";

interface Row {
  id: number;
  payload: string;
}

/** Rows per page when the caller doesn't say. Matches the daemon's RPC default. */
const DEFAULT_LIMIT = 500;

export class SessionEventStore {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Record one event and return the durable id the insert assigned it. */
  append(sessionId: string, event: HarnessEvent): TranscriptId {
    const info = this.#db
      .prepare("INSERT INTO session_events (session_id, type, payload, ts) VALUES (?, ?, ?, ?)")
      .run(sessionId, event.type, JSON.stringify(event), event.ts);
    return Number(info.lastInsertRowid);
  }

  /** Message recall is independent of intervening tool traffic. Newest 50,
   * distinct texts, returned oldest-first for the editor's Up-arrow walk. */
  messages(sessionId: string): string[] {
    const rows = this.#db
      .prepare(`
      SELECT json_extract(payload, '$.text') AS text FROM session_events
      WHERE session_id = ? AND type = 'user_message'
      GROUP BY json_extract(payload, '$.text') ORDER BY MAX(id) DESC LIMIT 50
    `)
      .all(sessionId) as unknown as { text: string }[];
    return rows.reverse().map((row) => row.text);
  }

  /**
   * One page of `sessionId`'s transcript, oldest-first, ending at the newest
   * row (or at `olderThan`, exclusive, when paging backwards). Both queries
   * ride the `(session_id, id)` index.
   *
   * `limit + 1` rows are read so exhaustion is *observed* rather than inferred
   * from a short page: a page that happens to end exactly on the oldest row
   * would otherwise be indistinguishable from one with more behind it, and the
   * client would either stop early or ask forever.
   */
  page(sessionId: string, opts: { limit?: number; olderThan?: TranscriptId } = {}): HistoryPage {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const rows = (opts.olderThan === undefined
      ? this.#db
          .prepare(
            "SELECT id, payload FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT ?",
          )
          .all(sessionId, limit + 1)
      : this.#db
          .prepare(
            "SELECT id, payload FROM session_events WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
          )
          .all(sessionId, opts.olderThan, limit + 1)) as unknown as Row[];
    const hasOlder = rows.length > limit;
    const kept = hasOlder ? rows.slice(0, limit) : rows;
    const items: TranscriptEntry[] = kept
      .reverse()
      .map((r) => ({ id: r.id, event: JSON.parse(r.payload) as HarnessEvent }));
    const oldest = items[0];
    return {
      items,
      olderCursor: hasOlder && oldest ? { olderThan: oldest.id } : null,
    };
  }
}
