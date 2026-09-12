import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { renderToString } from "ink";
import { bindCommand, keyCommand } from "@loom/tui/commands";
import { detailLayout } from "@loom/tui/components";
import {
  commandHints,
  escapePicker,
  initialState,
  reduce,
  selectModel,
  startModelSelection,
} from "@loom/tui/model";
import type { ProviderInfo } from "@loom/core/wire";
import type { PickerDest } from "@loom/tui/overlay";
import { fleet, snap } from "./tui-fixtures.ts";

test("shortcuts resolve the current decision and bind session commands to their target", () => {
  for (const [reason, action] of [
    ["permission", "approve"],
    ["question", "answer"],
    ["plan_review", "planreview"],
  ] as const) {
    const s = snap({ id: "one", status: "awaiting_input", awaitReason: reason });
    const state = reduce(initialState(), fleet([s]));
    const hints = commandHints(state);
    assert.equal(keyCommand(hints, "a", {}), action);
    assert.equal(keyCommand(hints, "m", { meta: true }), null);
    assert.equal(keyCommand(hints, "a", { ctrl: true }), null);
    assert.deepEqual(bindCommand(action, s.id), { tag: "session", name: action, sessionId: "one" });
  }
  assert.equal(bindCommand("send", null), null);
  assert.deepEqual(bindCommand("new", null), { tag: "global", name: "new" });
  const state = reduce(initialState(), fleet([snap({ status: "idle" })]));
  assert.equal(keyCommand(commandHints(state), "v", {}), "filter");
  assert.equal(keyCommand(commandHints(state), "", { tab: true, shift: true }), "mode");
});

test("detail height and click regions agree with rendered rows, including expired limits", () => {
  for (const width of [40, 80, 120]) {
    const layout = detailLayout(
      snap({
        parentId: "parent",
        forkTurn: 2,
        mode: "default",
        resumable: false,
        resumeBlockedReason: "A long explanation that wraps over several rows on a narrow screen.",
        rateLimits: { five_hour: { status: "allowed", resetsAt: 100, utilization: 0.5 } },
      }),
      { width, account: "personal account", queued: ["next task"] },
    );
    for (const now of [50, 150]) {
      const lines = stripVTControlCharacters(renderToString(layout.render(now), { columns: width }))
        .trimEnd()
        .split("\n");
      assert.equal(lines.length, layout.height, `height at ${width} columns, time ${now}`);
      const hit = layout.hits({ x: 0, y: 0 })[0]!;
      assert.equal(lines[hit.y]!.slice(hit.x0, hit.x1 + 1), "mode [manual]");
    }
  }
});

test("one model-selection flow serves new sessions, live sessions, and plans, retaining return context", () => {
  const provider: ProviderInfo = {
    id: "test",
    models: ["model"],
    defaultModel: "model",
    defaultEffort: "",
    defaultMode: "default",
    tag: "test",
    color: "",
    isDefault: true,
    modelChoices: [{ id: "model", label: "Model", supportsEffort: true, effortLevels: ["high"] }],
  };
  const state = reduce(
    initialState(),
    fleet([snap({ id: "session", provider: "test" })], [provider]),
  );
  const destinations: PickerDest[] = [
    { t: "session", sessionId: "session", back: "unfinished message" },
    {
      t: "newSession",
      settings: { provider: "test", model: "model", effort: null, mode: "plan" },
      draft: "new task",
    },
    {
      t: "planImpl",
      plan: {
        sessionId: "session",
        requestId: "review",
        text: "the plan",
        mode: "auto",
        impl: null,
      },
    },
  ];
  for (const dest of destinations) {
    const opened = startModelSelection(state, dest, { provider: "test", model: "model" });
    assert.equal(opened.t, "picker");
    if (opened.t !== "picker") throw new Error("expected picker");
    const next = selectModel(state, opened.picker);
    assert.equal(next.tag, "show");
    if (next.tag !== "show" || next.overlay.t !== "picker")
      throw new Error("expected effort picker");
    const back = escapePicker(next.overlay.picker, state);
    assert.equal(back.t, "picker");
    if (back.t !== "picker") throw new Error("expected model picker");
    assert.equal(back.picker.dest, dest);
    const cancelled = escapePicker(back.picker, state);
    assert.equal(cancelled.t, dest.t === "planImpl" ? "plan" : "prompt");
    const result = selectModel(state, next.overlay.picker);
    assert.deepEqual(result, {
      tag: "selected",
      dest,
      selection: { provider: "test", model: "model", effort: "high" },
    });
  }
});
