/**
 * The `AskUserQuestion` answer sheet — choosing, reviewing and validating
 * answers to a multi-question call before it goes back to the daemon.
 *
 * Presentation and validation only. The request it answers is read straight off
 * the snapshot by id (see `interactions.ts`), the decision goes out through the
 * same per-request guard as every other one, and a request the daemon stops
 * listing takes this sheet with it (`reconcileOverlay`). Nothing here names an
 * RPC: {@link sheetKey} says *that* the answers are ready and the handle sends
 * them.
 *
 * Every question offers its options plus a custom answer (the SDK's "Other"):
 * single-select questions take exactly one of the two, multi-select ones any
 * mix of options and text. The last step reviews every answer and only an
 * explicit ⏎ there submits.
 */
import { applyKey, buffer, type Buffer, type KeyLike } from "./editor.ts";
import type { AskUserQuestionItem } from "./interactions.ts";
import { markdownText, plainText } from "./markdown.ts";
import type { TextRow } from "./text-layout.ts";

/**
 * In-progress answering of one `AskUserQuestion`. Lives in the TUI state rather
 * than the overlay so it survives the sheet closing: `Esc` drops back to the
 * request panel, where `←` / `→` still move between questions, and `a`
 * re-opens the sheet exactly where it was left.
 */
export interface QNav {
  sessionId: string;
  requestId: string;
  /** Which question is shown; `questions.length` is the review step. */
  idx: number;
  /** Highlighted row: an option index, or `options.length` for the custom answer. */
  cursor: number;
  /** Chosen option indices, by question index. */
  selected: Readonly<Record<number, readonly number[]>>;
  /** Custom ("Other") answer text, by question index. */
  drafts: Readonly<Record<number, Buffer>>;
  /** Keys go to the custom answer's editor rather than the choices. */
  editing: boolean;
  /** First body row drawn. */
  offset: number;
  /** Validation or submission feedback; empty when there is none. */
  notice: string;
  /** The answers are on their way to the daemon; the sheet takes no edits. */
  busy: boolean;
}

export const qnav = (sessionId: string, requestId: string): QNav => ({
  sessionId,
  requestId,
  idx: 0,
  cursor: 0,
  selected: {},
  drafts: {},
  editing: false,
  offset: 0,
  notice: "",
  busy: false,
});

// ---- answers ---------------------------------------------------------------

const draftText = (nav: QNav, qi: number): string => nav.drafts[qi]?.text ?? "";

/** What question `qi` reads as on the wire: its chosen labels, in option
 *  order, then the custom answer — comma-joined, as the SDK expects. */
const answerFor = (qs: readonly AskUserQuestionItem[], nav: QNav, qi: number): string => {
  const q = qs[qi];
  if (!q) return "";
  const chosen = nav.selected[qi] ?? [];
  const parts = q.options.filter((_, oi) => chosen.includes(oi)).map((o) => o.label);
  const text = draftText(nav, qi).trim();
  if (text) parts.push(text);
  return parts.join(", ");
};

/** The answers, keyed by question text — the existing `updatedInput.answers`
 *  contract every provider reads them back from. */
export const sheetAnswers = (
  qs: readonly AskUserQuestionItem[],
  nav: QNav,
): Record<string, string> =>
  Object.fromEntries(qs.map((q, qi) => [q.question, answerFor(qs, nav, qi)]));

/** Why these answers cannot be submitted yet, or null when they can: every
 *  question needs an answer, and a single-select one exactly one. */
export const sheetProblem = (qs: readonly AskUserQuestionItem[], nav: QNav): string | null => {
  for (const [qi, q] of qs.entries()) {
    const count = (nav.selected[qi] ?? []).length + Number(draftText(nav, qi).trim() !== "");
    if (count === 0 || (!q.multiSelect && count !== 1))
      return qs.length > 1 ? `Choose an answer for question ${qi + 1}.` : "Choose an answer.";
  }
  return null;
};

// ---- layout ----------------------------------------------------------------

/** Below either bound the sheet drops to one-row chrome. */
const COMPACT_COLS = 60;
const COMPACT_ROWS = 16;
/** The panel border and its title row. */
const PANEL_CHROME = 3;

