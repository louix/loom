import type { PushFrame } from "@loom/core/wire";

/** A push frame before it has been assigned a sequence number and epoch. */
export type UnsequencedPush =
  | Omit<Extract<PushFrame, { type: "event" }>, "seq" | "epoch">
  | Omit<Extract<PushFrame, { type: "resync" }>, "seq">
  | Omit<Extract<PushFrame, { type: "notice" }>, "seq">;

export interface ReplayResult {
  /** Buffered frames strictly after the requested seq, in order. */
  frames: PushFrame[];
  /**
   * True when the requested seq is older than the oldest buffered frame, i.e.
   * the buffer has rolled and the client has an unrecoverable gap. The caller
   * should send a `resync` and rely on a fresh snapshot.
   */
  rolled: boolean;
}

/**
 * In-memory, sequenced ring buffer for the server -> client push stream.
 *
 * Every appended frame gets a strictly increasing `seq` starting at 1. The
 * buffer keeps at most `capacity` frames; older ones are dropped. Its only job
 * is to cover a *client* reconnect gap — nothing here survives a daemon
 * restart, matching the contract in the design spec (§2, Transport & reconnect).
 */
export class EventLog {
  #capacity: number;
  /** Issued with every frame — `seq` resets per process, the epoch doesn't. */
  readonly #epoch: string;
  #buf: PushFrame[] = [];
  #seq = 0;
  #listeners = new Set<(f: PushFrame) => void>();

  constructor(capacity: number, epoch: string) {
    if (capacity < 1) throw new Error("event log capacity must be >= 1");
    if (!epoch) throw new Error("event log epoch must be non-empty");
    this.#capacity = capacity;
    this.#epoch = epoch;
  }

  /** Sequence number of the most recently appended frame (0 if none yet). */
  get head(): number {
    return this.#seq;
  }

  /** Oldest sequence number still held in the buffer (0 if empty). */
  get oldest(): number {
    const first = this.#buf[0];
    return first ? first.seq : 0;
  }

  get size(): number {
    return this.#buf.length;
  }

  /** Assign the next seq, stamp the epoch, buffer the frame, and fan it out. */
  append(frame: UnsequencedPush): PushFrame {
    const sequenced = { ...frame, seq: ++this.#seq, epoch: this.#epoch } as PushFrame;
    this.#buf.push(sequenced);
    if (this.#buf.length > this.#capacity) this.#buf.shift();
    for (const l of this.#listeners) {
      try {
        l(sequenced);
      } catch {
        // a broken listener must not stall the fan-out
      }
    }
    return sequenced;
  }

  /**
   * Frames after `sinceSeq`. If `sinceSeq` is 0 / undefined the caller wants
   * everything currently buffered. `rolled` is true when frames the caller
   * needs have already been evicted — including the `sinceSeq: 0` case, where a
   * `replayHistory` client wants *all* history but the buffer has dropped its
   * start (`oldest > 1`).
   */
  since(sinceSeq: number | undefined): ReplayResult {
    const from = sinceSeq ?? 0;
    // Client claims a seq we never issued — almost always a daemon restart that
    // reset the counter while the client held a stale high-water mark.
    if (from > this.#seq) return { frames: [], rolled: true };
    if (from === this.#seq) return { frames: [], rolled: false };
    const rolled = from < this.oldest - 1;
    const frames = this.#buf.filter((f) => f.seq > from);
    return { frames, rolled };
  }

  /** Subscribe to live frames. Returns an unsubscribe function. */
  subscribe(fn: (f: PushFrame) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}
