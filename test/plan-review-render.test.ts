import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createElement } from "react";
import { renderToString } from "ink";
import { PlanReview } from "@loom/tui/components";

test("plan review fills its viewport and keeps every advertised row visible", () => {
  for (const width of [60, 120]) {
    for (const height of [24, 80]) {
      for (const scroll of [0, 15, 30, 999]) {
        const plan = {
          mode: "acceptEdits" as const,
          text: Array.from(
            { length: 140 },
            (_, i) => `row-${i.toString().padStart(3, "0")} ` + "x".repeat(width - 13),
          ).join("\n"),
        };
        const rendered = stripVTControlCharacters(
          renderToString(
            createElement(PlanReview, {
              plan,
              width,
              height,
              scroll,
              ctx: { used: 39_000, limit: 200_000 },
              cur: { provider: "claude", model: "claude-haiku-4-5-20251001" },
            }),
            { columns: width },
          ),
        );
        const rows = rendered.split("\n");
        assert.equal(rows.length, height, `fixed viewport at ${width}×${height}, scroll ${scroll}`);
        const range = rendered.match(/lines (\d+)–(\d+) of (\d+)/);
        assert.ok(range, "scroll range is visible");
        const first = Number(range[1]);
        const last = Number(range[2]);
        for (let row = first; row <= last; row++) {
          assert.ok(
            rendered.includes(`row-${(row - 1).toString().padStart(3, "0")}`),
            `advertised row ${row} is visible at scroll ${scroll}`,
          );
        }
        assert.match(rows.at(-2)!, /view read-only/, "actions stay anchored at the bottom");
      }
    }
  }
});

test("short plans keep controls anchored with optional context and fork metadata", () => {
  for (const ctx of [
    { used: 39_000, limit: 200_000 },
    { used: 0, limit: 0 },
  ]) {
    for (const provider of ["claude", "other"]) {
      const rows = stripVTControlCharacters(
        renderToString(
          createElement(PlanReview, {
            plan: { text: "# Short plan\n\nImplement this.", mode: "acceptEdits" },
            width: 100,
            height: 40,
            ctx,
            cur: { provider: "claude" },
            impl: { provider },
          }),
          { columns: 100 },
        ),
      ).split("\n");
      assert.equal(rows.length, 40);
      assert.match(rows[3]!, /# Short plan/);
      assert.match(rows.at(-2)!, /view read-only/);
      assert.equal(
        rows.some((row) => row.includes("fresh forked session")),
        provider !== "claude",
      );
    }
  }
});
