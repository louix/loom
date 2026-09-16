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

test("repository picker filters full paths and explains an empty history", async () => {
  const { repositoryPicker } = await import("../frontend/tui/src/repositories.ts");
  const { pickerVisible } = await import("@loom/tui/overlay");
  const { buffer } = await import("@loom/tui/editor");
  const picker = repositoryPicker(["/work/one/project", "/work/two/project"], "/work/one/project");
  assert.match(picker.items[0]!.hint!, /current/);
  picker.filter = buffer("/two/");
  assert.equal(pickerVisible(picker)[0]?.id, "/work/two/project");
  assert.equal(pickerVisible(picker).length, 1);
  const empty = renderToString(
    createElement(Picker, {
      picker: repositoryPicker([]),
      width: 100,
      height: 20,
    }),
  );
  assert.match(empty, /No recent repositories/);
});
