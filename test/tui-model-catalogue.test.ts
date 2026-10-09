/**
 * Model catalogues in the TUI: every selector shows one provider's catalogue
 * the same way, ids survive label changes, a session's unlisted model is kept
 * and explained, and Refresh models is one command with its own availability.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderInfo } from "@loom/core/wire";
import { describeCommands, footerHints, modelRefresh, paletteActions } from "@loom/tui/commands";
import {
  effortPickItems,
  initialState,
  modelPickItems,
  modelRefreshSummary,
  modelSupportsEffort,
  pickerStep,
  reduce,
  type Action,
  type TuiState,
} from "@loom/tui/model";
import type { Overlay, PickerDest } from "@loom/tui/overlay";
import { fleet, snap } from "./tui-fixtures.ts";

const provider = (over: Partial<ProviderInfo> & { id: string }): ProviderInfo => ({
  models: [],
  defaultModel: "",
  defaultEffort: "",
  defaultMode: "default",
  tag: over.id,
  color: "",
  isDefault: false,
  ...over,
});

/** Two Claude profiles with different accounts, and a Codex profile. */
const PERSONAL = provider({
  id: "claude",
  tag: "personal",
  isDefault: true,
  models: ["claude-opus-5", "claude-sonnet-5"],
  modelChoices: [
    {
      id: "claude-opus-5",
      label: "Opus",
      description: "Most capable",
      supportsEffort: true,
      effortLevels: ["low", "high", "max"],
      defaultEffort: "high",
    },
    { id: "claude-sonnet-5", label: "Sonnet", supportsEffort: true },
  ],
});
const WORK = provider({
  id: "claude:work",
  tag: "work",
  models: ["claude-sonnet-5"],
  modelChoices: [{ id: "claude-sonnet-5", label: "Sonnet (work)" }],
});
const CODEX = provider({
  id: "codex",
  tag: "Codex",
  models: ["gpt-5.6-sol"],
  modelChoices: [
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6-Sol",
      supportsEffort: true,
      effortLevels: ["low", "high"],
      defaultEffort: "low",
    },
  ],
});

const withFleet = (providers: ProviderInfo[], sessions = [] as ReturnType<typeof snap>[]) =>
  reduce(initialState(), fleet(sessions, providers));

const pickerOf = (o: Overlay) => (o.t === "picker" ? o.picker : null);
const rows = (o: Overlay) => pickerOf(o)?.items.map((i) => [i.id, i.label, i.hint ?? ""]);

test("every selector shows one provider's catalogue rows, by id, with the same labels", () => {
  const session = snap({ id: "s1", provider: "claude", model: "claude-opus-5" });
  const s = withFleet([PERSONAL, WORK, CODEX], [session]);
  const dests: PickerDest[] = [
    {
      t: "newSession",
      settings: { mode: "default", provider: null, model: null, effort: null },
      draft: "",
    },
    { t: "session", sessionId: "s1", back: null },
  ];
  const shown = dests.map((dest) =>
    rows(
      pickerStep(s, "model", { dest, chosen: { provider: "claude", model: null }, from: "model" }),
    ),
  );
  assert.deepEqual(shown[0], [
    ["claude-opus-5", "Opus", "Most capable"],
    ["claude-sonnet-5", "Sonnet", ""],
  ]);
  assert.deepEqual(shown[1], shown[0]);
  // Profiles never share a list: the work profile shows only its own.
  assert.deepEqual(
    modelPickItems(s, "claude:work").map((i) => [i.id, i.label]),
    [["claude-sonnet-5", "Sonnet (work)"]],
  );
  assert.deepEqual(
    modelPickItems(s, "codex").map((i) => i.id),
    ["gpt-5.6-sol"],
  );
});

test("a relabelled catalogue keeps ids — and an open picker's highlight follows the id", () => {
  const s = withFleet([PERSONAL]);
  const opened = reduce(s, {
    t: "overlay",
    overlay: pickerStep(s, "model", {
      dest: {
        t: "newSession",
        settings: { mode: "default", provider: null, model: null, effort: null },
        draft: "",
      },
      chosen: { provider: "claude", model: null },
      from: "model",
      pick: "claude-sonnet-5",
    }),
  } as Action);
  const relabelled = {
    ...PERSONAL,
    modelChoices: PERSONAL.modelChoices!.map((c) => ({
      ...c,
      label: `${c.label} (new)`,
    })).reverse(),
    models: [...PERSONAL.models].reverse(),
  };
  const next = reduce(opened, fleet([], [relabelled]));
  const p = pickerOf(next.overlay)!;
  assert.deepEqual(
    p.items.map((i) => [i.id, i.label]),
    [
      ["claude-sonnet-5", "Sonnet (new)"],
      ["claude-opus-5", "Opus (new)"],
    ],
  );
  assert.equal(p.items[p.index]?.id, "claude-sonnet-5");
});

