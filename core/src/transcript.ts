/**
 * The conversation-history store a connector uses when the provider keeps no
 * server-side memory (the aisdk case — Loom owns the whole `ModelMessage[]`).
 * The concrete implementation lives in `@loom/daemon` over the SQLite
 * `provider_messages` table; this is the surface it exposes to a connector.
 *
 * `TranscriptMessage` is structural on purpose — `@loom/core` pulls in no
 * model SDK, and a real `ModelMessage` is a superset of this shape.
 */
export interface TranscriptMessage {
  readonly role: string;
  readonly content: unknown;
}

export interface TranscriptStore {
  /** The session's messages, in order. */
  load(sessionId: string): TranscriptMessage[];
  /** How many messages are stored for the session. */
  count(sessionId: string): number;
  /** Append after whatever is already stored. */
  append(sessionId: string, messages: readonly TranscriptMessage[]): void;
  /** Drop every message from `fromSeq` on, then append `messages` in its place. */
  replaceFrom(sessionId: string, fromSeq: number, messages: readonly TranscriptMessage[]): void;
  /** Remove all of the session's messages. */
  clear(sessionId: string): void;
  /** Copy `fromId`'s whole transcript into a fresh `toId` (a hard fork). */
  copyTo(fromId: string, toId: string): void;
}
