/** The portable handoff's content rules: what crosses, what is omitted and said so. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessEvent } from "@loom/core/events";
import type { HistoryPage } from "@loom/core/wire";
import {
  HANDOFF_BYTE_LIMIT,
  HANDOFF_MESSAGE_LIMIT,
  conversationHandoff,
  handoffPrompt,
} from "@loom/daemon/daemon/fork-context";

type Ev = HarnessEvent extends infer E
  ? E extends unknown
    ? Omit<E, "sessionId" | "ts">
    : never
  : never;

/** `events` as Loom's store pages them: newest page first, `size` per page. */
const pager = (events: Ev[], size = 7) => {
  const items = events.map((e, i) => ({
    id: i + 1,
    event: { sessionId: "src", ts: i, ...e } as HarnessEvent,
  }));
  return (olderThan?: number): HistoryPage => {
    const end = olderThan === undefined ? items.length : olderThan - 1;
    const start = Math.max(0, end - size);
    return {
      items: items.slice(start, end),
      olderCursor: start > 0 ? { olderThan: items[start]!.id } : null,
    };
  };
};

const source = { sessionId: "src", provider: "claude", model: "opus", turn: 3 };
const user = (text: string): Ev => ({ type: "user_message", text, injected: false });
const said = (text: string, agentId?: string): Ev =>
  ({ type: "assistant_text", text, ...(agentId ? { agentId } : {}) }) as Ev;

test("only visible user and assistant text crosses; everything else is named as omitted", () => {
  const h = conversationHandoff(
    source,
    "copy",
    "",
    pager([
      user("fix the bug"),
      { type: "thinking", text: "hidden reasoning" } as Ev,
      said("Looking."),
      { type: "tool_call", id: "t", name: "Bash", input: { cmd: "ls" } } as Ev,
      { type: "tool_result", id: "t", ok: true, output: "private" } as Ev,
      said("sub-agent chatter", "agent-1"),
      said("Fixed it."),
    ]),
  );
  assert.deepEqual(h.messages, [
    { role: "user", text: "fix the bug" },
    { role: "assistant", text: "Looking." },
    { role: "assistant", text: "Fixed it." },
  ]);
  assert.deepEqual(h.omissions, ["subagent-messages", "tool-activity"]);
  const prompt = handoffPrompt(h);
  assert.doesNotMatch(prompt, /hidden reasoning|private|sub-agent chatter/);
  assert.match(prompt, /not a native provider history/);
  assert.match(prompt, /does not authorize replaying earlier actions/);
  assert.match(prompt, /Next message:\nAcknowledge the handoff briefly/);
});

test("the newest messages win the message and byte budgets", () => {
  const many = Array.from({ length: HANDOFF_MESSAGE_LIMIT + 20 }, (_, i) => user(`m${i}`));
  const h = conversationHandoff(source, "copy", "go on", pager(many));
  assert.equal(h.messages.length, HANDOFF_MESSAGE_LIMIT);
  assert.equal(h.messages.at(-1)!.text, `m${HANDOFF_MESSAGE_LIMIT + 19}`);
  assert.equal(h.messages[0]!.text, "m20");
  assert.deepEqual(h.omissions, ["earlier-history"]);
  assert.match(handoffPrompt(h), /Next message:\ngo on$/);

  const big = "x".repeat(HANDOFF_BYTE_LIMIT - 10);
  const sized = conversationHandoff(
    source,
    "share",
    "",
    pager([user("tiny"), user("y".repeat(40)), user(big)]),
  );
  // The 40-byte message no longer fits beside the big one; the older small one does.
  assert.deepEqual(
    sized.messages.map((m) => m.text.length),
    ["tiny".length, big.length],
  );
  assert.deepEqual(sized.omissions, ["oversized-messages"]);
  assert.match(handoffPrompt(sized), /Workspace: the source session's own worktree/);
});
