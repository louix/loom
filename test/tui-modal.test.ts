import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { Box, Text, renderToString } from "ink";
import { NewSessionModal, newSessionLayout } from "@loom/tui/components";
import { initialState } from "@loom/tui/model";
import { newPrompt } from "@loom/tui/overlay";

test("isolation feedback is visible inside the modal without hiding the draft", () => {
  const prompt = newPrompt(
    { mode: "plan", provider: "fake", model: "model", effort: null },
    "keep this draft",
  );
  prompt.feedback = { pending: false, text: "No VM runtime is configured" };
  const state = { ...initialState(), overlay: { t: "prompt" as const, prompt } };
  const frame = renderToString(
    h(Box, { width: 80, height: 24 }, h(NewSessionModal, { state, cols: 80, rows: 24 })),
    { columns: 80 },
  );
  assert.match(frame, /No VM runtime is configured/);
  assert.match(frame, /keep this draft/);
  assert.match(frame, /enter start session/);
});

test("new-session modal covers the background and keeps its mode hit aligned after wrapping", () => {
  for (const [cols, rows] of [
    [120, 40],
    [80, 24],
    [44, 18],
    [32, 12],
  ]) {
    for (const draft of ["", "A long prompt ".repeat(100)]) {
      const prompt = newPrompt(
        { mode: "plan", provider: "fake", model: "model", effort: null },
        draft,
      );
      const state = { ...initialState(), overlay: { t: "prompt" as const, prompt } };
      const g = newSessionLayout(prompt, cols!, rows!);
      const frame = renderToString(
        h(
          Box,
          { width: cols, height: rows, flexDirection: "column" },
          ...Array.from({ length: rows! }, (_, i) => h(Text, { key: i }, "Z".repeat(cols!))),
          h(NewSessionModal, { state, cols: cols!, rows: rows! }),
        ),
        { columns: cols! },
      );
      const lines = frame.split("\n");
      assert.equal(lines.length, rows);
      assert.match(frame, /✦ new session/);
      assert.match(frame, /enter start session/);
      const inputRow = lines.findIndex((line) => /▍|⋮/.test(line));
      const lastInputRow = lines.findLastIndex((line) => /▍|⋮/.test(line));
      assert.ok(lastInputRow < lines.findIndex((line) => line.includes("enter start session")));
      assert.ok(inputRow > lines.findIndex((line) => line.includes("fake / model")));
      assert.ok(inputRow > g.modeY - 1);
      assert.equal(lines[g.modeY - 1]?.slice(g.modeX - 1, g.modeX + 5), "[plan]");
      assert.equal(lines[g.top]?.[g.left], "╭");
      assert.equal(lines[g.top + g.height - 1]?.[g.left], "╰");
      for (const line of lines.slice(g.top, g.top + g.height)) {
        assert.ok(
          !line.slice(g.left, g.left + g.width).includes("Z"),
          "modal must erase underlying text",
        );
      }
      if (g.left > 0) assert.equal(lines[g.top]?.[0], "Z", "fleet remains visible beside modal");
    }
  }
});
