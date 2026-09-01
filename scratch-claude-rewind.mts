/**
 * Manual smoke test for Claude undo (fork-tree F3, step 4). NOT part of the
 * suite — it makes real Claude API calls via ~/.claude-personal.
 *
 *   node --import @oxc-node/core/register --test scratch-claude-rewind.mts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import type { SessionSnapshot } from "@loom/core/wire";
import { makeHarness } from "@loom/harness";

const CONFIG = `
[[claude_profiles]]
dir  = "~/.claude-personal"
name = "personal"

[providers.claude]
model = "claude-haiku-4-5-20251001"
`;

const PROVIDER = "claude:personal";

const get = (c: LoomClient, id: string) => c.request<SessionSnapshot>("session.get", { id });

const waitIdle = async (c: LoomClient, id: string, want: number): Promise<void> => {
  for (let i = 0; i < 300; i++) {
    const s = await get(c, id);
    if (s.status.kind === "error") throw new Error(`session errored: ${JSON.stringify(s.status)}`);
    if (s.turns >= want && s.status.kind === "idle") return;
    await delay(500);
  }
  throw new Error(`session ${id} never reached turn ${want}`);
};

type Ev = { seq: number; event: { type: string; text?: string } };
const eventsSince = async (c: LoomClient, id: string, afterSeq: number): Promise<string> => {
  const log = await c.request<Ev[]>("session.events", { id });
  return log
    .filter((f) => f.seq > afterSeq && f.event.type === "assistant_text")
    .map((f) => f.event.text ?? "")
    .join(" ")
    .toLowerCase();
};
const lastSeq = async (c: LoomClient, id: string): Promise<number> => {
  const log = await c.request<Ev[]>("session.events", { id });
  return log.at(-1)?.seq ?? 0;
};

test("claude undo: a rewound turn is gone from the model's context", async () => {
  const h = await makeHarness({ config: CONFIG });
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  try {
    const created = await c.request<SessionSnapshot>("session.create", {
      prompt: "Reply with only this word: ALPHA",
      provider: PROVIDER,
    });
    const id = created.id;
    console.log("session", id, "canRewind:", (await get(c, id)).canRewind);
    assert.equal((await get(c, id)).canRewind, true);
    await waitIdle(c, id, 1);

    await c.request("session.send", { id, text: "Reply with only this word: BRAVO" });
    await waitIdle(c, id, 2);

    const forks = h.daemon.db
      .prepare("SELECT turn, fork_point FROM checkpoints WHERE session_id = ? ORDER BY turn")
      .all(id) as Array<{ turn: number; fork_point: string }>;
    console.log("fork points:", JSON.stringify(forks));
    assert.equal(forks.length, 2);
    assert.ok(forks[0]!.fork_point.length > 10 && forks[1]!.fork_point.length > 10);

    // Undo turn 2 (BRAVO) — keep turn 1 (ALPHA).
    await c.request("session.rewind", { id, toTurn: 1 });
    assert.equal((await get(c, id)).turns, 1);
    const cps = await c.request<Array<{ turn: number }>>("session.checkpoints", { id });
    assert.deepEqual(
      cps.map((x) => x.turn),
      [1],
    );

    const mark = await lastSeq(c, id);
    await c.request("session.send", {
      id,
      text: "List every word I've asked you to reply with so far, in order, comma-separated. If none, say NONE.",
    });
    await waitIdle(c, id, 2);
    const answer = await eventsSince(c, id, mark);
    console.log("post-rewind answer:", answer);

    assert.ok(answer.includes("alpha"), "the kept turn (ALPHA) is still in context");
    assert.ok(!answer.includes("bravo"), "the rewound turn (BRAVO) is gone from context");
  } finally {
    await c.close();
    await h.cleanup();
  }
});
