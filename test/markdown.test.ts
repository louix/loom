import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "ink";
import stringWidth from "npm:string-width@8.2.2";
import { markdownText, plainText } from "../frontend/tui/src/markdown.ts";
import { EventLog } from "@loom/tui/components";
import {
  logContext,
  type LogLine,
  totalRows,
  transcriptText,
  windowRows,
} from "@loom/tui/transcript";

const text = (source: string, width = 80) =>
  markdownText(source)
    .layout(width)
    .map((r) => r.text.trimEnd())
    .join("\n");
const fixture = `## Prior findings

| # | Status | Evidence |
|---|---|---|
| 1 | Resolved | \`file.ts:174\` now traverses concurrently |
| 2 | Open | **Read-only** users get extra capabilities |

## New findings

**NEW-1 — wrong key.** Lookup uses *accountId* instead of \`customerId\`.

- [x] Check the lookup
- [ ] Fix the key
  - Preserve error handling

> A quote with a [link](https://example.com).

~~~ts
const x = "**literal**";
  console.log(x);
~~~
`;

test("Markdown semantics include nested emphasis, escapes, entities, links, and literal HTML", () => {
  const rows = markdownText(
    "# Heading\n\n**bold *nested*** and ~~gone~~ and `a ** b`.\n\n\\*literal\\* &amp; [site][r]\n\n[r]: https://example.com\n\n<b>html</b>",
  ).layout(80);
  const spans = rows.flatMap((r) => r.spans);
  assert.ok(spans.some((s) => s.text === "Heading" && s.bold && s.role === "heading"));
  assert.ok(spans.some((s) => s.text === "nested" && s.bold && s.italic));
  assert.ok(spans.some((s) => s.text === "gone" && s.strikethrough));
  assert.ok(spans.some((s) => s.text === "a ** b" && s.role === "code"));
  const body = rows.map((r) => r.text.trimEnd()).join("\n");
  assert.match(body, /\*literal\* & site \(https:\/\/example.com\)/);
  assert.match(body, /<b>html<\/b>/);
});

test("tables wrap at wide widths and retain labelled content in narrow panes", () => {
  const wide = text(fixture, 90);
  assert.match(wide, /Status\s+│ Evidence/);
  const narrow = text(fixture, 28);
  assert.match(narrow, /Status: Resolved/);
  assert.match(narrow, /Evidence: file.ts:174/);
  assert.match(narrow, /• \[x\] Check the lookup/);
  assert.match(narrow, /      • Preserve error\n        handling/);
  assert.match(wide, /  console.log\(x\);/);
  assert.match(wide, /"\*\*literal\*\*"/);
  for (const width of [1, 8, 28, 90]) {
    for (const r of markdownText(fixture).layout(width)) {
      assert.ok(stringWidth(r.text) <= width, JSON.stringify(r.text));
    }
  }
});

test("wrapping preserves styled content, Unicode graphemes, and code indentation", () => {
  const source = "**你好你好你好** 👨‍👩‍👧‍👦 éééééé";
  const rows = markdownText(source).layout(6);
  for (const r of rows) assert.ok(stringWidth(r.text) <= 6);
  assert.equal(
    rows
      .map((r) => r.text.trimEnd())
      .join("")
      .replace(/ /g, ""),
    "你好你好你好👨‍👩‍👧‍👦éééééé",
  );
  assert.ok(
    rows
      .flatMap((r) => r.spans)
      .filter((s) => s.text.includes("你"))
      .every((s) => s.bold),
  );
  assert.equal(text("~~~\n  a\n\n    b\n~~~", 20), "  a\n\n    b");
});

test("streaming prefixes are valid documents and completion can reinterpret a table header", () => {
  for (let end = 0; end <= fixture.length; end++) {
    for (const r of markdownText(fixture.slice(0, end)).layout(32)) {
      assert.ok(stringWidth(r.text) <= 32);
    }
  }
  assert.match(text("Name | Status"), /Name \| Status/);
  assert.match(text("Name | Status\n--- | ---\na | b"), /Name\s+│ Status/);
});