test("effort choices and defaults come from the catalogue row", () => {
  const s = withFleet([PERSONAL, CODEX]);
  assert.deepEqual(
    effortPickItems(s, "claude", "claude-opus-5").map((i) => [i.id, i.hint ?? ""]),
    [
      ["low", ""],
      ["high", "default"],
      ["max", ""],
    ],
  );
  // Effort supported without an enumeration: the full default set.
  assert.deepEqual(
    effortPickItems(s, "claude", "claude-sonnet-5").map((i) => i.id),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(effortPickItems(s, "codex", "gpt-5.6-sol").find((i) => i.hint)?.id, "low");
  assert.equal(modelSupportsEffort(s, "claude:work", "claude-sonnet-5"), false);
});

test("a session's model that left the catalogue stays choosable and says why", () => {
  const session = snap({ id: "s1", provider: "claude", model: "claude-legacy-4" });
  const s = withFleet([PERSONAL], [session]);
  const live = pickerStep(s, "model", {
    dest: { t: "session", sessionId: "s1", back: null },
    chosen: { provider: "claude", model: null },
    from: "model",
    pick: "claude-legacy-4",
  });
  const p = pickerOf(live)!;
  assert.equal(p.items[p.index]?.id, "claude-legacy-4");
  assert.equal(p.items[p.index]?.hint, "current · no longer listed");
  // A new session has no current model to keep.
  assert.equal(modelPickItems(s, "claude").length, 2);
  assert.equal(
    modelRefreshSummary(s, "claude", ["claude-opus-5", "claude-sonnet-5"]),
    "personal: 2 models · 1 session keeps a model no longer listed",
  );
});

test("a refresh settling for another provider never changes the open picker's list", () => {
  const loadingCodex = { ...CODEX, modelsLoading: true };
  const s = withFleet([PERSONAL, loadingCodex]);
  // The user started a Codex refresh, then moved the wizard to Claude.
  const opened = reduce(s, {
    t: "overlay",
    overlay: pickerStep(s, "model", {
      dest: {
        t: "newSession",
        settings: { mode: "default", provider: null, model: null, effort: null },
        draft: "",
      },
      chosen: { provider: "claude", model: null },
      from: "provider",
    }),
  } as Action);
  const before = pickerOf(opened.overlay)!.items;
  // Codex's (late) refresh lands with a different list.
  const late = {
    ...CODEX,
    models: ["gpt-6"],
    modelChoices: [{ id: "gpt-6", label: "GPT-6" }],
  };
  const after = reduce(opened, fleet([], [PERSONAL, late]));
  const p = pickerOf(after.overlay)!;
  assert.deepEqual(p.items, before);
  assert.equal(p.chosen.provider, "claude");
  assert.equal(p.note, undefined);
});

test("the model picker shows refresh progress and a failed refresh beside the old list", () => {
  const dest: PickerDest = {
    t: "newSession",
    settings: { mode: "default", provider: null, model: null, effort: null },
    draft: "",
  };
  const step = (info: ProviderInfo) =>
    pickerOf(
      pickerStep(withFleet([info]), "model", {
        dest,
        chosen: { provider: "claude", model: null },
        from: "model",
      }),
    )!;
  assert.match(step({ ...PERSONAL, modelsLoading: true }).note ?? "", /refreshing.*⌥r cancel/);
  const failed = step({ ...PERSONAL, modelsError: "Claude could not start." });
  assert.equal(failed.items.length, 2, "the previous catalogue stays");
  assert.match(failed.note ?? "", /last refresh failed: Claude could not start\. · ⌥r retry/);
  const empty = step({ ...PERSONAL, models: [], modelChoices: [], modelsError: "boom" });
  assert.equal(empty.emptyText, "boom — ⌥r to retry");
});

test("Refresh models is one command: its provider, its disabled reasons, cancel and retry", () => {
  const pinned = { ...WORK, modelsRefreshUnavailable: "Claude models are pinned." };
  const session = snap({ id: "s1", provider: "claude:work", model: "claude-sonnet-5" });
  let s: TuiState = withFleet([PERSONAL, pinned, CODEX], [session]);

  // No selection: the default provider's catalogue.
  const none = describeCommands({ ...s, selectedId: null }).find((a) => a.id === "refreshModels");
  assert.equal(none?.label, "refresh models · personal");
  assert.equal(none?.disabled, undefined);

  // The selected session's provider, with its reason, listed in the palette.
  s = { ...s, selectedId: "s1" };
  const row = paletteActions(s, "s1").find((a) => a.id === "refreshModels");
  assert.equal(row?.disabled, "Claude models are pinned.");

  // Running → the same command cancels; failed → it retries.
  assert.deepEqual(modelRefresh(withFleet([{ ...CODEX, modelsLoading: true }]), "codex"), {
    provider: "codex",
    cancel: true,
    label: "cancel model refresh · Codex",
  });
  assert.equal(
    modelRefresh(withFleet([{ ...CODEX, modelsError: "x" }]), "codex").label,
    "retry model refresh · Codex",
  );
  assert.equal(modelRefresh(initialState(), "codex").disabled, "Not connected.");
});

test("a model picker's key bar offers ⌥r for its own provider only when it can refresh", () => {
  const dest: PickerDest = {
    t: "newSession",
    settings: { mode: "default", provider: null, model: null, effort: null },
    draft: "",
  };
  const hints = (info: ProviderInfo) => {
    const s = withFleet([info]);
    const overlay = pickerStep(s, "model", {
      dest,
      chosen: { provider: info.id, model: null },
      from: "model",
    });
    return footerHints({ ...s, overlay }).map((h) => `${h.keys} ${h.label}`);
  };
  assert.ok(hints(CODEX).includes("⌥r refresh models"));
  assert.ok(hints({ ...CODEX, modelsLoading: true }).includes("⌥r cancel refresh"));
  assert.ok(
    !hints({ ...CODEX, modelsRefreshUnavailable: "pinned" }).some((h) => h.startsWith("⌥r")),
  );
});
