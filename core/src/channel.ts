/**
 * A single-consumer async queue. Producers `push` values (or `close` the
 * stream); one consumer drains them with `for await`. Values pushed before the
 * consumer asks for them are buffered in order. Used to merge a provider SDK's
 * message iterator with out-of-band callback events (permission prompts) into
 * the one `HarnessEvent` stream an adapter exposes.
 */

/**
 * Default ceiling on buffered-but-unconsumed items. `push` is synchronous and
 * can't block the SDK stream that feeds it, so on overflow it drops the oldest
 * item and bumps {@link AsyncChannel.dropped} rather than grow without bound.
 * Large enough that a healthy consumer never hits it; small enough to bound a
 * wedged one.
 */
const DEFAULT_CAPACITY = 10_000;

export class AsyncChannel<T> implements AsyncIterable<T> {
  #queue: T[] = [];
  #waiters: Array<(r: IteratorResult<T>) => void> = [];
  #closed = false;
  #consumed = false;
  readonly #capacity: number;
  #dropped = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.#capacity = Math.max(1, capacity);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Buffered items not yet handed to the consumer. */
  get pending(): number {
    return this.#queue.length;
  }

  /** Items discarded because the buffer was at capacity when they arrived. */
  get dropped(): number {
    return this.#dropped;
  }

  /** Discard buffered items the consumer hasn't taken yet; keep the stream open. */
  drain(): void {
    this.#queue.length = 0;
  }

  push(value: T): void {
    if (this.#closed) return;
    const w = this.#waiters.shift();
    if (w) {
      w({ done: false, value });
      return;
    }
    if (this.#queue.length >= this.#capacity) {
      // The consumer has fallen catastrophically behind (stalled persistence, a
      // hung downstream). Keep memory bounded; the owner can watch `dropped`.
      this.#queue.shift();
      this.#dropped += 1;
    }
    this.#queue.push(value);
  }

  /** End the stream. The consumer's loop finishes once the buffer drains. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w({ done: true, value: undefined as never });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    // Single-consumer: two concurrent iterators would each park waiters and
    // split the stream between them with no ordering guarantee. A *sequential*
    // re-iteration (drain, break, drain again) is fine — the flag clears when
    // the generator returns / is `.return()`d on break.
    if (this.#consumed) {
      throw new Error("AsyncChannel is single-consumer and is already being iterated");
    }
    this.#consumed = true;
    try {
      for (;;) {
        if (this.#queue.length > 0) {
          yield this.#queue.shift() as T;
          continue;
        }
        if (this.#closed) return;
        const r = await new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
        if (r.done) return;
        yield r.value;
      }
    } finally {
      this.#consumed = false;
    }
  }
}
