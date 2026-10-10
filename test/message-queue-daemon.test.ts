/**
 * The message queue end to end through the daemon (`docs/message-queue.md`):
 * dispatch, consumption, interrupt / hold / release, and the four decisions
 * recorded in the spec, against the fake provider.
 */
import assert from "node:assert/strict";
import { describe, test as nodeTest } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import type { PushFrame, SessionSnapshot } from "@loom/core/wire";
import type { FakeProvider, FakeSession } from "@loom/connector-mock";
import { DeliveryUncertainError, type QueueEntryView } from "@loom/core/message-queue";
import { makeHarness, type Harness } from "@loom/harness";

interface Env {
  h: Harness;
  c: LoomClient;
  provider: FakeProvider;
  frames: PushFrame[];
}

const connect = (h: Harness) =>
  LoomClient.connect({ repoRoot: h.repoRoot, sockPath: h.sockPath, autospawn: false });

const withEnv = async (fn: (env: Env) => Promise<void>, receipts = false): Promise<void> => {
  const h = await makeHarness();
  const c = await connect(h);
  try {
    const provider = (await h.daemon.providers.get("fake")) as FakeProvider;
    provider.capabilities.inputReceipts = receipts;
    const frames: PushFrame[] = [];
    c.onPush((f) => frames.push(f));
    await fn({ h, c, provider, frames });
  } finally {
    await c.close();
    await h.cleanup();
  }
};

const test = (name: string, fn: (env: Env) => Promise<void>, receipts = false) =>
  nodeTest(name, () => withEnv(fn, receipts));

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 2000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start >= ms) throw new Error("condition not met in time");
    await delay(5);
  }
};

const get = (c: LoomClient, id: string) => c.request<SessionSnapshot>("session.get", { id });

const status = async (c: LoomClient, id: string) => (await get(c, id)).status.kind;

/** A session that has finished its opening turn. */
const idleSession = async ({ c, provider }: Env): Promise<{ id: string; fs: FakeSession }> => {
  const snap = await c.request<SessionSnapshot>("session.create", {
    prompt: "start",
    provider: "fake",
  });
  await waitFor(() => provider.session(snap.id) !== undefined);
  const fs = provider.session(snap.id)!;
  fs.finishTurn();
  await waitFor(async () => (await status(c, snap.id)) === "idle");
  return { id: snap.id, fs };
};

/** A session whose turn is running, the model writing (no tool in flight). */
const runningSession = async (env: Env): Promise<{ id: string; fs: FakeSession }> => {
  const s = await idleSession(env);
  s.fs.emit({ type: "assistant_text", text: "thinking out loud" });
  await waitFor(async () => (await status(env.c, s.id)) === "running");
  return s;
};

type Sent = SessionSnapshot & { entryId: string; state: string };
const send = (c: LoomClient, id: string, text: string, delivery?: "end_of_turn") =>
  c.request<Sent>("session.send", { id, text, by: "client-a", ...(delivery ? { delivery } : {}) });

const entries = async (c: LoomClient, id: string): Promise<QueueEntryView[]> =>
  (await get(c, id)).queue?.entries ?? [];

const userMessages = (frames: PushFrame[]) =>
  frames.flatMap((f) =>
    f.type === "event" && f.event.type === "user_message"
      ? [{ text: f.event.text, injected: f.event.injected }]
      : [],
  );

const notices = (frames: PushFrame[]) =>
  frames.flatMap((f) => (f.type === "notice" ? [f.text] : []));

