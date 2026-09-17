import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { Box, Text, renderToString } from "ink";
import { NewSessionModal, newSessionLayout, SelectionModal } from "@loom/tui/components";
import { initialState } from "@loom/tui/model";
import { newPrompt, makePicker, type PickerStep } from "@loom/tui/overlay";

test("every picker floats over the fleet with the selected row and actions in view", () => {
  const steps: PickerStep[] = ["provider", "model", "effort", "command", "repository", "undo"];
  for (const step of steps) {
    for (const [cols, rows] of [
      [120, 40],
      [80, 24],
      [44, 18],
      [32, 12],
    ] as const) {
      const picker = makePicker({
        step,
        title: step,
        dest: { t: "command" },
        index: 19,
        items: Array.from({ length: 20 }, (_, i) => ({ id: String(i), label: `choice ${i}` })),
      });
      const state = { ...initialState(), overlay: { t: "picker" as const, picker } };
      const frame = renderToString(
        h(
          Box,
          { width: cols, height: rows, flexDirection: "column" },
          ...Array.from({ length: rows }, (_, i) => h(Text, { key: i }, "Z".repeat(cols))),
          h(SelectionModal, { state, cols, rows }),
        ),
        { columns: cols },
      );
      const lines = frame.split("\n");
      assert.equal(lines.length, rows);
      assert.match(frame, /▍ choice 19/);
      assert.match(frame, /enter pick · esc cancel/);
      const top = lines.findIndex((line) => line.includes("╭"));
      const bottom = lines.findIndex((line) => line.includes("╰"));
      const left = lines[top]!.indexOf("╭");
      const right = lines[top]!.indexOf("╮");
      assert.ok(bottom > top);
      for (const line of lines.slice(top, bottom + 1)) {
        assert.ok(!line.slice(left, right + 1).includes("Z"), frame);
      }
      if (left > 0) assert.equal(lines[top]![0], "Z");
    }
  }
});

test("confirmation dialogs keep their border and action inside a short terminal", () => {
  const state = {
    ...initialState(),
    overlay: {
      t: "confirm" as const,
      confirm: {
        action: "deleteSession" as const,
        sessionId: "a",
        title: "Delete session?",
        danger: true,
        body: "Uncommitted changes will be lost. ".repeat(10),
        branchName: "feature",
        deleteBranch: false,
      },
    },
  };
  const frame = renderToString(
    h(Box, { width: 60, height: 16 }, h(SelectionModal, { state, cols: 60, rows: 16 })),
    { columns: 60 },
  );
  assert.equal(frame.split("\n").length, 16);
  assert.match(frame, /Delete session/);
  assert.match(frame, /enter/);
  assert.match(frame, /╰.*╯/);
});

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
