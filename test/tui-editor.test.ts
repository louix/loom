import assert from "node:assert/strict";
import { test } from "node:test";
import { applyKey, buffer, layout, lineBounds, type KeyLike } from "../src/tui/editor.ts";

const K = (over: Partial<KeyLike> = {}): KeyLike => ({ ...over });

function press(text: string, cursor: number, input: string, key: Partial<KeyLike> = {}) {
  return applyKey({ text, cursor }, input, K(key));
}

test("typing inserts at the cursor and advances it", () => {
  const r = press("helo", 3, "l");
  assert.deepEqual(r, { kind: "buffer", buffer: { text: "hello", cursor: 4 } });
});

test("backspace deletes the char before the cursor; a no-op at column 0", () => {
  assert.deepEqual(press("abc", 2, "", { backspace: true }), { kind: "buffer", buffer: { text: "ac", cursor: 1 } });
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

test("Enter submits; Escape cancels; Tab (either form) is navigation-only, inert here", () => {
  assert.deepEqual(press("hi", 2, "", { return: true }), { kind: "submit" });
  assert.deepEqual(press("hi", 2, "", { escape: true }), { kind: "cancel" });
  assert.deepEqual(press("hi", 2, "", { tab: true, shift: true }), { kind: "ignore" });
  assert.deepEqual(press("hi", 2, "", { tab: true }), { kind: "ignore" });
});

test("there is no newline key — Enter never inserts", () => {
  assert.deepEqual(press("hi", 2, "\r", { return: true, ctrl: true }), { kind: "submit" });
  assert.deepEqual(press("hi", 2, "j", { ctrl: true }), { kind: "ignore" });
});

test("an unbound modified key is swallowed, never inserted as the bare letter", () => {
  assert.deepEqual(press("hi", 2, "z", { ctrl: true }), { kind: "ignore" });
  assert.deepEqual(press("hi", 2, "x", { meta: true }), { kind: "ignore" }); // ⌥ combos: app-intercepted
});

test("⌃e is line-end (Ctrl is editing-only); ⌃o is unbound here — the app owns ⌥o", () => {
  assert.deepEqual(press("hi", 1, "e", { ctrl: true }), { kind: "buffer", buffer: { text: "hi", cursor: 2 } });
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
