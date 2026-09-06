/**
 * Four states for a fetch, so "never asked" and "asked, still waiting" render
 * differently and a failure is a value the view must handle rather than a
 * swallowed `.catch`. `idle` is the seed a consumer supplies; `pending` is what
 * the producer sets once work starts.
 */
import { absurd } from "@loom/core/absurd";

export type Loadable<E, A> =
  | { readonly tag: "idle" }
  | { readonly tag: "pending" }
  | { readonly tag: "error"; readonly error: E }
  | { readonly tag: "data"; readonly value: A };

export const loadableIdle: Loadable<never, never> = { tag: "idle" };
export const loadablePending: Loadable<never, never> = { tag: "pending" };
export const loadableFailed = <E>(error: E): Loadable<E, never> => ({ tag: "error", error });
export const loadableLoaded = <A>(value: A): Loadable<never, A> => ({ tag: "data", value });

interface FoldLoadable<E, A, B> {
  readonly onIdle: () => B;
  readonly onPending: () => B;
  readonly onError: (error: E) => B;
  readonly onData: (value: A) => B;
}

export const foldLoadable =
  <E, A, B>(fns: FoldLoadable<E, A, B>) =>
  (x: Loadable<E, A>): B => {
    switch (x.tag) {
      case "idle":
        return fns.onIdle();
      case "pending":
        return fns.onPending();
      case "error":
        return fns.onError(x.error);
      case "data":
        return fns.onData(x.value);
      default:
        return absurd(x);
    }
  };

export const loadableToUndefined = <E, A>(x: Loadable<E, A>): A | undefined =>
  x.tag === "data" ? x.value : undefined;
