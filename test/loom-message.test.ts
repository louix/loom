import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { showLoomMessage, type LoomMessage } from "@loom/core/loom-message";

const CHILD_ID = "1ebeafe0-aaaa-bbbb-cccc-000000000000";

const mkReport = (p: Partial<Extract<LoomMessage, { kind: "agent_report" }>>): LoomMessage => ({
  kind: "agent_report",
  child: { id: CHILD_ID, title: "Fix the picker", profile: "sonnet" },
  event: { kind: "finished" },
  workspace: null,
  summary: null,
  ...p,
});

describe("showLoomMessage", () => {
  test("a finished report with workspace and summary", () => {
    // given
    const message = mkReport({
      workspace: "1 commit ahead of its base, nothing uncommitted",
      summary: { text: "Fixed it", cut: false },
    });
    // when
    const text = showLoomMessage(message);
    // then
    assert.equal(
      text,
      '[from your sub-agent 1ebeafe0 "Fix the picker" (profile sonnet)] It finished a turn.\n' +
        "Its workspace: 1 commit ahead of its base, nothing uncommitted.\n" +
        "Summary: Fixed it\n" +
        `For full details: run \`agent_read\` with id \`${CHILD_ID}\``,
    );
  });

  test("a failed report names its cause, and a cut summary says so", () => {
    // given
    const message = mkReport({
      event: { kind: "failed", message: "the build broke" },
      summary: { text: "x", cut: true },
    });
    // when
    const text = showLoomMessage(message);
    // then
    assert.equal(
      text,
      '[from your sub-agent 1ebeafe0 "Fix the picker" (profile sonnet)] It failed: the build broke.\n' +
        "Summary (truncated): x\n" +
        `For full details: run \`agent_read\` with id \`${CHILD_ID}\``,
    );
  });

  test("an interrupted report with no title and no extras", () => {
    // given
    const message = mkReport({
      child: { id: CHILD_ID, title: null, profile: "self" },
      event: { kind: "interrupted", reason: "supervisor" },
    });
    // when
    const text = showLoomMessage(message);
    // then
    assert.equal(
      text,
      '[from your sub-agent 1ebeafe0 "" (profile self)] It was interrupted (supervisor).\n' +
        `For full details: run \`agent_read\` with id \`${CHILD_ID}\``,
    );
  });

  test("an archive reminder for one child and for several", () => {
    // given
    const one: LoomMessage = {
      kind: "archive_reminder",
      children: [{ id: CHILD_ID, title: "W", about: "idle, branch merged" }],
    };
    const two: LoomMessage = {
      kind: "archive_reminder",
      children: [
        { id: CHILD_ID, title: "W", about: "idle" },
        { id: "22222222-x", title: null, about: "failed" },
      ],
    };
    // when
    const [oneText, twoText] = [showLoomMessage(one), showLoomMessage(two)];
    // then
    assert.match(
      oneText!,
      /^\[loom\] You have 1 sub-agent that has finished and is not archived: 1ebeafe0 "W" \(idle, branch merged\)\. Archive each/,
    );
    assert.match(
      twoText!,
      /^\[loom\] You have 2 sub-agents that have finished and are not archived: 1ebeafe0 "W" \(idle\); 22222222 "" \(failed\)\. Archive each/,
    );
  });
});
