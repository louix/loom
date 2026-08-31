/**
 * A single-consumer async queue. Producers `push` values (or `close` the
 * stream); one consumer drains them with `for await`. Values pushed before the
 * consumer asks for them are buffered in order. Used to merge a provider SDK's
 * message iterator with out-of-band callback events (permission prompts) into
 * the one `HarnessEvent` stream an adapter exposes.
 */
export class AsyncChannel<T> implements AsyncIterable<T> {
  #queue: T[] = [];
  #waiters: Array<(r: IteratorResult<T>) => void> = [];
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  /** Buffered items not yet handed to the consumer. */
  get pending(): number {
    return this.#queue.length;
  }

  /** Discard buffered items the consumer hasn't taken yet; keep the stream open. */
  drain(): void {
    this.#queue.length = 0;
  }

  push(value: T): void {
    if (this.#closed) return;
    const w = this.#waiters.shift();
    if (w) w({ done: false, value });
    else this.#queue.push(value);
  }

  /** End the stream. The consumer's loop finishes once the buffer drains. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w({ done: true, value: undefined as never });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
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
  }
}
