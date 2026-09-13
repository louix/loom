import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "ink";
import { Picker } from "@loom/tui/components";
import { makePicker } from "@loom/tui/overlay";

const draw = (width: number, label: string, hint?: string): string =>
  renderToString(
    createElement(Picker, {
      picker: makePicker({
        step: "command",
        title: "commands",
        dest: { t: "command" },
        items: [{ id: "example", label, ...(hint ? { hint } : {}) }],
      }),
      width,
      height: 20,
    }),
    { columns: width },
  );

test("picker labels use room left by short or absent hints", () => {
  const label = "prepare repo environment for future sessions";
  for (const hint of [undefined, "P"]) {
    const output = draw(64, label, hint);
    assert.ok(output.includes(label), output);
    if (hint) assert.match(output, /sessions +P/);
  }
});

test("picker hints can use the available width beyond 28 columns", () => {
  const hint = "a detailed description of the available provider and model";
  const output = draw(100, "provider", hint);
  assert.ok(output.includes(hint), output);
});

test("picker rows stay on one line within narrow terminals", () => {
  const output = draw(40, "a very long command description ".repeat(4), "shortcut");
  const rows = output.split("\n");
  assert.equal(rows.filter((line) => line.includes("▍ a")).length, 1);
  assert.ok(
    rows.every((line) => Array.from(line).length <= 40),
    output,
  );
  assert.ok(output.includes("…"), output);
  assert.equal(rows.length, draw(40, "short", "key").split("\n").length);
});
