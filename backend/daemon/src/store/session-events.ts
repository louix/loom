/**
 * Durable per-session event history. The cross-session in-memory `EventLog`
 * ring (`../daemon/event-log.ts`) only covers a live client's reconnect gap —
 * it's shared by every session and doesn't survive a restart. This table is
 * the record a client backfills from when a session's own history has fallen
 * out of that ring (or the daemon restarted since).
 */
import type { HarnessEvent } from "@loom/core/events";
import type { EventPush } from "@loom/core/wire";
import type { Db } from "./db.ts";

interface Row {
  seq: number;
  payload: string;
}

export class SessionEventStore {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Record one event. `seq` is the daemon's global `EventLog` frame seq, so a
   *  replayed row dedupes identically to a live push on the client. */
  append(sessionId: string, seq: number, event: HarnessEvent): void {
    this.#db
      .prepare(
        "INSERT INTO session_events (session_id, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sessionId, seq, event.type, JSON.stringify(event), event.ts);
  }

  /** The session's persisted history as push frames, oldest first, capped to
   *  the most recent `limit` (default 500 — see the daemon's RPC handler). */
  list(sessionId: string, opts: { limit?: number } = {}): EventPush[] {
    const limit = opts.limit ?? 500;
    const rows = this.#db
      .prepare(
        "SELECT seq, payload FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(sessionId, limit) as unknown as Row[];
    return rows
      .reverse()
      .map((r) => ({
        kind: "push",
        type: "event",
        seq: r.seq,
        event: JSON.parse(r.payload) as HarnessEvent,
      }));
  }
}