test("documents cache layout, reflow on resize, and provide a plain fallback", () => {
  const doc = markdownText(fixture);
  const wide = doc.layout(90);
  assert.equal(doc.layout(90), wide);
  assert.notDeepEqual(doc.layout(25), wide);
  assert.deepEqual(doc.layout(90), wide);
  assert.equal(plainText("**raw**").layout(20)[0]?.text, "**raw**");
  const large = "**raw** ".repeat(26_000);
  assert.match(markdownText(large).layout(80)[0]!.text, /^\*\*raw\*\*/);
  assert.ok(!text("\x1b[31mtext\x07").includes("\x1b"));
});

test("EVENTS uses formatted geometry for every viewport and keeps raw exports and tools", () => {
  const line: LogLine = {
    id: null,
    sessionId: "s",
    kind: "assistant_text",
    glyph: "▪",
    text: fixture,
    ts: 0,
    tone: "plain",
  };
  for (const width of [42, 110]) {
    const ctx = logContext([line], width);
    const all = windowRows(ctx, 0, totalRows(ctx));
    for (let i = 0; i < all.length; i++) {
      assert.deepEqual(windowRows(ctx, i, i + 3), all.slice(i, i + 3));
    }
    assert.ok(all.some((r) => r.spans?.some((s) => s.bold)));
    const output = renderToString(
      createElement(EventLog, {
        width,
        view: {
          rows: all,
          child: null,
          tag: "",
          scrolled: false,
          above: 0,
          spinning: false,
        },
      }),
    );
    assert.ok(output.includes("Prior findings"));
    assert.ok(!output.includes("## Prior findings"));
  }
  assert.ok(transcriptText([line]).includes("## Prior findings"));
  const tool = { ...line, kind: "tool_result" as const, text: "- **literal**" };
  const rows = windowRows(logContext([tool], 80), 0, 10);
  assert.equal(rows[0]?.seg, "- **literal**");
  assert.equal(rows[0]?.spans, undefined);
});

test("code highlighting uses explicit languages, preserves tokens, and falls back", () => {
  const source = 'const n = 42; // comment\nconst s = "hello";';
  const rows = markdownText("~~~ts\n" + source + "\n~~~").layout(80);
  const spans = rows.slice(1).flatMap((r) => r.spans);
  assert.ok(spans.some((s) => s.text === "const" && s.role === "keyword"));
  assert.ok(spans.some((s) => s.text === "42" && s.role === "number"));
  assert.ok(spans.some((s) => s.text === '"hello"' && s.role === "string"));
  assert.ok(spans.some((s) => s.text.includes("// comment") && s.role === "muted"));
  assert.equal(
    rows
      .slice(1)
      .map((r) => r.text.trimEnd())
      .join("\n"),
    source,
  );
  const unknown = markdownText("~~~not-a-language\n" + source + "\n~~~").layout(80);
  assert.ok(
    unknown
      .slice(1)
      .flatMap((r) => r.spans)
      .every((s) => !s.text.trim() || s.role === "code"),
  );
  assert.equal(
    unknown
      .slice(1)
      .map((r) => r.text.trimEnd())
      .join("\n"),
    source,
  );
});

test("code surfaces fill wrapped and blank rows without shading prose or quote markers", () => {
  for (const width of [8, 24, 80]) {
    const rows = markdownText(
      '~~~ts\nconst greeting = "hello";\n\n  return greeting;\n~~~\n\n> a quote\n\nInline `code`.',
    ).layout(width);
    const shaded = rows.filter((r) => r.spans.some((s) => s.background));
    assert.ok(shaded.length >= 4);
    for (const r of shaded) {
      assert.equal(stringWidth(r.text), width);
      assert.ok(r.spans.every((s) => s.background === "code"));
    }
    assert.ok(shaded.some((r) => r.text.trim() === ""));
    assert.ok(
      rows
        .filter((r) => /quote|Inline/.test(r.text))
        .every((r) => r.spans.every((s) => !s.background)),
    );
  }
  const nested = markdownText("> ~~~\n> x\n> ~~~").layout(20);
  const code = nested.find((r) => r.text.includes("x"))!;
  assert.equal(stringWidth(code.text), 20);
  assert.equal(code.spans[0]?.background, undefined);
  assert.ok(code.spans.slice(1).every((s) => s.background === "code"));
});
