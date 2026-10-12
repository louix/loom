import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseAgentReportHead,
  parseArchiveReminderCount,
  showAgentReportHead,
  showArchiveReminderLead,
} from "@loom/core/agents";

const CHILD_ID = "1ebeafe0-aaaa-bbbb-cccc-000000000000";

describe("parseAgentReportHead", () => {
  test("reads back the finished head the daemon words", () => {
    // given
    const head = showAgentReportHead(
      { id: CHILD_ID, title: "Fix the picker", profile: "sonnet" },
      "finished",
      "",
    );
    // when
    const report = parseAgentReportHead(`${head}\nIts workspace: nothing.\nSummary: done`);
    // then
    assert.deepEqual(report, { id: "1ebeafe0", title: "Fix the picker", event: "finished" });
  });

  test("reads back failed and interrupted heads with their cause", () => {
    // given
    const child = { id: CHILD_ID, title: "T", profile: "self" };
    // when
    const failed = parseAgentReportHead(showAgentReportHead(child, "failed", ": boom\nmore"));
    const interrupted = parseAgentReportHead(
      showAgentReportHead(child, "interrupted", " (supervisor)"),
    );
    // then
    assert.equal(failed?.event, "failed");
    assert.equal(interrupted?.event, "interrupted");
  });

  test("a title with quotes and parentheses survives", () => {
    // given
    const title = 'Say "hi" (twice) — ⌥p';
    // when
    const report = parseAgentReportHead(
      showAgentReportHead({ id: CHILD_ID, title, profile: "self" }, "finished", ""),
    );
    // then
    assert.equal(report?.title, title);
  });

  test("an empty title reads back empty", () => {
    // given
    const head = showAgentReportHead(
      { id: CHILD_ID, title: null, profile: "self" },
      "finished",
      "",
    );
    // when
    const report = parseAgentReportHead(head);
    // then
    assert.equal(report?.title, "");
  });

  test("text that is not a report reads as null", () => {
    // given
    const texts = [
      "",
      "hello",
      '[from your agent kid12345 "Kid" (profile self)] It finished a turn.',
    ];
    // when
    const reports = texts.map(parseAgentReportHead);
    // then
    assert.deepEqual(reports, [null, null, null]);
  });

  test("a head cut short in a queue preview reads as null", () => {
    // given
    const head = showAgentReportHead(
      { id: CHILD_ID, title: "x".repeat(300), profile: "self" },
      "finished",
      "",
    );
    // when
    const report = parseAgentReportHead(head.slice(0, 200));
    // then
    assert.equal(report, null);
  });
});

describe("parseArchiveReminderCount", () => {
  test("reads back one and several", () => {
    // given
    const lead = (n: number) => `${showArchiveReminderLead(n)}: 1ebeafe0 "T" (idle).`;
    // when
    const counts = [1, 2, 12].map((n) => parseArchiveReminderCount(lead(n)));
    // then
    assert.deepEqual(counts, [1, 2, 12]);
  });

  test("other text reads as null", () => {
    // given
    const text = "[loom] You have 3 uncommitted files";
    // when
    const count = parseArchiveReminderCount(text);
    // then
    assert.equal(count, null);
  });
});