export interface SheetLayout {
  /** Every body row; the pane draws `room` of them from `offset`. */
  readonly lines: readonly TextRow[];
  /** The body row each choice (and the custom answer) starts on. */
  readonly choiceRows: readonly number[];
  /** Body rows on screen. */
  readonly room: number;
  readonly compact: boolean;
  /** Editor rows while the custom answer is being edited. */
  readonly editorRows: number;
  /** Panel title. */
  readonly title: string;
}

const indent = (rows: readonly TextRow[], by: number): TextRow[] => {
  const pad = " ".repeat(by);
  return rows.map((r) => ({ text: pad + r.text, spans: [{ text: pad }, ...r.spans] }));
};

const emphasise = (rows: readonly TextRow[]): TextRow[] =>
  rows.map((r) => ({
    ...r,
    spans: r.spans.map((span) => ({ ...span, bold: true, role: "keyword" as const })),
  }));

/** The sheet's rows and geometry for a `width` × `height` pane. The keymap
 *  scrolls with the same numbers the pane draws with. */
export const sheetLayout = (
  qs: readonly AskUserQuestionItem[],
  nav: QNav,
  width: number,
  height: number,
): SheetLayout => {
  const compact = width < COMPACT_COLS || height < COMPACT_ROWS;
  // Inside the panel border and its padding.
  const w = Math.max(1, width - 4);
  const editorRows = compact ? 1 : 2;
  const chrome =
    PANEL_CHROME +
    (nav.editing ? 1 + editorRows : 0) +
    Number(!compact || nav.notice !== "") +
    Number(nav.busy);
  const room = Math.max(1, height - chrome);
  const lines: TextRow[] = [];
  const choiceRows: number[] = [];
  const q = qs[nav.idx];
  const position = (n: number): string => (qs.length > 1 ? ` ${n + 1}/${qs.length}` : "");
  if (q) {
    lines.push(...markdownText(q.question).layout(w));
    const chosen = nav.selected[nav.idx] ?? [];
    const row = (index: number, label: string, mark: string): void => {
      choiceRows.push(lines.length);
      const head = `${index === nav.cursor ? ">" : " "} ${index + 1}: ${mark ? mark + " " : ""}`;
      const gutter = w > head.length ? head.length : 0;
      const rows = plainText(label)
        .layout(Math.max(1, w - gutter))
        .map((r, i) => {
          const lead = i === 0 && gutter ? head : " ".repeat(gutter);
          return { text: lead + r.text, spans: [{ text: lead }, ...r.spans] };
        });
      lines.push(...(index === nav.cursor ? emphasise(rows) : rows));
    };
    q.options.forEach((option, oi) => {
      const on = chosen.includes(oi);
      // Boxes for any number of choices, radio marks for exactly one.
      const [yes, no] = q.multiSelect ? ["[x]", "[ ]"] : ["(•)", "( )"];
      row(oi, option.label, on ? yes : no);
      if (option.description) {
        // Under the label, past `> 1: [ ] `.
        const pad = Math.min(9, Math.max(0, w - 1));
        lines.push(...indent(markdownText(option.description).layout(Math.max(1, w - pad)), pad));
      }
    });
    const text = draftText(nav, nav.idx);
    row(q.options.length, text ? `Custom answer · ${text}` : "Custom answer…", "");
    return {
      lines,
      choiceRows,
      room,
      compact,
      editorRows,
      title: `? QUESTION${position(nav.idx)}${q.header ? ` · ${q.header}` : ""}`,
    };
  }
  lines.push(...plainText("Review answers before submitting.").layout(w));
  for (const [qi, item] of qs.entries()) {
    lines.push({ text: "", spans: [] });
    lines.push(...markdownText(item.question).layout(w));
    const answer = answerFor(qs, nav, qi);
    lines.push(...indent(plainText(`→ ${answer || "(unanswered)"}`).layout(Math.max(1, w - 2)), 2));
  }
  return { lines, choiceRows, room, compact, editorRows, title: "? REVIEW ANSWERS" };
};

// ---- keys ------------------------------------------------------------------

export type SheetKey = KeyLike & { pageUp?: boolean; pageDown?: boolean };

/** What a key did to the sheet. `close` keeps the progress for the request
 *  panel; `submit` carries validated answers for the handle to send. */
