import { markdownText, plainText } from "../frontend/tui/src/markdown.ts";
import { logContext, totalRows, windowRows, type LogLine } from "../frontend/tui/src/transcript.ts";

const source = `## Findings

| Status | Evidence |
|---|---|
| Open | **Wrong lookup key** in customer capabilities |
| Fixed | Errors are preserved and reported |

- [x] Inspect the lookup
- [ ] Fix the key and preserve error handling

~~~ts
const customer = lookup[customerId];
// Preserve failures.
return customer ?? defaultCapabilities;
~~~

A paragraph with **bold**, *emphasis*, and [a link](https://example.com).
`;

Deno.bench("Markdown: parse and lay out a review", () => {
  markdownText(source).layout(80);
});
Deno.bench("Plain text: lay out the same source", () => {
  plainText(source).layout(80);
});
const doc = markdownText(source);
doc.layout(80);
Deno.bench("Markdown: cached layout", () => {
  doc.layout(80);
});
let width = 80;
Deno.bench("Markdown: resize with cached parse and code highlighting", () => {
  doc.layout((width = width === 80 ? 100 : 80));
});
const lines: LogLine[] = Array.from({ length: 10_000 }, (_, i) => ({
  id: null,
  sessionId: "bench",
  kind: "assistant_text",
  glyph: "▪",
  text: source + "\nEvent " + i,
  ts: i,
  tone: "plain",
}));
const ctx = logContext(lines, 100);
const total = totalRows(ctx);
Deno.bench("EVENTS: measure 10,000 cached events and select last 40 rows", () => {
  totalRows(ctx);
  windowRows(ctx, total - 40, total);
});
let serial = 0;
Deno.bench("EVENTS: append one review to 10,000 cached events", () => {
  const next = logContext([...lines, { ...lines[0]!, text: source + "\nNew " + serial++ }], 100);
  const count = totalRows(next);
  windowRows(next, count - 40, count);
});
