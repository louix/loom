import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createElement } from "react";
import { Box, renderToString, Text } from "ink";
import { EventLog } from "@loom/tui/components";
import {
  agentAuthor,
  ARCHIVE_REMINDER_AUTHOR,
  showAgentReportHead,
  showArchiveReminderLead,
  type AgentReportEvent,
} from "@loom/core/agents";
import {
  filterLog,
  logContext,
  type LogFilter,
  type LogLine,
  toLogLine,
  totalRows,
  windowRows,
} from "@loom/tui/transcript";

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

const CHILD_ID = "1ebeafe0-aaaa-bbbb-cccc-000000000000";

const note = (title: string, event: AgentReportEvent, cause: string): LogLine =>
  toLogLine(1, {
    type: "user_message",
    sessionId: "s",
    ts: Date.UTC(2026, 9, 12, 15, 56, 10),
    text: `${showAgentReportHead({ id: CHILD_ID, title, profile: "sonnet" }, event, cause)}\nIts workspace: 1 commit ahead of its base, nothing uncommitted.\nSummary: all done\nFor full details: run \`agent_read\` with id \`${CHILD_ID}\``,
    injected: false,
    author: agentAuthor(CHILD_ID),
  });

const reminder = (count: number): LogLine =>
  toLogLine(2, {
    type: "user_message",
    sessionId: "s",
    ts: Date.UTC(2026, 9, 12, 15, 56, 10),
    text: `${showArchiveReminderLead(count)}: 1ebeafe0 "T" (idle). Archive each with agent_stop.`,
    injected: false,
    author: ARCHIVE_REMINDER_AUTHOR,
  });

const renderedAt = (lines: readonly LogLine[], filter: LogFilter, width: number): string[] => {
  const ctx = logContext(filterLog(lines, filter, null), width);
  return windowRows(ctx, 0, totalRows(ctx)).map((r) => r.seg);
};

describe("chat verbosity shows a sub-agent report as one marker line", () => {
  test("each event kind", () => {
    // given
    const lines = [
      note("Fix the picker", "finished", ""),
      note("Fix the picker", "failed", ": the build broke"),
      note("Fix the picker", "interrupted", " (supervisor)"),
    ];
    // when
    const rows = renderedAt(lines, "chat", 80);
    // then
    assert.deepEqual(rows, [
      "sub-agent finished · Fix the picker",
      "sub-agent failed · Fix the picker",
      "sub-agent interrupted · Fix the picker",
    ]);
  });

  test("a long title is cut to one line, wrapped at a narrow pane", () => {
    // given
    const title = "New session ⌥p: agent profile rows don't fit ".repeat(4).trim();
    const lines = [note(title, "finished", "")];
    // when
    const rows = renderedAt(lines, "chat", 40);
    // then
    assert.ok(rows.every((row) => row.length <= 40));
    assert.equal(
      rows.join("").replace(/ +/g, " "),
      `sub-agent finished · ${title.slice(0, 79).replace(/ +/g, " ")}…`,
    );
  });

  test("the archive reminder, one child and several", () => {
    // given
    const lines = [reminder(1), reminder(3)];
    // when
    const rows = renderedAt(lines, "chat", 80);
    // then
    assert.deepEqual(rows, [
      "1 finished sub-agent not archived",
      "3 finished sub-agents not archived",
    ]);
  });

  test("fuller verbosity keeps the whole message", () => {
    // given
    const lines = [note("Fix the picker", "finished", ""), reminder(1)];
    // when
    const rows = renderedAt(lines, "everything", 100).join("\n");
    // then
    assert.match(
      rows,
      /\[from your sub-agent 1ebeafe0 "Fix the picker" \(profile sonnet\)\] It finished a turn\./,
    );
    assert.match(rows, /Summary: all done/);
    assert.match(rows, /For full details: run `agent_read`/);
    assert.match(rows, /\[loom\] You have 1 sub-agent that has finished/);
  });
});
