/**
 * A small pure text-buffer editor for the TUI's prompt line. In-TUI it stays
 * single-line — Enter submits, there is no newline key — but it carries the
 * readline motions people expect (`⌃a` line start, `⌃u`/`⌃k`/`⌃w` kills, arrow
 * navigation) and renders fine when multi-line text arrives from a paste or the
 * `⌃e` `$EDITOR` handoff. No React or Ink dependency: `applyKey` maps one
 * keypress to an {@link EditResult}; the component renders {@link Buffer} and
 * re-dispatches the result. `⌃e` is intercepted by the app before this runs.
 */

export interface Buffer {
  text: string;
  /** Caret offset into `text`, 0..text.length. */
  cursor: number;
}

export function buffer(text = "", cursor = text.length): Buffer {
  return { text, cursor: clamp(cursor, 0, text.length) };
}

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
  | { kind: "mode" }
  | { kind: "ignore" };

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Start / end offsets of the line containing `cursor`. */
export function lineBounds(text: string, cursor: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", cursor - 1) + 1;
  const nl = text.indexOf("\n", cursor);
  return { start, end: nl === -1 ? text.length : nl };
}

function verticalTarget(text: string, cursor: number, dir: -1 | 1): number | null {
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
}

function edit(text: string, cursor: number): EditResult {
  return { kind: "buffer", buffer: { text, cursor: clamp(cursor, 0, text.length) } };
}

/** Printable text: everything except C0 controls, but newlines are allowed. */
function isInsertable(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of s) {
    if (ch === "\n") continue;
    if (ch < " " || ch === "\x7f") return false;
  }
  return true;
}

export function applyKey(buf: Buffer, input: string, key: KeyLike): EditResult {
  const { text, cursor } = buf;

  if (key.escape) return { kind: "cancel" };
  if (key.tab) return key.shift ? { kind: "mode" } : { kind: "ignore" }; // ⇧⇥ cycles mode; ⇥ is inert here
  if (key.return) return { kind: "submit" }; // single-line: ⌃e hands off to $EDITOR for multi-line

  if (key.ctrl) {
    const { start, end } = lineBounds(text, cursor);
    switch (input) {
      case "a":
        return edit(text, start);
      case "e":
        return { kind: "ignore" }; // the app intercepts ⌃e (open $EDITOR) before this runs
      case "u":
        return edit(text.slice(0, start) + text.slice(cursor), start);
      case "k":
        return edit(text.slice(0, cursor) + text.slice(end), cursor);
      case "w": {
        let i = cursor;
        while (i > 0 && /\s/.test(text.charAt(i - 1))) i--;
        while (i > 0 && !/\s/.test(text.charAt(i - 1))) i--;
        return edit(text.slice(0, i) + text.slice(cursor), i);
      }
      default:
        return { kind: "ignore" }; // an unbound ⌃combo — swallow, never insert
    }
  }
  if (key.meta) return { kind: "ignore" }; // unbound alt-combo

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

  // Printable input, including a bracketed paste delivered as one chunk.
  const clean = input.replace(/\x1b\[20[01]~/g, "").replace(/\r\n?/g, "\n");
  if (clean !== "" && isInsertable(clean)) {
    return edit(text.slice(0, cursor) + clean + text.slice(cursor), cursor + clean.length);
  }
  return { kind: "ignore" };
}

/** Split for rendering: the line list plus the caret's row / column. */
export function layout(buf: Buffer): { lines: string[]; row: number; col: number } {
  const lines = buf.text.split("\n");
  let pos = 0;
  for (let r = 0; r < lines.length; r++) {
    const len = (lines[r] ?? "").length;
    if (buf.cursor <= pos + len) return { lines, row: r, col: buf.cursor - pos };
    pos += len + 1;
  }
  const last = lines.length - 1;
  return { lines, row: last, col: (lines[last] ?? "").length };
}
