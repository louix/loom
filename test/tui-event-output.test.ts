import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { Box, renderToString, Text } from "ink";
import { EventLog } from "@loom/tui/components";
import { logContext, type LogLine, totalRows, windowRows } from "@loom/tui/transcript";

test("tool output cannot move the cursor outside EVENTS", () => {
  // A PTY can produce CRCRLF when a command's CRLF is translated again.
  const source =
    "error\n\rAuto-merging frontend/tui/src/markdown.ts\r\r\n" +
    "CONFLICT (content): Merge conflict in frontend/tui/src/markdown.ts\r\n" +
    "\x1b[2K\x1b[1G\tfailed\b!\x07";
  const line: LogLine = {
    id: null,
    sessionId: "863bff41",
    kind: "tool_result",
    glyph: "↳",
    text: "error",
    full: source,
    ts: 0,
    tone: "bad",
  };
  for (const width of [50, 100, 180]) {
    const ctx = logContext([line], width);
    const rows = windowRows(ctx, 0, totalRows(ctx));
    for (const row of rows) {
      // eslint-disable-next-line no-control-regex -- assert terminal controls cannot reach Ink
      assert.doesNotMatch(row.seg, /[\x00-\x1f\x7f-\x9f]/);
    }
    const output = renderToString(
      createElement(
        Box,
        {},
        createElement(Box, { width: 24 }, createElement(Text, {}, "FLEET")),
        createElement(EventLog, {
          width,
          view: {
            loading: false,
            rows,
            child: null,
            tag: "",
            scrolled: false,
            above: 0,
            spinning: false,
          },
        }),
      ),
      { columns: width + 24 },
    );
    // eslint-disable-next-line no-control-regex -- rendered output must not move the cursor
    assert.doesNotMatch(output, /[\r\t\b\x07\x1b]/);
    for (const rendered of output.split("\n")) {
      assert.match(rendered.slice(0, 24), /^(?:FLEET)? *$/);
    }
    const content = rows.map((r) => r.seg).join("\n");
    assert.match(content, /Auto-merging/);
    assert.match(content, /CONFLICT \(content\):/);
    assert.match(content, /failed!/);
    // Scrolling and resizing must use the same safe physical rows.
    for (let i = 0; i < rows.length; i++) {
      assert.deepEqual(windowRows(ctx, i, i + 2), rows.slice(i, i + 2));
    }
  }
  assert.equal(line.full, source);
});

test("summary-only event text is normalized before row layout", () => {
  const line: LogLine = {
    id: null,
    sessionId: "s",
    kind: "startup_progress",
    glyph: "·",
    text: "preparing\rready\tfor input\x1b[2K",
    ts: 0,
    tone: "dim",
  };
  const ctx = logContext([line], 100);
  assert.deepEqual(
    windowRows(ctx, 0, totalRows(ctx)).map((r) => r.seg),
    ["preparing", "ready    for input"],
  );
});
