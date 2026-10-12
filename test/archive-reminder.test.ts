/**
 * The archive reminder's decision and wording (`archive-reminder.ts`); the
 * daemon end of it is in `loom-agents-daemon.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  archiveReminder,
  archiveReminderMessage,
  type ReminderChild,
  type ReminderSupervisor,
} from "@loom/daemon/daemon/archive-reminder";
import { showLoomMessage } from "@loom/core/loom-message";
import type { GitFacts } from "@loom/core/wire";

const mkChild = (p: Partial<ReminderChild> & Pick<ReminderChild, "id">): ReminderChild => ({
  title: p.id,
  state: "idle",
  reminded: false,
  reportPending: false,
  queued: false,
  ...p,
});

const FREE: ReminderSupervisor = { held: false, queued: false };

const mkGit = (p: Partial<GitFacts>): GitFacts => ({
  branch: "loom/child",
  commits: 0,
  lastCommitSubject: null,
  dirty: false,
  aheadOfBase: 0,
  behindBase: 0,
  ...p,
});

describe("archiveReminder", () => {
  test("no children", () => {
    // when
    const result = archiveReminder(FREE, []);
    // then
    assert.deepEqual(result, { kind: "none" });
  });

  test("idle, failed and interrupted children are named in order", () => {
    // given
    const children = [
      mkChild({ id: "a", state: "idle" }),
      mkChild({ id: "b", state: "error" }),
      mkChild({ id: "c", state: "interrupted" }),
    ];
    // when
    const result = archiveReminder(FREE, children);
    // then
    assert.deepEqual(result, {
      kind: "remind",
      children: [
        { id: "a", title: "a", finished: "idle" },
        { id: "b", title: "b", finished: "failed" },
        { id: "c", title: "c", finished: "interrupted" },
      ],
    });
  });

  test("running, starting, background, waiting and archived children are not finished", () => {
    // given
    const children = (
      ["running", "starting", "working_background", "awaiting_input", "done"] as const
    ).map((state) => mkChild({ id: state, state }));
    // when
    const result = archiveReminder(FREE, children);
    // then
    assert.deepEqual(result, { kind: "none" });
  });

  test("a child reminded about before is not named again", () => {
    // given
    const children = [mkChild({ id: "a", reminded: true }), mkChild({ id: "b" })];
    // when
    const result = archiveReminder(FREE, children);
    // then
    assert.deepEqual(result, {
      kind: "remind",
      children: [{ id: "b", title: "b", finished: "idle" }],
    });
  });

  test("a child whose report the supervisor has not seen waits", () => {
    // given
    const children = [mkChild({ id: "a", reportPending: true })];
    // when
    const result = archiveReminder(FREE, children);
    // then
    assert.deepEqual(result, { kind: "none" });
  });

  test("a child with messages waiting in its own queue is not finished", () => {
    // given
    const children = [mkChild({ id: "a", queued: true })];
    // when
    const result = archiveReminder(FREE, children);
    // then
    assert.deepEqual(result, { kind: "none" });
  });

  test("a held supervisor is reminded later", () => {
    // when
    const result = archiveReminder({ held: true, queued: true }, [mkChild({ id: "a" })]);
    // then
    assert.deepEqual(result, { kind: "later", why: "held" });
  });

  test("a supervisor with entries waiting is reminded later", () => {
    // when
    const result = archiveReminder({ held: false, queued: true }, [mkChild({ id: "a" })]);
    // then
    assert.deepEqual(result, { kind: "later", why: "queued" });
  });

  test("a held supervisor with nothing to remind about is left alone", () => {
    // when
    const result = archiveReminder({ held: true, queued: false }, [
      mkChild({ id: "a", state: "running" }),
    ]);
    // then
    assert.deepEqual(result, { kind: "none" });
  });
});

describe("archiveReminderMessage", () => {
  test("merged, unmerged, dirty and unknown workspaces", () => {
    // given
    const git: Record<string, GitFacts | null> = {
      "11111111-merged": mkGit({}),
      "22222222-ahead": mkGit({ aheadOfBase: 3, dirty: true }),
      "33333333-one": mkGit({ aheadOfBase: 1 }),
      "44444444-gone": null,
    };
    // when
    const message = archiveReminderMessage(
      [
        { id: "11111111-merged", title: "Merged", finished: "idle" },
        { id: "22222222-ahead", title: "Ahead", finished: "failed" },
        { id: "33333333-one", title: "One", finished: "interrupted" },
        { id: "44444444-gone", title: null, finished: "idle" },
      ],
      (id) => git[id] ?? null,
    );
    // then
    assert.equal(
      showLoomMessage(message),
      "[loom] You have 4 sub-agents that have finished and are not archived: " +
        '11111111 "Merged" (idle, branch merged); ' +
        '22222222 "Ahead" (failed, 3 commits not merged into yours, uncommitted changes); ' +
        '33333333 "One" (interrupted, 1 commit not merged into yours); ' +
        '44444444 "" (idle). ' +
        "Archive each with agent_stop once its work is merged or no longer needed, or keep it " +
        "if you will message it again. You won't be reminded about these again.",
    );
  });

  test("one agent", () => {
    // when
    const message = archiveReminderMessage(
      [{ id: "abcdefgh-1", title: "W", finished: "idle" }],
      () => mkGit({}),
    );
    // then
    assert.match(
      showLoomMessage(message),
      /^\[loom\] You have 1 sub-agent that has finished and is not archived: /,
    );
  });
});
