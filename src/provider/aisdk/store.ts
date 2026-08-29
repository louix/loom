/**
 * Conversation persistence for the aisdk provider. Unlike the Claude adapter —
 * where the CLI owns the transcript and `resume` replays it — an
 * OpenAI-compatible session has no server-side memory, so Loom keeps the whole
 * `ModelMessage[]` here. `providerRef` for these sessions is just the Loom
 * session id; `resumeSession` rebuilds the array from these rows.
 */
import type { ModelMessage } from "ai";
import type { Db } from "../../store/db.ts";

interface Row {
  seq: number;
  content: string;
}

export class ProviderMessageStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** The session's messages in order. */
  load(sessionId: string): ModelMessage[] {
    const rows = this.#db
      .prepare("SELECT seq, content FROM provider_messages WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as unknown as Row[];
    return rows.map((r) => JSON.parse(r.content) as ModelMessage);
  }

  /** How many messages are stored for the session. */
  count(sessionId: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM provider_messages WHERE session_id = ?")
      .get(sessionId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Append messages after whatever is already stored. */
  append(sessionId: string, messages: ModelMessage[]): void {
    if (messages.length === 0) return;
    const startRow = this.#db
      .prepare("SELECT COALESCE(MAX(seq), -1) AS max FROM provider_messages WHERE session_id = ?")
      .get(sessionId) as { max: number } | undefined;
    let seq = (startRow?.max ?? -1) + 1;
    const now = Date.now();
    const stmt = this.#db.prepare(
      "INSERT INTO provider_messages (session_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const m of messages) {
      stmt.run(sessionId, seq++, m.role, JSON.stringify(m), now);
    }
  }

  /**
   * Drop every message from `fromSeq` onward, then append `messages` in its
   * place. Used by compaction (M10d) to swap the tail for a summary.
   */
  replaceFrom(sessionId: string, fromSeq: number, messages: ModelMessage[]): void {
    const n = this.count(sessionId);
    if (fromSeq > n) {
      // Would silently DELETE nothing and then append at `n` rather than at
      // `fromSeq` — the caller's mental model (a stale/post-compaction offset)
      // is wrong. Fail loudly instead.
      throw new Error(`replaceFrom: fromSeq ${fromSeq} is past the end (${n} messages)`);
    }
    this.#db
      .prepare("DELETE FROM provider_messages WHERE session_id = ? AND seq >= ?")
      .run(sessionId, fromSeq);
    this.append(sessionId, messages);
  }

  clear(sessionId: string): void {
    this.#db.prepare("DELETE FROM provider_messages WHERE session_id = ?").run(sessionId);
  }

  /** Copy `fromId`'s whole transcript into `toId` (a fresh session — a hard fork). */
  copyTo(fromId: string, toId: string): void {
    if (this.count(toId) > 0) {
      throw new Error(`copyTo: destination ${toId} already has messages`);
    }
    this.#db
      .prepare(
        "INSERT INTO provider_messages (session_id, seq, role, content, created_at) " +
          "SELECT ?, seq, role, content, created_at FROM provider_messages WHERE session_id = ?",
      )
      .run(toId, fromId);
  }
}
