import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyKey,
  buffer,
  layout,
  layoutWrapped,
  lineBounds,
  type KeyLike,
} from "@loom/tui/editor";

const K = (over: Partial<KeyLike> = {}): KeyLike => ({ ...over });

const press = (text: string, cursor: number, input: string, key: Partial<KeyLike> = {}) => {
  return applyKey({ text, cursor }, input, K(key));
};

test("typing inserts at the cursor and advances it", () => {
  const r = press("helo", 3, "l");
  assert.deepEqual(r, { kind: "buffer", buffer: { text: "hello", cursor: 4 } });
});

test("backspace deletes the char before the cursor; a no-op at column 0", () => {
  assert.deepEqual(press("abc", 2, "", { backspace: true }), {
    kind: "buffer",
    buffer: { text: "ac", cursor: 1 },
  });
  assert.deepEqual(press("abc", 0, "", { backspace: true }), { kind: "ignore" });
});

test("left / right arrows move the cursor and clamp at the ends", () => {
  assert.equal((press("abc", 1, "", { leftArrow: true }) as any).buffer.cursor, 0);
  assert.equal((press("abc", 0, "", { leftArrow: true }) as any).buffer.cursor, 0);
  assert.equal((press("abc", 3, "", { rightArrow: true }) as any).buffer.cursor, 3);
});

test("⌃a / ⌃e / ⌃b / ⌃f / ⌃u / ⌃k / ⌃w motions", () => {
  assert.equal((press("one two three", 7, "a", { ctrl: true }) as any).buffer.cursor, 0);
  assert.equal((press("one two three", 7, "e", { ctrl: true }) as any).buffer.cursor, 13);
  assert.equal((press("one two three", 7, "b", { ctrl: true }) as any).buffer.cursor, 6);
  assert.equal((press("one two three", 7, "f", { ctrl: true }) as any).buffer.cursor, 8);
  assert.deepEqual(press("one two three", 7, "u", { ctrl: true }), {
    kind: "buffer",
    buffer: { text: " three", cursor: 0 },
  });
  assert.deepEqual(press("one two three", 7, "k", { ctrl: true }), {
    kind: "buffer",
    buffer: { text: "one two", cursor: 7 },
  });
  assert.deepEqual(press("one two three", 8, "w", { ctrl: true }), {
    kind: "buffer",
    buffer: { text: "one three", cursor: 4 },
  });
});

test("⌃← / ⌃→ move by word, skipping runs of whitespace", () => {
  assert.equal(
    (press("one two three", 7, "", { ctrl: true, leftArrow: true }) as any).buffer.cursor,
    4,
  );
  assert.equal(
    (press("one two three", 7, "", { ctrl: true, rightArrow: true }) as any).buffer.cursor,
    13,
  );
  assert.equal(
    (press("one   two", 9, "", { ctrl: true, leftArrow: true }) as any).buffer.cursor,
    6,
  );
  assert.equal(
    (press("one   two", 0, "", { ctrl: true, rightArrow: true }) as any).buffer.cursor,
    3,
  );
});

test("Enter submits; Escape cancels; Tab (either form) is navigation-only, inert here", () => {
  assert.deepEqual(press("hi", 2, "", { return: true }), { kind: "submit" });
  assert.deepEqual(press("hi", 2, "", { escape: true }), { kind: "cancel" });
  assert.deepEqual(press("hi", 2, "", { tab: true, shift: true }), { kind: "ignore" });
  assert.deepEqual(press("hi", 2, "", { tab: true }), { kind: "ignore" });
});

test("⇧⏎ / ⌥⏎ insert a newline; plain ⏎ (or ⌃⏎) submits", () => {
  assert.deepEqual(press("ab", 1, "", { return: true, shift: true }), {
    kind: "buffer",
    buffer: { text: "a\nb", cursor: 2 },
  });
  assert.deepEqual(press("ab", 2, "", { return: true, meta: true }), {
    kind: "buffer",
    buffer: { text: "ab\n", cursor: 3 },
  });
  assert.deepEqual(press("hi", 2, "\r", { return: true, ctrl: true }), { kind: "submit" });
  assert.deepEqual(press("hi", 2, "j", { ctrl: true }), { kind: "ignore" });
});

test("an unbound modified key is swallowed, never inserted as the bare letter", () => {
  assert.deepEqual(press("hi", 2, "z", { ctrl: true }), { kind: "ignore" });
  assert.deepEqual(press("hi", 2, "x", { meta: true }), { kind: "ignore" }); // ⌥ combos: app-intercepted
});

