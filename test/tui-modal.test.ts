import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createElement as h } from "react";
import { Box, Text, renderToString } from "ink";
import { NewSessionModal, newSessionLayout, SelectionModal } from "@loom/tui/components";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import type { ProviderInfo } from "@loom/core/wire";
import { loadableLoaded } from "@loom/core/loadable";
import {
  initialState,
  newSettings,
  pickerStep,
  profileItemId,
  reduce,
  type TuiState,
} from "@loom/tui/model";
import { headerText, newSessionHeader } from "@loom/tui/new-session-header";
import { newPrompt, makePicker, type NewSessionSettings, type PickerStep } from "@loom/tui/overlay";
import { daemon, fleet } from "./tui-fixtures.ts";

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
        dest: { t: "command", target: null },
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
      // The command palette puts a KEY column before the name.
      assert.match(frame, step === "command" ? /▍ +choice 19/ : /▍ choice 19/);
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

test("delete confirmation keeps consequences, branch choice and actions visible", () => {
  for (const [cols, rows] of [
    [120, 40],
    [80, 24],
    [60, 16],
    [44, 18],
    [32, 12],
  ]) {
    for (const branch of [undefined, false, true]) {
      for (const worktree of [undefined, false, true]) {
        const state = {
          ...initialState(),
          overlay: {
            t: "confirm" as const,
            confirm: {
              action: "deleteSession" as const,
              sessionId: "a",
              title: "Delete session?",
              danger: true,
              body: "A very long session title ".repeat(10),
              ...(branch !== undefined
                ? { branchName: "feature/" + "long-branch-name".repeat(10), deleteBranch: branch }
                : {}),
              ...(worktree !== undefined ? { deleteWorktree: true, force: worktree } : {}),
            },
          },
        };
        const frame = renderToString(
          h(
            Box,
            { width: cols, height: rows },
            h(SelectionModal, { state, cols: cols!, rows: rows! }),
          ),
          { columns: cols! },
        );
        const copy = frame.replace(/[│\n]/g, " ").replace(/\s+/g, " ");
        assert.equal(frame.split("\n").length, rows);
        assert.match(frame, /Delete session/);
        assert.match(copy, /Session history will be permanently deleted\./);
        if (worktree !== undefined) {
          assert.match(
            copy,
            worktree
              ? /Worktree and uncommitted changes will be lost\./
              : /Worktree will be removed\./,
          );
        } else {
          assert.doesNotMatch(frame, /Worktree/);
        }
        if (branch !== undefined) {
          assert.match(frame, branch ? /\[x\] Also delete branch/ : /\[ \] Also delete branch/);
          assert.match(frame, /feature\//);
          assert.match(frame, /b toggle branch/);
        } else {
          assert.doesNotMatch(frame, /Also delete branch|toggle branch/);
        }
        assert.match(frame, /enter delete · esc cancel/);
        assert.match(frame, /╰.*╯/);
      }
    }
  }
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
      const g = newSessionLayout(state, prompt, cols!, rows!);
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

/** A state with one provider that takes an effort, a checked-out base, and the
 *  `new` prompt open on `settings`. */
const launchState = (settings: Partial<NewSessionSettings>, feedback?: string) => {
  const s = reduce(
    initialState(),
    fleet(
      [],
      [
        {
          id: "claude:personal",
          tag: "claude personal",
          color: "",
          models: ["claude-opus-5-5"],
          modelChoices: [{ id: "claude-opus-5-5", label: "Opus 5.5", supportsEffort: true }],
          defaultModel: "claude-opus-5-5",
          defaultEffort: "",
          defaultMode: "default",
          isDefault: true,
          defaultIsolation: "none",
          defaultWorkspace: { none: "worktree", vm: "clone" },
        },
      ],
    ),
  );
  const prompt = newPrompt(
    { mode: "auto", provider: "claude:personal", model: null, effort: null, ...settings },
    "hello",
  );
  if (feedback) prompt.feedback = { pending: false, text: feedback };
  return {
    prompt,
    state: {
      ...s,
      bases: loadableLoaded({
        current: { ref: "main", detached: false },
        default: { ref: "main" },
      }),
      overlay: { t: "prompt" as const, prompt },
    },
  };
};

const modalFrame = (state: ReturnType<typeof launchState>["state"], cols: number, rows: number) =>
  stripVTControlCharacters(
    renderToString(
      h(Box, { width: cols, height: rows }, h(NewSessionModal, { state, cols, rows })),
      { columns: cols },
    ),
  );

test("the new-session settings: who runs it and its mode, then where it runs and its base", () => {
  const { state, prompt } = launchState({ profile: "opus", effort: "high", isolation: "vm" });
  const header = newSessionHeader(state, prompt.settings, 90, { compact: false, tight: false });
  assert.deepEqual(header.rows.map(headerText), [
    "opus · claude personal / claude-opus-5-5 · high  ⌥p ⌥t change  [auto] ⇧⇥ change",
    "",
    "isolation: vm ⌥i change   dir: clone ⌥w change",
    "base: main ⌥b change",
  ]);
  // The clickable chip, where it is drawn.
  assert.deepEqual(header.mode, { row: 0, col: headerText(header.rows[0]!).indexOf("[auto]") });
  const frame = modalFrame(state, 120, 40);
  for (const row of header.rows.filter((r) => r.length > 0))
    assert.ok(frame.includes(headerText(row)), headerText(row));

  // No effort shown where the model takes none, nor its key.
  const plain = launchState({ effort: null });
  assert.equal(
    headerText(
      newSessionHeader(plain.state, plain.prompt.settings, 90, { compact: false, tight: false })
        .rows[0]!,
    ),
    "claude personal / claude-opus-5-5  ⌥p change  [auto] ⇧⇥ change",
  );
});

test("narrow new-session settings wrap between settings and keep every key in view", () => {
  const { state, prompt } = launchState({ profile: "opus", effort: "high" });
  assert.deepEqual(
    newSessionHeader(state, prompt.settings, 32, { compact: true, tight: false }).rows.map(
      headerText,
    ),
    [
      "opus · claude personal",
      "/ claude-opus-5-5 · high",
      "⌥p ⌥t change  [auto] ⇧⇥ change",
      "isolation: none ⌥i change",
      "dir: worktree ⌥w change",
      "base: main ⌥b change",
    ],
  );
  for (const [cols, rows, feedback] of [
    [120, 40, undefined],
    [80, 24, "A private clone runs in a VM — isolation is now VM."],
    [44, 18, undefined],
    [44, 18, "A private clone runs in a VM — isolation is now VM."],
    [32, 12, undefined],
    [32, 12, "A private clone runs in a VM — isolation is now VM."],
  ] as const) {
    const frame = modalFrame(
      launchState({ profile: "opus", effort: "high" }, feedback).state,
      cols,
      rows,
    );
    for (const key of ["⌥p", "⇧⇥", "⌥i", "⌥w", "⌥b", "[auto]", "▍ hello", "enter start session"])
      assert.ok(
        frame.includes(key),
        `${key} at ${cols}×${rows}${feedback ? " with a notice" : ""}`,
      );
    if (feedback) assert.match(frame, /isolation is now/);
  }
});

// ---------------------------------------------------------------------------
// the new-session ⌥p list at several widths: providers, then agent profiles
// ---------------------------------------------------------------------------

const profilePickerState = (): TuiState => {
  const provider = (id: string, tag: string, model: string, isDefault: boolean): ProviderInfo => ({
    id,
    tag,
    color: "",
    models: [model],
    defaultModel: model,
    defaultEffort: "",
    defaultMode: "default",
    isDefault,
    defaultIsolation: "none",
    defaultWorkspace: { none: "worktree", vm: "clone" },
  });
  const s = reduce(initialState(), {
    t: "state",
    state: loadableLoaded({
      daemon,
      sessions: [],
      providers: [
        provider("claude:personal", "claude personal", "claude-sonnet-5-5", true),
        provider("codex:personal", "codex personal", "gpt-6-astra", false),
      ],
      agentProfiles: [
        {
          name: "opus",
          description: "Strongest Claude model; for hard, open-ended or high-stakes work.",
          provider: "claude:personal",
          model: "claude-opus-5-5",
        },
        {
          name: "sonnet",
          description: "Cheaper Claude model; for well-specified, verifiable tasks.",
          provider: "claude:personal",
          model: "claude-sonnet-5-5",
        },
        {
          name: "astra",
          description: "Codex on the largest model; for long autonomous runs that need no review.",
          provider: "codex:personal",
          model: "gpt-6-astra",
        },
        {
          name: "luna",
          description: "Codex on the fast model; for quick edits and questions about the code.",
          provider: "codex:personal",
          model: "gpt-5.6-luna",
        },
      ],
    }),
  });
  const dest = {
    t: "newSession" as const,
    settings: newSettings(s, null, null, null),
    draft: "",
  };
  return {
    ...s,
    overlay: pickerStep(s, "provider", {
      dest,
      chosen: { provider: null, model: null },
      from: "provider",
      pick: profileItemId("sonnet"),
    }),
  };
};

const PROFILE_TARGETS = [
  ["opus", "claude personal / claude-opus-5-5"],
  ["sonnet", "claude personal / claude-sonnet-5-5"],
  ["astra", "codex personal / gpt-6-astra"],
  ["luna", "codex personal / gpt-5.6-luna"],
] as const;

const pickerFrame = (state: TuiState, cols: number, rows: number): string[] =>
  stripVTControlCharacters(
    renderToString(
      h(Box, { width: cols, height: rows }, h(SelectionModal, { state, cols, rows })),
      { columns: cols },
    ),
  ).split("\n");

describe("the agent profiles section of the new-session picker", () => {
  for (const cols of [80, 96, 140]) {
    test(`at ${cols} columns every profile shows whole in aligned columns`, () => {
      // given
      const state = profilePickerState();
      // when
      const lines = pickerFrame(state, cols, 40);
      const frame = lines.join("\n");
      // then
      const rowOf = (name: string) => lines.find((l) => new RegExp(`[▍ ] ${name} {2,}`).test(l))!;
      const rows = PROFILE_TARGETS.map(([name]) => rowOf(name));
      for (const [i, [name, target]] of PROFILE_TARGETS.entries()) {
        assert.ok(rows[i], `${name} is listed:\n${frame}`);
        assert.ok(rows[i]!.includes(target), `${name} shows ${target}:\n${frame}`);
      }
      const columnOf = (at: (row: string, i: number) => number) => rows.map((r, i) => at(r, i));
      const sameColumn = (cols: number[]) => cols.every((c) => c > 0 && c === cols[0]);
      assert.ok(sameColumn(columnOf((r, i) => r.indexOf(PROFILE_TARGETS[i]![0]))), "names align");
      assert.ok(sameColumn(columnOf((r, i) => r.indexOf(PROFILE_TARGETS[i]![1]))), "targets align");
      const describedAt = columnOf(
        (r, i) => r.indexOf(PROFILE_TARGETS[i]![1]) + PROFILE_TARGETS[i]![1].length,
      );
      assert.ok(
        rows.every((r, i) => /^ +\S/.test(r.slice(describedAt[i]!))),
        "descriptions start in one column after the target",
      );
      assert.ok(
        rows.every((r) => /…\s+│$/.test(r)),
        "long descriptions give way with …",
      );
      assert.doesNotMatch(frame, /… \d+ more/);
      for (const line of lines) {
        assert.ok(stringWidth(line) <= cols, `overflow: ${line}`);
      }
    });
  }

  test("a short window scrolls with the selected profile in view", () => {
    // given
    const state = profilePickerState();
    // when
    const frame = pickerFrame(state, 96, 16).join("\n");
    // then
    assert.match(frame, /▍ sonnet {2}claude personal \/ claude-sonnet-5-5/);
    assert.match(frame, /… \d+ more/);
  });
});