describe("message queue", { concurrency: 4 }, () => {
  test(
    "with receipts, a message enters the log only when the agent takes it",
    async (env) => {
      const { c, frames, h } = env;
      const { id, fs } = await idleSession(env);
      frames.length = 0;
      const sent = await send(c, id, "m1");
      assert.equal(sent.state, "delivering", "handed over, not yet taken");
      assert.deepEqual(fs.sendOptions.at(-1), { inputId: sent.entryId, midTurn: false });
      await delay(30);
      assert.deepEqual(userMessages(frames), []);
      // A second client sees the same queue, hint included.
      const other = await connect(h);
      try {
        const seen = await other.request<SessionSnapshot>("session.get", { id });
        assert.deepEqual(seen.queue?.entries, (await get(c, id)).queue?.entries);
        assert.equal(seen.queue?.entries[0]?.dequeue.t, "handed_over");
      } finally {
        await other.close();
      }
      fs.consume(sent.entryId, false);
      await waitFor(() => userMessages(frames).length === 1);
      assert.deepEqual(userMessages(frames), [{ text: "m1", injected: false }]);
      const ev = frames.find((f) => f.type === "event" && f.event.type === "user_message");
      assert.ok(ev?.type === "event" && ev.event.type === "user_message");
      assert.equal(ev.event.queueEntryId, sent.entryId);
      assert.equal(ev.event.author, "client-a");
      await waitFor(async () => (await get(c, id)).queue === undefined);
    },
    true,
  );

  test(
    "an interrupt requeues what the stop discarded in order, marks the rest uncertain and holds",
    async (env) => {
      const { c, frames } = env;
      const { id, fs } = await runningSession(env);
      frames.length = 0;
      fs.emit({ type: "tool_call", id: "t1", name: "Bash", input: { command: "sleep 9" } });
      await waitFor(async () => (await get(c, id)).status.kind === "running");
      const ids: string[] = [];
      for (const text of ["m1", "m2", "m3"]) ids.push((await send(c, id, text)).entryId);
      await waitFor(() => fs.sends.length === 3);
      assert.deepEqual(
        fs.sendOptions.map((o) => o?.midTurn),
        [true, true, true],
      );
      // The stop cancels m1 and m3 before the agent saw them; m2's fate is unknown.
      fs.interrupt = async () => {
        fs.emit({
          type: "input_discarded",
          items: [
            { kind: "message", text: "m1", ref: ids[0] },
            { kind: "message", text: "m3", ref: ids[2] },
          ],
        });
      };
      await c.request("session.interrupt", { id });
      await waitFor(
        async () => (await entries(c, id)).filter((e) => e.state === "queued").length === 2,
      );
      const snap = await get(c, id);
      assert.equal(snap.queue?.hold, "interrupt");
      assert.deepEqual(
        snap.queue?.entries.map((e) => [e.preview, e.state, e.uncertain]),
        [
          ["m1", "queued", false],
          ["m2", "delivering", true],
          ["m3", "queued", false],
        ],
      );
      assert.deepEqual(snap.queue?.entries[0]?.dequeue, { t: "held", reason: "interrupt" });
      await waitFor(() => notices(frames).some((n) => n.includes("3 messages held · q to review")));
      assert.deepEqual(userMessages(frames), [], "nothing unconsumed entered the log");
      await delay(30);
      assert.equal(fs.sends.length, 3, "nothing is re-sent while held");

      // Release: the requeued ones go, in order, as one fresh turn; the
      // uncertain one stays for the user to decide.
      await c.request("session.queueRelease", { id });
      await waitFor(() => fs.sends.length === 5);
      assert.deepEqual(fs.sends.slice(3), ["m1", "m3"]);
      assert.deepEqual(
        fs.sendOptions.slice(3).map((o) => o?.midTurn),
        [false, true],
      );
      assert.deepEqual(
        (await entries(c, id)).filter((e) => e.uncertain).map((e) => e.preview),
        ["m2"],
      );
    },
    true,
  );

  test("decision 2: a new message on a held queue goes first, alone, and releases the hold", async (env) => {
    const { c } = env;
    const { id, fs } = await runningSession(env);
    await send(c, id, "after it finishes", "end_of_turn");
    await send(c, id, "at a boundary");
    await c.request("session.interrupt", { id });
    await waitFor(async () => (await get(c, id)).queue?.hold === "interrupt");
    assert.deepEqual(fs.sends, []);

    const sent = await send(c, id, "do this instead");
    assert.equal(sent.state, "consumed");
    assert.deepEqual(fs.sends, ["do this instead"], "sent first, as a turn of its own");
    assert.equal(fs.sendOptions[0]?.midTurn, false);
    let snap = await get(c, id);
    assert.equal(snap.queue?.hold, null, "sending released the hold");
    assert.deepEqual(
      snap.queue?.entries.map((e) => [e.preview, e.dequeue.t]),
      [
        ["at a boundary", "next_tool_or_turn_end"],
        ["after it finishes", "turn_end"],
      ],
    );
    // The held boundary entry folds in at this turn's first tool …
    fs.emit({ type: "tool_call", id: "t1", name: "Read", input: {} });
    await waitFor(() => fs.sends.length === 2);
    assert.deepEqual(fs.sends.at(-1), "at a boundary");
    fs.emit({ type: "tool_result", id: "t1", ok: true, output: "" });
    // … and the held end-of-turn entry goes when the new turn ends.
    fs.finishTurn();
    await waitFor(() => fs.sends.length === 3);
    assert.deepEqual(fs.sends.at(-1), "after it finishes");
    snap = await get(c, id);
    assert.equal(snap.queue, undefined);
  });

  test("decision 4: end-of-turn messages wait for idle, background work included, one per idle", async (env) => {
    const { c } = env;
    const { id, fs } = await runningSession(env);
    await send(c, id, "e1", "end_of_turn");
    await send(c, id, "e2", "end_of_turn");
    await send(c, id, "b1");
    assert.deepEqual(
      (await entries(c, id)).map((e) => [e.preview, e.dequeue]),
      [
        ["b1", { t: "next_tool_or_turn_end" }],
        ["e1", { t: "turn_end", ahead: 0 }],
        ["e2", { t: "turn_end", ahead: 1 }],
      ],
    );
    // The turn ends with background work running: the boundary message goes
    // as a fresh turn, the end-of-turn ones keep waiting.
    fs.emit({ type: "background_tasks", tasks: [{ id: "bg", kind: "shell", title: "build" }] });
    fs.emit({ type: "result", kind: "ok" });
    await waitFor(() => fs.sends.length === 1);
    assert.deepEqual(fs.sends, ["b1"]);
    fs.emit({ type: "result", kind: "ok" });
    await waitFor(async () => (await status(c, id)) === "working_background");
    await delay(30);
    assert.deepEqual(fs.sends, ["b1"], "background work is not idle");
    fs.emit({ type: "background_tasks", tasks: [] });
    await waitFor(() => fs.sends.length === 2);
    assert.deepEqual(fs.sends, ["b1", "e1"]);
    await delay(30);
    assert.equal(fs.sends.length, 2, "one per idle");
    fs.finishTurn();
    await waitFor(() => fs.sends.length === 3);
    assert.deepEqual(fs.sends, ["b1", "e1", "e2"]);
  });

  test("send now on a held queue delivers that one alone and leaves the rest held", async (env) => {
    const { c } = env;
    const { id, fs } = await runningSession(env);
    await send(c, id, "m1");
    const m2 = await send(c, id, "m2");
    await c.request("session.interrupt", { id });
    await waitFor(async () => (await get(c, id)).queue?.hold === "interrupt");
    const view = (await entries(c, id)).find((e) => e.id === m2.entryId)!;
    await c.request("session.queueSendNow", { id, entryId: view.id, revision: view.revision });
    await waitFor(() => fs.sends.length === 1);
    assert.deepEqual(fs.sends, ["m2"]);
    const snap = await get(c, id);
    assert.equal(snap.queue?.hold, "interrupt");
    assert.deepEqual(
      snap.queue?.entries.map((e) => e.preview),
      ["m1"],
    );
  });

  test("an uncertain hand-over holds the queue and is resent only on a confirmed send now", async (env) => {
    const { c } = env;
    const { id, fs } = await idleSession(env);
    fs.failNextSend = new DeliveryUncertainError("worker exited");
    const m1 = await send(c, id, "m1");
    assert.equal(m1.state, "delivering");
    let snap = await get(c, id);
    assert.equal(snap.queue?.hold, "rejected");
    assert.equal(snap.queue?.entries[0]?.uncertain, true);
    const view = snap.queue!.entries[0]!;
    await assert.rejects(
      c.request("session.queueSendNow", { id, entryId: view.id, revision: view.revision }),
      /may already have reached the agent/,
    );
    // Releasing does not release an uncertain entry either.
    await c.request("session.queueRelease", { id });
    await delay(30);
    assert.deepEqual(fs.sends, []);
    snap = await get(c, id);
    const again = snap.queue!.entries[0]!;
    await c.request("session.queueSendNow", {
      id,
      entryId: again.id,
      revision: again.revision,
      confirm: true,
    });
    await waitFor(() => fs.sends.length === 1);
    assert.deepEqual(fs.sends, ["m1"]);
  });

  test("decision 3: Loom's own sends bypass the queue, and a stop that discards one drops it", async (env) => {
    const { c, frames, h } = env;
    const { id, fs } = await runningSession(env);
    // Hook feedback / nudges keep their direct, echoed-at-once send.
    await h.daemon.sessions.send(id, "loom nudge", { automated: true });
    assert.deepEqual(fs.sends, ["loom nudge"]);
    assert.equal((await get(c, id)).queue, undefined);
    fs.interrupt = async () => {
      fs.emit({
        type: "input_discarded",
        items: [{ kind: "message", text: "loom nudge", ref: "not-a-queue-entry" }],
      });
    };
    await c.request("session.interrupt", { id });
    await delay(50);
    const snap = await get(c, id);
    assert.equal(snap.queue, undefined, "not surfaced as an entry, no hold");
    assert.equal(fs.sends.length, 1, "not re-sent");
    assert.ok(!notices(frames).some((n) => n.includes("held")));
  });

  test("queue edits quote the revision they saw; a stale one is a conflict", async (env) => {
    const { c } = env;
    const { id } = await runningSession(env);
    const sent = await send(c, id, "draft one");
    const view = (await entries(c, id))[0]!;
    await c.request("session.queueEdit", {
      id,
      entryId: view.id,
      revision: view.revision,
      text: "draft two",
    });
    const full = await c.request<{ text: string }>("session.queueEntry", {
      id,
      entryId: sent.entryId,
    });
    assert.equal(full.text, "draft two");
    await assert.rejects(
      c.request("session.queueEdit", {
        id,
        entryId: view.id,
        revision: view.revision,
        text: "lost update",
      }),
      (e: unknown) => (e as { code?: string }).code === "conflict",
    );
    // Retrying a send with the same id is answered, not queued twice.
    const retried = await c
      .request<Sent>("session.send", {
        id,
        text: "draft one",
        entryId: sent.entryId,
      })
      .catch((e: unknown) => e);
    assert.equal((retried as { code?: string }).code, "conflict", "the text has moved on");
    assert.equal((await entries(c, id)).length, 1);
  });
});

nodeTest("a restart marks a handed-over message uncertain and holds the queue", async () => {
  const h = await makeHarness();
  let c = await connect(h);
  try {
    const provider = (await h.daemon.providers.get("fake")) as FakeProvider;
    provider.capabilities.inputReceipts = true;
    const { id } = await idleSession({ h, c, provider, frames: [] });
    const sent = await send(c, id, "in flight");
    assert.equal(sent.state, "delivering");
    await c.close();
    await h.restart();
    c = await connect(h);
    const snap = await get(c, id);
    assert.equal(snap.queue?.hold, "restart");
    assert.deepEqual(
      snap.queue?.entries.map((e) => [e.preview, e.state, e.uncertain]),
      [["in flight", "delivering", true]],
    );
  } finally {
    await c.close();
    await h.cleanup();
  }
});
