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
  epoch: string;
  payload: string;
}

export class SessionEventStore {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Record one event. `seq` is the daemon's global `EventLog` frame seq, so a
   *  replayed row dedupes identically to a live push on the client — provided
   *  the frame's `epoch` rides along too: the seq counter restarts with every
   *  daemon, so (epoch, seq) is the real identity. */
  append(sessionId: string, seq: number, epoch: string, event: HarnessEvent): void {
    this.#db
      .prepare(
        "INSERT INTO session_events (session_id, seq, epoch, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(sessionId, seq, epoch, event.type, JSON.stringify(event), event.ts);
  }

  /** The session's persisted history as push frames, oldest first, capped to
   *  the most recent `limit` (default 500 — see the daemon's RPC handler).
   *
   *  `before` pages backwards for scroll-back: pass the (epoch, seq) of the
   *  earliest frame the client holds and this returns the `limit` rows strictly
   *  older than it. `id` (insertion order) is the only key that stays monotonic
   *  across daemon epochs — `seq` restarts per process — so the cursor frame's
   *  rowid is resolved first. That lookup scans one session's rows (there's no
   *  index past `session_id`), but it only runs on a manual scroll-back, never
   *  on the hot path. A short page means there is nothing older. */
  list(
    sessionId: string,
    opts: { limit?: number; before?: { epoch: string; seq: number } } = {},
  ): EventPush[] {
    const limit = opts.limit ?? 500;
    let beforeId: number | null = null;
    if (opts.before) {
      const row = this.#db
        .prepare("SELECT id FROM session_events WHERE session_id = ? AND epoch = ? AND seq = ?")
        .get(sessionId, opts.before.epoch, opts.before.seq) as { id: number } | undefined;
      // Unknown cursor (stale epoch, bad param) — report "nothing older" rather
      // than silently handing back the newest page again.
      if (!row) return [];
      beforeId = row.id;
    }
    const rows = (beforeId === null
      ? this.#db
          .prepare(
            "SELECT seq, epoch, payload FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT ?",
          )
          .all(sessionId, limit)
      : this.#db
          .prepare(
            "SELECT seq, epoch, payload FROM session_events WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
          )
          .all(sessionId, beforeId, limit)) as unknown as Row[];
    return rows.reverse().map((r) => ({
      kind: "push",
      type: "event",
      seq: r.seq,
      epoch: r.epoch,
      event: JSON.parse(r.payload) as HarnessEvent,
    }));
  }
}
