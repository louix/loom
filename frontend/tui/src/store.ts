/**
 * The minimum observable-ish container: one current value, listeners notified
 * on change, a synchronous read for code paths that run before React re-renders
 * (the keymap). Shaped for `useSyncExternalStore` — `subscribe` returns its own
 * unsubscribe, `get` is the snapshot.
 *
 * Not RxJS: there are no operators and no multicasting to get right because the
 * fleet handle keeps exactly one of these and derives the view eagerly. The
 * synchronous `get` is safe here — the only writer is the handle's `reduce`,
 * and Node runs it on one thread with nothing to interleave.
 */
export interface Store<A> {
  readonly get: () => A;
  readonly set: (next: A) => void;
  readonly subscribe: (onChange: () => void) => () => void;
}

export const mkStore = <A>(seed: A): Store<A> => {
  let value = seed;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      for (const l of listeners) l();
    },
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => void listeners.delete(onChange);
    },
  };
};
