import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createElement } from "react";
import { PALETTES } from "@loom/tui/theme";
import { Fields, Line, Lines, PaletteContext } from "@loom/tui/ui";
import { Doctor } from "@loom/tui/components";
import { Box, renderToString } from "ink";
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

test("shared text and fields retain blank rows and label gutters in narrow panes", () => {
  const rendered = renderToString(
    createElement(
      Box,
      { width: 16, flexDirection: "column" },
      createElement(Line, null, "start"),
      createElement(Lines, { lines: ["", "middle", ""] }),
      createElement(Fields, {
        width: 4,
        wrap: "truncate-end",
        rows: [
          ["i", "a long action that must stay on one row"],
          ["omit", null],
          ["n", 0],
        ],
      }),
    ),
    { columns: 16 },
  );
  const rows = stripVTControlCharacters(rendered)
    .split("\n")
    .map((row) => row.trimEnd());
  assert.deepEqual(rows.slice(0, 4), ["start", "", "middle", ""]);
  assert.equal(rows.length, 6);
  assert.ok(rows[4]!.startsWith("i   a long"));
  assert.equal(rows[5], "n   0");
});

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
        costUsd: 1,
        costSource: "provider",
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
      assert.ok(
        lines.some((line) => line.includes("$1.00")),
        "cost suffix remains readable",
      );
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

test("prepared detail and doctor resolve every theme without changing their geometry", () => {
  const report = {
    daemon: {
      pid: 1,
      version: "0.0.1",
      startedAt: 0,
      uptimeMs: 5,
      epoch: "e",
      repoRoot: "/r",
      clients: 1,
      connections: 1,
      eventSeq: 3,
      sessions: 1,
      runningSessions: 1,
    },
    connectors: [{ pkg: "@loom/connector-claude", providerIds: ["claude"], loaded: false }],
    mcp: [
      {
        name: "tilth",
        command: "tilth --mcp --edit",
        resolved: "tilth --mcp --edit",
        status: "ok" as const,
        note: "",
      },
    ],
    tools: {
      loom: ["ask_user", "commit"],
      claude: [],
      aisdk: [],
      claudeDisabled: ["Grep", "Glob"],
    },
    webSearch: { backend: "none" as const, enabled: false, note: "no backend configured" },
    configWarnings: [],
  };
  const layout = detailLayout(snap({ status: "error", contextUsed: 90, contextLimit: 100 }), {
    width: 80,
  });
  let previous: string | undefined;
  for (const palette of Object.values(PALETTES)) {
    const requested = new Set<string>();
    const theme = new Proxy(palette, {
      get(target, key: keyof typeof palette) {
        requested.add(key);
        return target[key];
      },
    });
    const detail = renderToString(
      createElement(PaletteContext.Provider, { value: theme }, layout.render(0)),
      { columns: 80 },
    );
    assert.ok(requested.has("bad"), "detail status and context heat use the supplied theme");
    assert.ok(requested.has("bg"), "panel background uses the supplied theme");
    const plain = stripVTControlCharacters(detail);
    if (previous !== undefined) assert.equal(plain, previous);
    previous = plain;
    requested.clear();
    const doctor = renderToString(
      createElement(
        PaletteContext.Provider,
        { value: theme },
        createElement(Doctor, { report, width: 80 }),
      ),
      { columns: 80 },
    );
    assert.ok(requested.has("good"), "MCP status colour must not be cached at module load");
    assert.ok(stripVTControlCharacters(doctor).includes("✓ tilth"));
  }
});
