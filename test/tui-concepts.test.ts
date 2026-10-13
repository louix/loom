import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createElement } from "react";
import { PALETTES } from "@loom/tui/theme";
import { Fields, Line, Lines, PaletteContext } from "@loom/tui/ui";
import { Doctor } from "@loom/tui/components";
import { Box, renderToString } from "ink";
import { describeCommands, keyAction, keyCommand } from "@loom/tui/commands";
import { detailLayout } from "@loom/tui/components";
import {
  escapePicker,
  initialState,
  newSessionPickItems,
  reduce,
  selectModel,
  startModelSelection,
  startNewSessionPicker,
} from "@loom/tui/model";
import type { ProviderInfo } from "@loom/core/wire";
import type { PickerDest } from "@loom/tui/overlay";
import { fleet, snap } from "./tui-fixtures.ts";

test("an unknown context limit is not rendered as zero capacity or zero percent", () => {
  const layout = detailLayout(snap({ contextUsed: 44_400, contextLimit: 0 }), { width: 80 });
  const plain = stripVTControlCharacters(renderToString(layout.render(0), { columns: 80 }));
  assert.ok(plain.includes("44.4k/unknown"));
  assert.ok(!plain.includes("44.4k/0"));
  assert.ok(!plain.includes("0%"));
});

test("a pending interrupt is displayed as stopping rather than completed", () => {
  const session = { ...snap({ status: "running" }), stopping: true };
  const layout = detailLayout(session, { width: 80 });
  const plain = stripVTControlCharacters(renderToString(layout.render(0), { columns: 80 }));
  assert.ok(plain.includes("stopping…"));
  assert.ok(!plain.includes("interrupted"));
});

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
    const actions = describeCommands(state);
    assert.equal(keyCommand(actions, "a", {}), action);
    assert.equal(keyAction(actions, "a", {})?.target, "one");
    // Request mode: the model switch is still described, disabled with a reason.
    assert.equal(keyCommand(actions, "m", { meta: true }), null);
    assert.match(keyAction(actions, "m", { meta: true })?.disabled ?? "", /first\.$/);
    assert.equal(keyCommand(actions, "a", { ctrl: true }), null);
  }
  const none = describeCommands(reduce(initialState(), fleet([])));
  assert.equal(keyAction(none, "", { return: true })?.disabled, "Select a session first.");
  assert.equal(keyAction(none, "n", {})?.target, null);
  const state = reduce(initialState(), fleet([snap({ status: "idle" })]));
  assert.equal(keyCommand(describeCommands(state), "v", {}), "filter");
  assert.equal(keyCommand(describeCommands(state), "", { tab: true, shift: true }), "mode");
  assert.equal(keyCommand(describeCommands(state), " ", {}), "palette");
});

test("y copies the branch and shift+y copies the session id", () => {
  const s = snap({ id: "one", branch: "loom/one" });
  const state = reduce(initialState(), fleet([s]));
  const actions = describeCommands(state);
  assert.equal(keyCommand(actions, "y", {}), "copybranch");
  assert.equal(keyCommand(actions, "Y", {}), "copyid");
  assert.equal(keyAction(actions, "Y", {})?.target, "one");
});

test("detail budgets and click regions match rendered panes across widths and expiry", () => {
  const plain = snap({ mode: "default" });
  const full = snap({
    status: "running",
    parentId: "parent",
    forkTurn: 2,
    mode: "default",
    costUsd: 1,
    costSource: "provider",
    resumable: false,
    resumeBlockedReason: "A long explanation that wraps over several rows on a narrow screen.",
    rateLimits: { five_hour: { status: "allowed", resetsAt: 100, utilization: 0.5 } },
    git: {
      branch: "loom/x",
      commits: 2,
      aheadOfBase: 1,
      behindBase: 0,
      dirty: true,
      lastCommitSubject: "add flag",
    },
    cache: { ttlMinutes: 5, ttlSource: "observed", lastTurnAt: 1, lastRead: 2, lastWrite: 1 },
    subagents: [{ id: "sa", name: "scout", active: true }],
    backgroundTasks: [{ id: "bt", kind: "shell", title: "tail log" }],
    compacting: { startedAt: 1, before: 90_000, generated: 0 },
  });
  const origin = { x: 3, y: 2 };
  for (const session of [null, plain, full]) {
    for (const width of [40, 80, 120]) {
      const layout = detailLayout(session, {
        width,
        ...(session === full ? { account: "personal account", queued: ["next task"] } : {}),
      });
      for (const now of [50, 150]) {
        const lines = stripVTControlCharacters(
          renderToString(layout.render(now), { columns: width }),
        )
          .trimEnd()
          .split("\n");
        assert.equal(lines.length, layout.height, `height at ${width} columns, time ${now}`);
        const hits = layout.hits(origin);
        assert.equal(hits.length, session ? 1 : 0);
        for (const hit of hits) {
          assert.equal(
            lines[hit.y - origin.y]!.slice(hit.x0 - origin.x, hit.x1 - origin.x + 1),
            "mode [manual]",
          );
        }
        if (session === full)
          assert.ok(
            lines.some((line) => line.includes("$1.00")),
            "cost remains readable",
          );
      }
    }
  }
  assert.deepEqual(
    detailLayout(plain, { width: 8 }).hits(origin),
    [],
    "a clipped chip is not clickable",
  );
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

test("a single provider keeps the new-session profile picker reachable", () => {
  const provider: ProviderInfo = {
    id: "test",
    models: ["model"],
    defaultModel: "model",
    defaultEffort: "",
    defaultMode: "default",
    tag: "test",
    color: "",
    isDefault: true,
    modelChoices: [{ id: "model", label: "Model", supportsEffort: false, effortLevels: [] }],
  };
  const settings = { provider: "test", model: "model", effort: null, mode: "default" as const };
  const available = {
    name: "cheap-worker",
    description: "cheap",
    provider: "test",
    model: "model",
  };
  const blocked = { ...available, name: "elsewhere", provider: "missing" };
  const withProfile = reduce(initialState(), fleet([], [provider], [available, blocked]));
  const opened = startNewSessionPicker(withProfile, settings, "work");
  assert.equal(opened.t, "picker");
  if (opened.t !== "picker") throw new Error("expected profile picker");
  assert.match(opened.picker.title, /provider or agent profile/);
  assert.deepEqual(
    newSessionPickItems(withProfile)
      .filter((item) => item.profile)
      .map((item) => item.label),
    ["cheap-worker", "elsewhere"],
  );
  const profileIndex = opened.picker.items.findIndex((item) => item.profile === "cheap-worker");
  const selected = selectModel(withProfile, { ...opened.picker, index: profileIndex });
  assert.equal(selected.tag, "show");
  if (selected.tag !== "show" || selected.overlay.t !== "prompt")
    throw new Error("expected new-session prompt");
  if (selected.overlay.prompt.t !== "new") throw new Error("expected new prompt");
  assert.equal(selected.overlay.prompt.settings.profile, "cheap-worker");

  const noProfiles = reduce(initialState(), fleet([], [provider]));
  const skipped = startNewSessionPicker(noProfiles, settings, "work");
  assert.equal(skipped.t, "picker");
  if (skipped.t !== "picker") throw new Error("expected model picker");
  assert.equal(skipped.picker.step, "model");

  const onlyBlocked = reduce(initialState(), fleet([], [provider], [blocked]));
  const blockedOnly = startNewSessionPicker(onlyBlocked, settings, "work");
  assert.equal(blockedOnly.t, "picker");
  if (blockedOnly.t !== "picker") throw new Error("expected model picker");
  assert.equal(blockedOnly.picker.step, "model");
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
