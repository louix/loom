/**
 * A small pure text-buffer editor for the TUI's prompt line. In-TUI it stays
 * single-line — Enter submits, there is no newline key — but it carries the
 * readline motions people expect (`⌃a`/`⌃e` line ends, `⌃b`/`⌃f` char steps,
 * `⌃u`/`⌃k`/`⌃w` kills, `⌃←`/`⌃→` word steps, arrow navigation) and renders fine when multi-line text
 * arrives from a paste or the `⌥e` `$EDITOR` handoff. No React or Ink
 * dependency: `applyKey` maps one keypress to an {@link EditResult}; the
 * component renders {@link Buffer} and re-dispatches the result. An
 * `{ multiline: false }` option tames it for single-line input lines (the
 * pickers' filter): pasted line breaks become spaces and ⇧/⌥⏎ inserts nothing,
 * while bare ⏎ still submits.
 *
 * Grammar: `Ctrl` is the text-editing modifier and nothing else — every `⌃`
 * combo here is a readline motion. The app's `⌥`-prefixed prompt actions
 * ($EDITOR, view log, provider/model, mode) are intercepted before this runs.
 */

export interface Buffer {
  text: string;
  /** Caret offset into `text`, 0..text.length. */
  cursor: number;
}

export const buffer = (text = "", cursor = text.length): Buffer => {
  return { text, cursor: clamp(cursor, 0, text.length) };
};