export type SheetResult =
  | { t: "nav"; nav: QNav }
  | { t: "close"; nav: QNav }
  | { t: "submit"; nav: QNav; answers: Record<string, string> }
  | { t: "ignore" };

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** One keypress on the sheet. `room` is the visible body height, from
 *  {@link sheetLayout} at the size the pane is drawn. */
export const sheetKey = (
  qs: readonly AskUserQuestionItem[],
  nav: QNav,
  input: string,
  key: SheetKey,
  layout: Pick<SheetLayout, "lines" | "choiceRows" | "room">,
): SheetResult => {
  const q = qs[nav.idx];
  const { room, choiceRows } = layout;
  const maxOffset = Math.max(0, layout.lines.length - room);
  const go = (next: Partial<QNav>): SheetResult => ({ t: "nav", nav: { ...nav, ...next } });
  const step = (idx: number): SheetResult =>
    go({ idx: clamp(idx, 0, qs.length), cursor: 0, offset: 0, editing: false, notice: "" });

  if (key.escape) {
    if (nav.editing) return go({ editing: false });
    if (!q && qs.length > 0) return step(qs.length - 1);
    return { t: "close", nav: { ...nav, editing: false, notice: "" } };
  }
  if (key.pageUp || key.pageDown) {
    return go({ offset: clamp(nav.offset + (key.pageUp ? -room : room), 0, maxOffset) });
  }
  if (nav.busy) return { t: "ignore" };

  if (nav.editing && q) {
    const result = applyKey(nav.drafts[nav.idx] ?? buffer(), input, key);
    if (result.kind === "submit") return go({ editing: false });
    if (result.kind !== "buffer") return { t: "ignore" };
    return go({
      drafts: { ...nav.drafts, [nav.idx]: result.buffer },
      // A single-select question takes a choice or a custom answer, not both.
      ...(q.multiSelect ? {} : { selected: { ...nav.selected, [nav.idx]: [] } }),
      notice: "",
    });
  }

  if (key.leftArrow || key.rightArrow) return step(nav.idx + (key.leftArrow ? -1 : 1));

  if (!q) {
    if (!key.return) return { t: "ignore" };
    const problem = sheetProblem(qs, nav);
    if (problem) return go({ notice: problem });
    return { t: "submit", nav: { ...nav, notice: "" }, answers: sheetAnswers(qs, nav) };
  }

  const custom = q.options.length;
  const pick = (index: number): SheetResult => {
    if (index === custom) return go({ cursor: index, editing: true });
    if (index > custom) return { t: "ignore" };
    const prior = nav.selected[nav.idx] ?? [];
    const on = prior.includes(index);
    // Choosing again clears; a single-select question holds at most one.
    let chosen = on ? prior.filter((i) => i !== index) : [...prior, index];
    if (!q.multiSelect) chosen = on ? [] : [index];
    return go({
      cursor: index,
      selected: { ...nav.selected, [nav.idx]: chosen },
      ...(q.multiSelect ? {} : { drafts: { ...nav.drafts, [nav.idx]: buffer() } }),
      notice: "",
    });
  };

  if (key.tab) return go({ cursor: custom, editing: true });
  if (key.upArrow || key.downArrow) {
    const cursor = clamp(nav.cursor + (key.upArrow ? -1 : 1), 0, custom);
    const row = choiceRows[cursor];
    const offset =
      row === undefined
        ? nav.offset
        : clamp(Math.min(row, Math.max(nav.offset, row - room + 1)), 0, maxOffset);
    return go({ cursor, offset });
  }
  if (/^[1-9]$/.test(input)) return pick(Number(input) - 1);
  if (input === " ") return pick(nav.cursor);
  if (!key.return) return { t: "ignore" };

  const chosen = nav.selected[nav.idx] ?? [];
  const text = draftText(nav, nav.idx).trim();
  if (nav.cursor === custom && !text) return go({ editing: true });
  if (chosen.length === 0 && !text) {
    // ⏎ on an option of a single-select question picks it and moves on.
    if (!q.multiSelect && nav.cursor < custom) {
      const picked = pick(nav.cursor);
      return picked.t === "nav"
        ? { t: "nav", nav: { ...picked.nav, idx: nav.idx + 1, cursor: 0, offset: 0 } }
        : picked;
    }
    return go({ notice: "Choose an answer or enter text before continuing." });
  }
  return step(nav.idx + 1);
};
