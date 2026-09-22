import type { SessionInteraction } from "@loom/core/interaction";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "ink";
import stringWidth from "string-width";
import { markdownText, plainText } from "../frontend/tui/src/markdown.ts";
import {
  PlanReview,
  RequestPanel,
  requestPanelRows,
  askQuestionLines,
  EventLog,
} from "@loom/tui/components";
import {
  queuedLine,
  formatEvent,
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
          loading: false,
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
    const shaded = rows.filter((r) => r.spans.length && r.spans.every((s) => s.background));
    assert.ok(shaded.length >= 4);
    for (const r of shaded) {
      assert.equal(stringWidth(r.text), width);
      assert.ok(r.spans.every((s) => s.background === "code"));
    }
    assert.ok(shaded.some((r) => r.text.trim() === ""));
    assert.ok(
      rows.filter((r) => /quote/.test(r.text)).every((r) => r.spans.every((s) => !s.background)),
    );
  }
  const nested = markdownText("> ~~~\n> x\n> ~~~").layout(20);
  const code = nested.find((r) => r.text.includes("x"))!;
  assert.equal(stringWidth(code.text), 20);
  assert.equal(code.spans[0]?.background, undefined);
  assert.ok(code.spans.slice(1).every((s) => s.background === "code"));
});

test("human messages and queued input retain literal lines while questions use Markdown", () => {
  const source = "build started\n  build failed\n\n**literal**\n- item";
  for (const kind of ["user_message", "answer"] as const) {
    const event = { type: kind, text: source, ts: 0, sessionId: "s", id: "a", injected: false };
    const line: LogLine = { id: null, sessionId: "s", kind, ts: 0, ...formatEvent(event) };
    const ctx = logContext([line], 100);
    assert.ok(windowRows(ctx, 0, totalRows(ctx)).every((r) => r.tone === "accent" && !r.spans));
    assert.equal(
      windowRows(ctx, 0, totalRows(ctx))
        .map((r) => r.seg)
        .join("\n"),
      source,
    );
  }
  const queued = queuedLine("s", source);
  const ctx = logContext([queued], 100);
  assert.ok(windowRows(ctx, 0, totalRows(ctx)).every((r) => r.tone === "dim" && !r.spans));
  assert.equal(
    windowRows(ctx, 0, totalRows(ctx))
      .map((r) => r.seg)
      .join("\n"),
    "queued: " + source,
  );
  const question: LogLine = {
    id: null,
    sessionId: "s",
    kind: "question",
    ts: 0,
    ...formatEvent({
      type: "question",
      sessionId: "s",
      id: "q",
      question: "**Choose** a `path`",
      ts: 0,
    }),
  };
  const rows = windowRows(logContext([question], 100), 0, 10);
  assert.equal(rows[0]?.seg, "Choose a path");
  assert.ok(rows[0]?.spans?.some((s) => s.bold));
});

test("formatted question and plan previews fit their measured height", () => {
  const questions = [
    {
      question: "**Choose**\n\n- carefully",
      header: "Choice",
      options: [{ label: "`first`", description: "**recommended**" }, { label: "second" }],
    },
  ];
  const requests: SessionInteraction[] = [
    {
      kind: "question",
      id: "q",
      at: 0,
      question: "**Choose**\n\n- carefully",
      context: "See `file.ts`",
    },
    { kind: "user_question", id: "q", at: 0, tool: "AskUserQuestion", input: { questions } },
    { kind: "plan_review", id: "p", at: 0, plan: "# Choose\n\n- carefully\n\n`file.ts`" },
  ];
  for (const width of [32, 80]) {
    for (const request of requests) {
      const out = renderToString(createElement(RequestPanel, { request, width }));
      assert.equal(out.split("\n").length, requestPanelRows(request, width));
      assert.ok(out.includes("Choose"));
      assert.ok(!out.includes("**Choose**"));
      assert.ok(!out.includes("`file.ts`"));
    }
    const lines = askQuestionLines(questions, 0, width - 4);
    assert.ok(lines.some((l) => l.includes("a) first")));
    assert.ok(lines.some((l) => l.includes("recommended")));
    assert.ok(lines.some((l) => l.includes("b) second")));
  }
});

test("plan review scrolls formatted rows and clamps to the final row", () => {
  const plan = {
    text: Array.from({ length: 25 }, (_, i) => "# Section " + i).join("\n\n"),
    mode: "plan" as const,
  };
  const first = renderToString(
    createElement(PlanReview, { plan, width: 80, height: 24, scroll: 0 }),
  );
  const last = renderToString(
    createElement(PlanReview, { plan, width: 80, height: 24, scroll: 999 }),
  );
  assert.ok(first.includes("Section 0"));
  assert.ok(!first.includes("# Section"));
  assert.ok(!first.includes("Section 24"));
  assert.ok(last.includes("Section 24"));
  assert.equal(first.split("\n").length, 24);
  assert.equal(last.split("\n").length, 24);
});

test("inline code shades only its content and document controls stay inert", () => {
  const spans = markdownText("Before `code` after").layout(80)[0]!.spans;
  assert.deepEqual(
    spans.filter((s) => s.background).map((s) => s.text),
    ["code"],
  );
  assert.equal(text("\x1b[31m**red**\x1b[0m"), "red");
});

test("document styling follows each theme independently of status colors", async () => {
  // Color support is detected when Ink loads, so use a fresh process even in NO_COLOR CI.
  const script = `
    import { createElement } from "react";
    import { renderToString } from "ink";
    import { PaletteContext, StyledText } from "${new URL("../frontend/tui/src/ui.tsx", import.meta.url).href}";
    import { PALETTES } from "${new URL("../frontend/tui/src/theme.ts", import.meta.url).href}";
    const spans = [
      {text:"Heading", role:"heading", bold:true},
      {text:"code", role:"code", background:"code"},
      {text:"link", role:"link"}, {text:"const", role:"keyword"},
      {text:"42", role:"number"}, {text:"comment", role:"muted"}
    ];
    const output = Object.values(PALETTES).map(palette => {
      const render = (p, subdued = false) => renderToString(
        createElement(PaletteContext.Provider, { value:p },
          createElement(StyledText, {spans, subdued})));
      return [
        render(palette),
        render({...palette, accent:"#010203", warn:"#040506", good:"#070809", await_:"#101112"}),
        render({...palette, document:{...palette.document, keyword:"#abcdef"}}),
        render(palette, true),
        render({...palette, document:{...palette.document, keyword:"#abcdef", link:"#abcdef", text:"#abcdef"}}, true)
      ];
    });
    console.log(JSON.stringify(output));
  `;
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["eval", script],
    env: { FORCE_COLOR: "3" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
  const output: string[][] = JSON.parse(new TextDecoder().decode(result.stdout));
  for (const [regular, statuses, keyword, subdued, subduedChanged] of output) {
    assert.ok(regular!.includes("\x1b["), "test must exercise actual terminal colors");
    assert.equal(statuses, regular);
    assert.notEqual(keyword, regular);
    assert.equal(subduedChanged, subdued);
    assert.ok(!subdued!.includes("[48;"), "thinking has no code background");
  }
});