/** The subset of Ink's `key` object the editor looks at. */
export interface KeyLike {
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  tab?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export type EditResult =
  | { kind: "buffer"; buffer: Buffer }
  | { kind: "submit" }
  | { kind: "cancel" }
  | { kind: "history"; dir: -1 | 1 }
  | { kind: "ignore" };

/** Options for {@link applyKey}. */
export interface ApplyOpts {
  /** Single-line input line (the pickers' filter): pasted line breaks become
   *  spaces and ⇧/⌥⏎ inserts nothing; ⏎ still submits. Default `true`. */
  multiline?: boolean;
}
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Start / end offsets of the line containing `cursor`. */
export const lineBounds = (text: string, cursor: number): { start: number; end: number } => {
  const start = text.lastIndexOf("\n", cursor - 1) + 1;
  const nl = text.indexOf("\n", cursor);
  return { start, end: nl === -1 ? text.length : nl };
};

const verticalTarget = (text: string, cursor: number, dir: -1 | 1): number | null => {
  const { start, end } = lineBounds(text, cursor);
  const col = cursor - start;
  if (dir === -1) {
    if (start === 0) return null;
    const prevStart = text.lastIndexOf("\n", start - 2) + 1;
    const prevLen = start - 1 - prevStart;
    return prevStart + Math.min(col, prevLen);
  }
  if (end === text.length) return null;
  const nextStart = end + 1;
  const nextNl = text.indexOf("\n", nextStart);
  const nextLen = (nextNl === -1 ? text.length : nextNl) - nextStart;
  return nextStart + Math.min(col, nextLen);
};

/** Offset one word back from `cursor` (skips trailing whitespace, then the word). */
const wordLeft = (text: string, cursor: number): number => {
  let i = cursor;
  while (i > 0 && /\s/.test(text.charAt(i - 1))) i--;
  while (i > 0 && !/\s/.test(text.charAt(i - 1))) i--;
  return i;
};

/** Offset one word forward from `cursor` (skips leading whitespace, then the word). */
const wordRight = (text: string, cursor: number): number => {
  let i = cursor;
  while (i < text.length && /\s/.test(text.charAt(i))) i++;
  while (i < text.length && !/\s/.test(text.charAt(i))) i++;
  return i;
};

const edit = (text: string, cursor: number): EditResult => {
  return { kind: "buffer", buffer: { text, cursor: clamp(cursor, 0, text.length) } };
};

export const applyKey = (
  buf: Buffer,
  input: string,
  key: KeyLike,
  { multiline = true }: ApplyOpts = {},
): EditResult => {
  const { text, cursor } = buf;

  if (key.escape) return { kind: "cancel" };
  if (key.tab) return { kind: "ignore" }; // Tab is navigation-only; ⇧⇥ (mode) is app-intercepted before this
  if (key.return) {
    // ⇧⏎ / ⌥⏎ insert a newline; bare ⏎ submits. (Shift+Enter only reaches us in
    // terminals that send a distinct code — Alt+Enter is the portable one; ⌥e
    // still opens $EDITOR for heavier editing.) A single-line input line has
    // neither — ⇧/⌥⏎ is ignored there.
    if (key.shift || key.meta) {
      if (!multiline) return { kind: "ignore" };
      return edit(text.slice(0, cursor) + "\n" + text.slice(cursor), cursor + 1);
    }
    return { kind: "submit" };
  }

  if (key.ctrl) {
    // Ctrl is the text-editing modifier: readline motions only, nothing app-level.
    const { start, end } = lineBounds(text, cursor);
    if (key.leftArrow) return edit(text, wordLeft(text, cursor));
    if (key.rightArrow) return edit(text, wordRight(text, cursor));
    switch (input) {
      case "a":
        return edit(text, start);
      case "e":
        return edit(text, end);
      case "b":
        return edit(text, cursor - 1);
      case "f":
        return edit(text, cursor + 1);
      case "u":
        // Kill to the start of the line; but with nothing left to kill there
        // (caret already at column 0) the press wipes the whole buffer — the
        // quick way to clear a pasted wall of text without submitting it or
        // leaving a saved draft behind, which is what Esc does instead.
        if (cursor === start) return edit("", 0);
        return edit(text.slice(0, start) + text.slice(cursor), start);
      case "k":
        return edit(text.slice(0, cursor) + text.slice(end), cursor);
      case "w": {
        const i = wordLeft(text, cursor);
        return edit(text.slice(0, i) + text.slice(cursor), i);
      }
      default:
        return { kind: "ignore" }; // an unbound ⌃combo — swallow, never insert
    }
  }
  if (key.meta) return { kind: "ignore" }; // ⌥ combos are app-intercepted before this runs

  if (key.backspace || key.delete) {
    if (cursor === 0) return { kind: "ignore" };
    return edit(text.slice(0, cursor - 1) + text.slice(cursor), cursor - 1);
  }

  if (key.leftArrow) return edit(text, cursor - 1);
  if (key.rightArrow) return edit(text, cursor + 1);
  if (key.upArrow) {
    const t = verticalTarget(text, cursor, -1);
    return t === null ? { kind: "history", dir: -1 } : edit(text, t);
  }
  if (key.downArrow) {
    const t = verticalTarget(text, cursor, 1);
    return t === null ? { kind: "history", dir: 1 } : edit(text, t);
  }

  // Printable input, including a bracketed paste delivered as one chunk. The
  // regex strips the paste-bracket escapes (ESC [200~ / ESC [201~); the ESC is
  // load-bearing, so the control-character match is deliberate. Line breaks
  // normalize to newlines — or spaces on a single-line input line, and tabs
  // become a space too. Any other C0 control char or DEL that survives —
  // a stray ESC from copied ANSI-colored text, a backspace from a terminal
  // transcript — gets stripped rather than sinking the whole paste: this used
  // to be an all-or-nothing `isInsertable` check, so one bad byte anywhere in
  // a large paste silently dropped all of it.
  const clean = input
    // oxlint-disable-next-line no-control-regex
    .replace(/\x1b\[20[01]~/g, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/\r\n?|\n/g, multiline ? "\n" : " ")
    .replace(/\t/g, " ")
    // oxlint-disable-next-line no-control-regex
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
  if (clean !== "") {
    return edit(text.slice(0, cursor) + clean + text.slice(cursor), cursor + clean.length);
  }
  return { kind: "ignore" };
};

/** Split for rendering: the line list plus the caret's row / column. */
export const layout = (buf: Buffer): { lines: string[]; row: number; col: number } => {
  const lines = buf.text.split("\n");
  let pos = 0;
  for (let r = 0; r < lines.length; r++) {
    const len = (lines[r] ?? "").length;
    if (buf.cursor <= pos + len) return { lines, row: r, col: buf.cursor - pos };
    pos += len + 1;
  }
  const last = lines.length - 1;
  return { lines, row: last, col: (lines[last] ?? "").length };
};
/**
 * Soft-wrap one logical line to `room` columns: greedy break at the last space
 * that fits, hard-breaking a run with no space wider than the room. The space
 * at a wrap point stays in the buffer but gets no drawn cell; every other
 * character is drawn exactly once, in order. Returns the wrapped rows with
 * each row's start offset into `line`, so the caret can be mapped onto them.
 */
const wrapLine = (line: string, room: number): Array<{ text: string; start: number }> => {
  if (room < 1 || line.length <= room) return [{ text: line, start: 0 }];
  const rows: Array<{ text: string; start: number }> = [];
  let start = 0;
  while (start < line.length) {
    if (line.length - start <= room) {
      rows.push({ text: line.slice(start), start });
      break;
    }
    // Last space in the window; never at `start` itself, so every row advances.
    let br = -1;
    for (let p = start + room; p > start; p--) {
      if (line.charAt(p) === " ") {
        br = p;
        break;
      }
    }
    if (br === -1) {
      rows.push({ text: line.slice(start, start + room), start });
      start += room;
    } else {
      rows.push({ text: line.slice(start, br), start });
      start = br + 1;
    }
  }
  return rows;
};

/**
 * Split for rendering with word wrap: the buffer's physical rows (each logical
 * line soft-wrapped to `room` columns) plus the caret's row / column on them.
 * A caret sitting on a wrap-point space — which has no drawn cell — rides the
 * head of the continuation row; at true end of text it lands after the last
 * drawn character, as in {@link layout}.
 */
export const layoutWrapped = (
  buf: Buffer,
  room: number,
): { rows: string[]; row: number; col: number } => {
  const { lines, row, col } = layout(buf);
  const rows: string[] = [];
  let caretRow = 0;
  let caretCol = 0;
  lines.forEach((line, r) => {
    const base = rows.length;
    const segs = wrapLine(line, room);
    for (const { text } of segs) rows.push(text);
    if (r !== row) return;
    const hit = segs.find((s) => col >= s.start && col < s.start + s.text.length);
    if (hit) {
      caretRow = base + segs.indexOf(hit);
      caretCol = col - hit.start;
    } else if (col < line.length) {
      // `col` is a dropped break space: the next row's first cell stands in.
      caretRow = base + segs.findIndex((s) => s.start > col);
      caretCol = 0;
    } else {
      caretRow = rows.length - 1;
      caretCol = (rows[rows.length - 1] ?? "").length;
    }
  });
  return { rows, row: caretRow, col: caretCol };
};