test("⌃e is line-end (Ctrl is editing-only); ⌃o is unbound here — the app owns ⌥o", () => {
  assert.deepEqual(press("hi", 1, "e", { ctrl: true }), {
    kind: "buffer",
    buffer: { text: "hi", cursor: 2 },
  });
  assert.deepEqual(press("hi", 1, "o", { ctrl: true }), { kind: "ignore" });
});

test("a multi-line paste inserts verbatim, normalising CRLF, and stripping bracket markers", () => {
  const r = press("", 0, "\x1b[200~first\r\nsecond\x1b[201~") as any;
  assert.equal(r.kind, "buffer");
  assert.equal(r.buffer.text, "first\nsecond");
  assert.equal(r.buffer.cursor, "first\nsecond".length);
});

test("↑ / ↓ move within multi-line text, and ask for history at the edges", () => {
  const b = buffer("alpha\nbravo", 2); // on line 0
  assert.deepEqual(applyKey(b, "", K({ upArrow: true })), { kind: "history", dir: -1 });
  const down = applyKey(b, "", K({ downArrow: true })) as any;
  assert.equal(down.kind, "buffer");
  assert.equal(down.buffer.cursor, 8); // column 2 of "bravo"
  assert.deepEqual(applyKey({ text: "alpha\nbravo", cursor: 8 }, "", K({ downArrow: true })), {
    kind: "history",
    dir: 1,
  });
});

test("lineBounds and layout locate the caret", () => {
  assert.deepEqual(lineBounds("ab\ncd\nef", 4), { start: 3, end: 5 });
  const l = layout(buffer("ab\ncde", 5));
  assert.deepEqual([l.row, l.col], [1, 2]);
});

test("layoutWrapped soft-wraps at spaces, hard-breaking words wider than the room", () => {
  const w = layoutWrapped(buffer("one two three", 13), 8);
  assert.deepEqual(w.rows, ["one two", "three"]);
  assert.deepEqual([w.row, w.col], [1, 5]); // end-of-text caret rides after "three"
  assert.deepEqual(layoutWrapped(buffer("abcdefgh", 8), 3).rows, ["abc", "def", "gh"]);
  // A short line — and an empty buffer — stay a single row.
  const one = layoutWrapped(buffer("hi", 2), 80);
  assert.deepEqual(one.rows, ["hi"]);
  assert.deepEqual([one.row, one.col], [0, 2]);
  assert.deepEqual(layoutWrapped(buffer("", 0), 8), { rows: [""], row: 0, col: 0 });
});

test("layoutWrapped maps the caret across wrap points and logical lines", () => {
  // The wrap-point space gets no drawn cell, so the caret there rides the head
  // of the continuation row; one char later it sits on that row's first letter.
  const onSpace = layoutWrapped(buffer("one two", 3), 3);
  assert.deepEqual(onSpace.rows, ["one", "two"]);
  assert.deepEqual([onSpace.row, onSpace.col], [1, 0]);
  // Mid-word carets map with their row: col 6 is the 'o' of "two".
  assert.deepEqual(layoutWrapped(buffer("one two", 6), 3), {
    rows: ["one", "two"],
    row: 1,
    col: 2,
  });
  // Each logical line wraps independently; the caret stays with its line.
  const multi = layoutWrapped(buffer("aaa bbb\ncc", 9), 7);
  assert.deepEqual(multi.rows, ["aaa bbb", "cc"]);
  assert.deepEqual([multi.row, multi.col], [1, 1]);
});

test("single-line mode: pasted line breaks become spaces and ⇧/⌥⏎ inserts nothing", () => {
  const paste = applyKey(buffer("ab", 2), "x\r\ny", K(), { multiline: false });
  assert.deepEqual(paste, { kind: "buffer", buffer: { text: "abx y", cursor: 5 } });
  assert.deepEqual(
    applyKey(buffer("ab", 2), "", K({ return: true, shift: true }), { multiline: false }),
    { kind: "ignore" },
  );
  // The multiline default still inserts a newline for ⇧⏎.
  assert.equal((press("ab", 2, "", { return: true, shift: true }) as any).buffer.text, "ab\n");
});

test("single-line mode keeps ⏎ submit and the ⌃ readline motions", () => {
  assert.equal(
    applyKey(buffer("ab", 2), "", K({ return: true }), { multiline: false }).kind,
    "submit",
  );
  assert.equal(
    (applyKey(buffer("one two", 7), "u", K({ ctrl: true }), { multiline: false }) as any).buffer
      .text,
    "",
  );
});
