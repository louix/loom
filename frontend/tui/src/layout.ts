/** Rows are shared by rendering, measurement, and hit testing. Coordinates are local. */
export type LayoutRow<A, K extends string> =
  | { tag: "space" }
  | { tag: "content"; value: A }
  | { tag: "target"; value: A; kind: K; x: number; width: number };

export interface LayoutHit<K extends string> {
  kind: K;
  x0: number;
  x1: number;
  y: number;
}

export const rowLayout = <A, K extends string>(
  width: number,
  rows: readonly LayoutRow<A, K>[],
  inset = { x: 0, y: 0 },
) => ({
  rows,
  height: rows.length + 2 * inset.y,
  hits: (origin: { x: number; y: number }): LayoutHit<K>[] =>
    rows.flatMap((row, i) => {
      if (row.tag !== "target") return [];
      const x0 = origin.x + inset.x + row.x;
      const x1 = Math.min(x0 + row.width - 1, origin.x + width - inset.x - 1);
      return x0 > x1 ? [] : [{ kind: row.kind, x0, x1, y: origin.y + inset.y + i }];
    }),
});
