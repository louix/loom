/**
 * The new-session prompt's settings, as the rows it draws above the input:
 *
 *     opus · claude personal / claude-opus-5-5 · high  ⌥p ⌥t change  [auto] ⇧⇥ change
 *
 *     isolation: none ⌥i change   dir: worktree ⌥w change
 *     base: main ⌥b change
 *
 * Each setting shows only its current value, with the key that changes it.
 * A row that does not fit wraps between settings, and a setting that does not
 * fit a row on its own gives up its value's end before its key. Pure, so the
 * modal's geometry (where the clickable mode chip lands) and its rendering
 * read the same rows.
 */
import stringWidth from "string-width";
import { modeChipText, type ThemeColor } from "./theme.ts";
import { defaultProviderId, modelSupportsEffort, providerInfo, type TuiState } from "./model.ts";
import { newBase, newIsolation, newWorkspace } from "./new-workspace.ts";
import type { NewSessionSettings } from "./overlay.ts";

export interface HeaderSeg {
  readonly text: string;
  readonly tone: ThemeColor;
  /** An Ink colour over `tone` — the provider's own. */
  readonly color?: string;
  /** The permission-mode chip, which a click cycles. */
  readonly mode?: true;
}

/** One piece of a row: its value, which may be cut short, then its key, which
 *  is not. `gap` parts it from the piece before on the same row. */
interface Item {
  readonly value: readonly HeaderSeg[];
  readonly keys: readonly HeaderSeg[];
  readonly gap?: string;
}

export interface NewSessionHeader {
  /** The rows, a blank one being empty. */
  readonly rows: readonly (readonly HeaderSeg[])[];
  /** Where the mode chip starts: its row, and its column within that row. */
  readonly mode: { readonly row: number; readonly col: number };
}

const width = (segs: readonly HeaderSeg[]): number =>
  segs.reduce((n, s) => n + stringWidth(s.text), 0);

/** `segs` cut to `room` columns, the last kept one ending in `…`. */
const clip = (segs: readonly HeaderSeg[], room: number): HeaderSeg[] => {
  if (width(segs) <= room) return [...segs];
  const out: HeaderSeg[] = [];
  let left = Math.max(0, room - 1);
  for (const s of segs) {
    let text = "";
    for (const ch of s.text) {
      const w = stringWidth(ch);
      if (w > left) break;
      text += ch;
      left -= w;
    }
    if (text) out.push({ ...s, text });
    if (text.length < s.text.length) break;
  }
  const last = out.at(-1);
  if (room > 0) out.push({ tone: last?.tone ?? "faint", text: "…" });
  return out;
};

/** `items` laid into rows of `room` columns, `gap` apart. */
const pack = (items: readonly Item[], room: number, gap: string): HeaderSeg[][] => {
  const rows: HeaderSeg[][] = [];
  let row: HeaderSeg[] = [];
  for (const item of items) {
    const keysW = width(item.keys);
    const fitted = [...clip(item.value, Math.max(1, room - keysW)), ...item.keys];
    const sep = item.gap ?? gap;
    if (row.length > 0 && width(row) + sep.length + width(fitted) > room) {
      rows.push(row);
      row = [];
    }
    if (row.length > 0) row.push({ text: sep, tone: "faint" });
    row.push(...fitted);
  }
  if (row.length > 0) rows.push(row);
  return rows;
};

const keys = (text: string): HeaderSeg[] => [{ text, tone: "faint" }];
const fact = (label: string, value: string, key: string): Item => ({
  value: [
    { text: `${label}: `, tone: "faint" },
    { text: value, tone: "dim" },
  ],
  keys: keys(` ${key} change`),
});

/** The base as the prompt names it, or what it waits on. */
const baseLabel = (state: TuiState, s: NewSessionSettings): string => {
  const base = newBase(state.bases, s);
  if (base) return base.label;
  return state.bases.tag === "idle" || state.bases.tag === "pending"
    ? "reading…"
    : "daemon default";
};

/** How the rows are laid out: `compact` (a short terminal) drops the blank
 *  row between who runs the session and where; `tight` (too short even for
 *  that) keeps who runs it on one row, cutting it short rather than wrapping. */
export interface HeaderFit {
  readonly compact: boolean;
  readonly tight: boolean;
}

/** The prompt's settings rows for `room` columns. */
export const newSessionHeader = (
  state: TuiState,
  s: NewSessionSettings,
  room: number,
  fit: HeaderFit,
): NewSessionHeader => {
  const pid = s.provider ?? defaultProviderId(state);
  const prov = providerInfo(state, pid);
  const model = s.model || prov?.defaultModel || "auto";
  // An effort shows only where the model takes one; `⌥t` changes it.
  const effort = s.effort && modelSupportsEffort(state, pid, model) ? s.effort : null;
  // Who runs it, in three pieces a narrow row wraps between.
  const pieces: Item[] = [
    {
      value: [
        ...(s.profile ? [{ text: `${s.profile} · `, tone: "accent" as const }] : []),
        {
          text: prov?.tag ?? s.provider ?? "auto",
          tone: "dim",
          ...(prov?.color ? { color: prov.color } : {}),
        },
      ],
      keys: [],
    },
    {
      value: [
        {
          text: `/ ${model}${effort ? ` · ${effort}` : ""}`,
          tone: "dim",
        },
      ],
      keys: [],
      gap: " ",
    },
    { value: [], keys: keys(effort ? "⌥p ⌥t change" : "⌥p change") },
  ];
  const identity: Item[] = fit.tight
    ? [
        {
          value: [...pieces[0]!.value, { text: " ", tone: "dim" }, ...pieces[1]!.value],
          keys: [{ text: "  ", tone: "faint" }, ...pieces[2]!.keys],
        },
      ]
    : pieces;
  const mode: Item = {
    value: [
      {
        text: modeChipText(s.mode),
        tone: s.mode !== "default" ? "warn" : "faint",
        mode: true,
      },
    ],
    keys: keys(" ⇧⇥ change"),
  };
  const isolation = fact("isolation", newIsolation(prov, s) === "vm" ? "vm" : "none", "⌥i");
  const dir = fact("dir", newWorkspace(prov, s), "⌥w");
  const base = fact("base", baseLabel(state, s), "⌥b");

  const rows = [
    ...pack([...identity, mode], room, "  "),
    ...(fit.compact ? [] : [[]]),
    ...pack([isolation, dir], room, "   "),
    ...pack([base], room, "   "),
  ];
  let at = { row: 0, col: 0 };
  rows.forEach((row, r) => {
    let col = 0;
    for (const seg of row) {
      if (seg.mode) at = { row: r, col };
      col += stringWidth(seg.text);
    }
  });
  return { rows, mode: at };
};

/** A header row as plain text, for tests and measurement. */
export const headerText = (row: readonly HeaderSeg[]): string => row.map((s) => s.text).join("");
