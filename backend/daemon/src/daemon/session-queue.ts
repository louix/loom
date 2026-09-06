/**
 * Per-session serialization for whole commands.
 *
 * A mode / model / effort change is not one step but four — validate, apply to
 * the adapter, write the registry and the provider defaults, publish a
 * snapshot. Serializing only the adapter call leaves the rest interleaved: two
 * clients changing the same session's mode can have their adapter calls resolve
 * in one order and their registry writes land in the other, so the live session
 * and the row every client reads settle on different values with nothing to
 * detect it. Running each command whole under one key fixes an order and makes
 * "last one wins" true of the pair rather than of each half separately.
 *
 * Lifecycle ops (`markDone` / `remove` / `gc`) share the chain: they are the
 * commands that can invalidate a queued configuration change, and sharing is
 * what lets a queued command's existence recheck be conclusive rather than a
 * narrower race.
 *
 * Distinct keys never wait on each other, and this chain is independent of the
 * session manager's turn gate. The edge between them is one-way — a queued
 * command may take the turn gate, nothing holding the turn gate waits here — so
 * the two cannot deadlock against each other.
 */

export interface SessionQueue {
  /** Run `op` after every op already queued under `key` has settled. */
  run<T>(key: string, op: () => Promise<T>): Promise<T>;
  /** Keys with an op queued or running — for assertions and diagnostics. */
  readonly activeKeys: readonly string[];
}

export const mkSessionQueue = (): SessionQueue => {
  const tails = new Map<string, Promise<unknown>>();

  const run = <T>(key: string, op: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    // Building and installing the new tail MUST stay synchronous — an `await`
    // before the `set` would let a second caller read the same `prev` and run
    // concurrently, which is the whole thing this exists to prevent.
    const result = prev.then(op);
    // The tail swallows failures so one rejected command doesn't reject every
    // command queued behind it; `result` still carries the failure to its own
    // caller. Chains are dropped once they drain, so keys don't accumulate for
    // sessions that have gone away.
    const tail: Promise<unknown> = result.then(
      () => {},
      () => {},
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };

  return {
    run,
    get activeKeys(): readonly string[] {
      return [...tails.keys()];
    },
  };
};
