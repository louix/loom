/**
 * Typed `(_: never) => A`. Calling it is a compile error unless the value
 * narrowed to `never` — put it in a `switch`'s `default` so adding a union
 * variant fails to compile at that site, and throws with the offending value
 * if one slips through at runtime.
 */
export const absurd = <A>(x: never): A => {
  throw new Error(`absurd: unreachable value ${JSON.stringify(x)}`);
};
