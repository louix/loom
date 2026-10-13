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
import { MessageQueueStore } from "@loom/daemon/store/message-queue";

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
      assert.deepEqual(fs.sendOptions.at(-1), {
        inputId: sent.entryId,
        midTurn: false,
        human: true,
      });
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

  test("a background sub-agent streaming does not reopen the turn for the queue", async (env) => {
    const { c } = env;
    const { id, fs } = await idleSession(env);
    fs.emit({ type: "background_tasks", tasks: [{ id: "a1", kind: "subagent", title: "audit" }] });
    await waitFor(async () => (await status(c, id)) === "working_background");
    fs.emit({ type: "assistant_text", text: "auditing", agentId: "a1" });
    fs.emit({ type: "tool_call", id: "t1", name: "Bash", input: {}, agentId: "a1" });
    await send(c, id, "e1", "end_of_turn");
    // The main loop is settled: a message goes now, as a fresh turn of its
    // own; one for the end of the turn waits for the sub-agent too.
    await send(c, id, "b1");
    await waitFor(() => fs.sends.length === 1);
    assert.deepEqual(fs.sends, ["b1"]);
    fs.finishTurn();
    await waitFor(async () => (await status(c, id)) === "working_background");
    await delay(30);
    assert.deepEqual(fs.sends, ["b1"], "the sub-agent is still working");
    fs.emit({ type: "background_tasks", tasks: [] });
    await waitFor(() => fs.sends.length === 2);
    assert.deepEqual(fs.sends, ["b1", "e1"]);
  });

  test("send now on a running turn goes over marked now at the tool window; a fold is not", async (env) => {
    const { c } = env;
    const { id, fs } = await runningSession(env);
    const m1 = await send(c, id, "m1");
    const m2 = await send(c, id, "m2", "end_of_turn");
    assert.equal(m1.state, "queued", "the model only writing: it waits");
    const view = (await entries(c, id)).find((e) => e.id === m2.entryId)!;
    await c.request("session.queueSendNow", { id, entryId: view.id, revision: view.revision });
    await delay(30);
    assert.deepEqual(fs.sends, [], "send now does not cut the model off mid-text");
    fs.emit({ type: "tool_call", id: "t1", name: "Bash", input: {} });
    await waitFor(() => fs.sends.length === 2);
    assert.deepEqual(fs.sends, ["m2", "m1"], "sent now, it goes first");
    assert.deepEqual(fs.sendOptions.slice(-2), [
      { inputId: m2.entryId, midTurn: true, now: true, human: true },
      { inputId: m1.entryId, midTurn: true, human: true },
    ]);
    // Once gone, the mark is spent: the next fold is ordinary.
    const m3 = await send(c, id, "m3");
    await waitFor(() => fs.sends.length === 3);
    assert.deepEqual(fs.sendOptions.at(-1), { inputId: m3.entryId, midTurn: true, human: true });
    // A supervisor's message, even sent now, is not passed off as typed by a person.
    env.h.daemon.sessions.enqueue(
      id,
      { entryId: "sup", text: "from above", author: "supervisor:x", delivery: "end_of_turn" },
      { sender: "supervisor" },
    );
    const sup = (await entries(c, id)).find((e) => e.id === "sup")!;
    await c.request("session.queueSendNow", { id, entryId: sup.id, revision: sup.revision });
    await waitFor(() => fs.sends.length === 4);
    assert.deepEqual(fs.sendOptions.at(-1), { inputId: "sup", midTurn: true });
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

  test("a user's stop holds even an empty queue: a send goes first and releases it", async (env) => {
    const { c, frames } = env;
    const { id, fs } = await runningSession(env);
    await c.request("session.interrupt", { id });
    const snap = await get(c, id);
    assert.equal(snap.status.kind, "interrupted");
    assert.deepEqual(snap.queue, { hold: "interrupt", holdBy: "user", entries: [] });
    assert.ok(!notices(frames).some((n) => n.includes("held")), "nothing held to review");
    await send(c, id, "go on");
    await waitFor(() => fs.sends.includes("go on"));
    assert.equal((await get(c, id)).queue, undefined, "the send released it");

    // Released by hand, it is simply gone.
    fs.emit({ type: "assistant_text", text: "busy" });
    await waitFor(async () => (await status(c, id)) === "running");
    await c.request("session.interrupt", { id });
    await c.request("session.queueRelease", { id });
    assert.equal((await get(c, id)).queue, undefined);
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
    // The user's stop holds the queue, empty as it is; the nudge is not in it.
    assert.deepEqual(
      snap.queue,
      { hold: "interrupt", holdBy: "user", entries: [] },
      "not surfaced as an entry",
    );
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

/**
 * Record the dispatch policy's store reads (`slots`, `entry`) that name
 * `sessionId` while `fn` runs. (`live` / `hold` also serve the snapshot, which
 * is published on its own schedule.)
 */
const spyOnQueueStore = async (
  sessionId: () => string | undefined,
  fn: (calls: string[]) => Promise<void>,
): Promise<void> => {
  const proto = MessageQueueStore.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const names = ["slots", "entry"];
  const saved = new Map(names.map((n) => [n, proto[n]!]));
  const calls: string[] = [];
  for (const [name, original] of saved)
    proto[name] = function (this: unknown, ...args: unknown[]) {
      if (args[0] === sessionId()) calls.push(name);
      return original.apply(this, args);
    };
  try {
    await fn(calls);
  } finally {
    for (const [name, original] of saved) proto[name] = original;
  }
};

nodeTest("text deltas never query the queue; a tool boundary and a turn's end still dispatch", () =>
  withEnv(async (env) => {
    const { c, frames } = env;
    let sid: string | undefined;
    await spyOnQueueStore(
      () => sid,
      async (calls) => {
        const { id, fs } = await runningSession(env);
        sid = id;
        const deltas = () =>
          frames.filter(
            (f) =>
              f.type === "event" && f.event.sessionId === id && f.event.type === "assistant_text",
          ).length;
        const stream = async (n: number) => {
          const before = deltas();
          calls.length = 0;
          for (let i = 0; i < n; i++) fs.emit({ type: "assistant_text", text: `delta ${i}` });
          await waitFor(() => deltas() === before + n);
          await delay(20);
          assert.deepEqual(calls, [], "no store read per delta");
        };
        // An empty queue …
        await stream(50);
        // … and a waiting one alike: a delta cannot change what dispatch says.
        const b1 = await send(c, id, "b1");
        const e1 = await send(c, id, "e1", "end_of_turn");
        assert.equal(b1.state, "queued");
        await stream(50);
        assert.deepEqual(fs.sends, []);
        // A root tool opens the boundary window: the boundary message folds in.
        fs.emit({ type: "tool_call", id: "t1", name: "Bash", input: {} });
        await waitFor(() => fs.sends.length === 1);
        assert.deepEqual(fs.sendOptions[0], { inputId: b1.entryId, midTurn: true, human: true });
        fs.emit({ type: "tool_result", id: "t1", ok: true, output: "" });
        await waitFor(() =>
          frames.some((f) => f.type === "event" && f.event.type === "tool_result"),
        );
        await stream(20);
        // The turn ends: the end-of-turn message starts the next one.
        fs.finishTurn();
        await waitFor(() => fs.sends.length === 2);
        assert.deepEqual(fs.sendOptions[1], {
          inputId: e1.entryId,
          midTurn: false,
          human: true,
        });
      },
    );
  }),
);

/** The hold as the snapshot carries it: reason and whose. */
const holdOf = async (c: LoomClient, id: string) => {
  const q = (await get(c, id)).queue;
  return q ? { hold: q.hold, by: q.holdBy ?? null } : { hold: null, by: null };
};

/** A session whose turn is running with `text` queued behind it. */
const queuedBehind = async (env: Env, text: string) => {
  const s = await runningSession(env);
  await send(env.c, s.id, text);
  return s;
};

// docs/message-queue.md, "Holds": the rules as the daemon applies them.
describe("holds", { concurrency: 4 }, () => {
  test("H1: a doubtful hand-over on the user's hold leaves it the user's", async (env) => {
    const { c } = env;
    const { id, fs } = await queuedBehind(env, "m1");
    await c.request("session.interrupt", { id });
    assert.deepEqual(await holdOf(c, id), { hold: "interrupt", by: "user" });
    // Send now goes through the hold; its hand-over may not have arrived.
    fs.failNextSend = new DeliveryUncertainError("worker exited");
    const view = (await entries(c, id))[0]!;
    await c.request("session.queueSendNow", { id, entryId: view.id, revision: view.revision });
    await waitFor(async () => (await entries(c, id))[0]?.uncertain === true);
    assert.deepEqual(await holdOf(c, id), { hold: "interrupt", by: "user" }, "not `rejected`");
    // So a supervisor's message still waits behind it.
    const sup = env.h.daemon.sessions.enqueue(
      id,
      { entryId: "sup", text: "from above", author: "supervisor:x", delivery: "next_boundary" },
      { sender: "supervisor" },
    );
    assert.equal(sup.waited, true);
    assert.equal(sup.revive, false);
  });

  test("H1: the user stopping a compaction holds what waits as the user's", async (env) => {
    const { c } = env;
    const { id, fs } = await idleSession(env);
    const release = fs.blockCompact();
    const compacting = c.request("session.compact", { id }).catch(() => {});
    await waitFor(() => fs.compacts.length === 1);
    assert.equal((await send(c, id, "after")).state, "queued");
    await c.request("session.interrupt", { id });
    assert.deepEqual(await holdOf(c, id), { hold: "interrupt", by: "user" }, "not no one's");
    release();
    await compacting;
    await delay(30);
    assert.deepEqual(fs.sends, [], "held for the user");
  });

  test("H1: the user stopping a compaction makes a supervisor's hold the user's", async (env) => {
    const { c, h } = env;
    const { id, fs } = await idleSession(env);
    const release = fs.blockCompact();
    const compacting = c.request("session.compact", { id }).catch(() => {});
    await waitFor(() => fs.compacts.length === 1);
    await send(c, id, "after");
    h.daemon.sessions.holdForStop(id, "supervisor");
    assert.deepEqual(await holdOf(c, id), { hold: "interrupt", by: "supervisor" });
    await c.request("session.interrupt", { id });
    assert.deepEqual(await holdOf(c, id), { hold: "interrupt", by: "user" });
    release();
    await compacting;
  });

  test("H3: a stop while a cold session comes back holds the message that lifted the hold", async (env) => {
    const { c, h, provider } = env;
    const { id, fs } = await queuedBehind(env, "later");
    // The adapter goes away by itself, a message waiting: a crash hold.
    fs.endStream();
    await waitFor(async () => (await holdOf(c, id)).hold === "crash");
    const unblock = provider.blockResume();
    const sending = send(c, id, "go on");
    await waitFor(() => provider.resumes.some((r) => r.sessionId === id));
    // The user stops it while it is coming back for the message.
    h.daemon.sessions.holdForStop(id, "user");
    unblock();
    await sending;
    await delay(50);
    assert.deepEqual(provider.session(id)!.sends, [], "the stop held it");
    assert.deepEqual(await holdOf(c, id), { hold: "interrupt", by: "user" });
    assert.deepEqual(
      (await entries(c, id)).map((e) => e.preview),
      ["go on", "later"],
      "first in line, held",
    );
  });

  test("H5: a send whose revival fails is taken back and the hold it lifted restored", async (env) => {
    const { c, provider } = env;
    const { id, fs } = await queuedBehind(env, "later");
    fs.endStream();
    await waitFor(async () => (await holdOf(c, id)).hold === "crash");
    // Shadowed on the provider itself (the registry's wrapper calls it).
    provider.resumeSession = () => Promise.reject(new Error("no VM today"));
    const entryId = crypto.randomUUID();
    await assert.rejects(
      c.request("session.send", { id, text: "go on", entryId, by: "client-a" }),
      /no VM today/,
    );
    assert.deepEqual(await holdOf(c, id), { hold: "crash", by: null });
    assert.deepEqual(
      (await entries(c, id)).map((e) => e.preview),
      ["later"],
    );
    // The same message again, once the session can come back, is new.
    Reflect.deleteProperty(provider, "resumeSession");
    const again = await c.request<Sent>("session.send", {
      id,
      text: "go on",
      entryId,
      by: "client-a",
    });
    assert.equal(again.entryId, entryId);
    await waitFor(() => provider.session(id)?.sends.includes("go on") ?? false);
  });

  test("H5: a message handed over meanwhile is not taken back, and the send succeeds", async (env) => {
    const { c, h, provider } = env;
    const { id, fs } = await queuedBehind(env, "later");
    fs.endStream();
    await waitFor(async () => (await holdOf(c, id)).hold === "crash");
    const entryId = crypto.randomUUID();
    const store = new MessageQueueStore(h.daemon.db);
    // The revival fails, but the message went meanwhile.
    provider.resumeSession = () => {
      store.markDelivering(id, [entryId]);
      return Promise.reject(new Error("no VM today"));
    };
    try {
      const sent = await c.request<Sent>("session.send", {
        id,
        text: "go on",
        entryId,
        by: "client-a",
      });
      assert.equal(sent.state, "delivering");
      assert.deepEqual(await holdOf(c, id), { hold: null, by: null }, "the lift stands");
    } finally {
      Reflect.deleteProperty(provider, "resumeSession");
    }
    // The manager's own undo answers whether it took the message back.
    const late = h.daemon.sessions.enqueue(id, {
      entryId: "late",
      text: "late",
      author: "client-a",
      delivery: "next_boundary",
    });
    store.markDelivering(id, ["late"]);
    assert.equal(late.undo(), false);
    assert.equal(store.entry(id, "late")?.state, "delivering");
  });

  test("H2: only a cold session is revived for a message; a live one is dispatched", async (env) => {
    const { h, provider } = env;
    const { id, fs } = await idleSession(env);
    const msg = (entryId: string) => ({
      entryId,
      text: entryId,
      author: "client-a",
      delivery: "next_boundary" as const,
    });
    const live = h.daemon.sessions.enqueue(id, msg("live"));
    assert.equal(live.waited, false);
    assert.equal(live.revive, false, "a live session is not revived");
    await h.daemon.sessions.dispatch(id);
    await waitFor(() => fs.sends.includes("live"));
    fs.finishTurn();
    await waitFor(() => h.daemon.sessions.queueView(id) === null);
    fs.endStream();
    await waitFor(() => h.daemon.sessions.isEnded(id));
    const cold = h.daemon.sessions.enqueue(id, msg("cold"));
    assert.equal(cold.revive, true, "a cold one is");
    assert.equal(cold.undo(), true);
    // A send to a live session never resumes it.
    const before = provider.resumes.length;
    const { id: other } = await idleSession(env);
    await send(env.c, other, "hello");
    assert.equal(provider.resumes.length, before);
  });

  test(
    "H1/H3: a discard reported after the user lifted the stop's hold neither holds nor drops the send",
    async (env) => {
      const { c, provider } = env;
      const { id, fs } = await runningSession(env);
      fs.emit({ type: "tool_call", id: "t1", name: "Bash", input: { command: "sleep 9" } });
      const m1 = (await send(c, id, "m1")).entryId;
      await waitFor(() => fs.sends.includes("m1"));
      // The stop is slow to finish; its discard of m1 comes late.
      const stopped = Promise.withResolvers<void>();
      fs.interrupt = () => stopped.promise;
      const stopping = c.request("session.interrupt", { id });
      await waitFor(async () => (await holdOf(c, id)).by === "user");
      const resumes = provider.resumes.length;
      // The user sends: it lifts the hold, and waits only for the stop to end.
      const sent = await send(c, id, "go on");
      assert.equal(sent.state, "queued");
      assert.equal(provider.resumes.length, resumes, "a live session is not revived");
      fs.emit({ type: "input_discarded", items: [{ kind: "message", text: "m1", ref: m1 }] });
      await waitFor(async () =>
        (await entries(c, id)).some((e) => e.id === m1 && e.state === "queued"),
      );
      assert.deepEqual(await holdOf(c, id), { hold: null, by: null }, "the lift stands");
      assert.deepEqual(
        (await entries(c, id)).map((e) => e.preview),
        ["go on", "m1"],
        "the discarded entry goes behind the send",
      );
      stopped.resolve();
      await stopping;
      await waitFor(() => fs.sends.includes("go on"));
      assert.equal(fs.sends.indexOf("go on"), 1, "the user's send went first, alone");
    },
    true,
  );

  test(
    "H6: a discard put back while an archive closes voids nothing; the failed archive restores",
    async (env) => {
      const { c, h } = env;
      const { id, fs } = await idleSession(env);
      const m1 = (await send(c, id, "m1")).entryId;
      await waitFor(() => fs.sends.includes("m1"));
      const close = fs.close.bind(fs);
      fs.close = async () => {
        // The adapter drops what it had not started on, as it goes.
        fs.emit({ type: "input_discarded", items: [{ kind: "message", text: "m1", ref: m1 }] });
        await waitFor(async () => (await entries(c, id)).some((e) => e.state === "queued"));
        await close();
      };
      const worktree = (await get(c, id)).worktree!;
      const lock = (verb: "lock" | "unlock") =>
        new Deno.Command("git", { args: ["-C", h.repoRoot, "worktree", verb, worktree] }).output();
      // Loom lifts its own lock to remove a tree, but not one of the user's.
      await lock("unlock");
      await lock("lock");
      try {
        await assert.rejects(
          c.request("session.markDone", { id, force: true }),
          /could not remove the worktree/,
        );
      } finally {
        await lock("unlock");
        fs.close = close;
      }
      assert.deepEqual(
        await holdOf(c, id),
        { hold: null, by: null },
        "no user's hold left by an archive that did not happen",
      );
    },
    true,
  );

  test("H6: an archive whose worktree will not go leaves the hold as it was", async (env) => {
    const { c, h } = env;
    const { id } = await queuedBehind(env, "later");
    h.daemon.sessions.holdForStop(id, "supervisor");
    assert.deepEqual(await holdOf(c, id), { hold: "interrupt", by: "supervisor" });
    const worktree = (await get(c, id)).worktree!;
    const lock = (verb: "lock" | "unlock") =>
      new Deno.Command("git", { args: ["-C", h.repoRoot, "worktree", verb, worktree] }).output();
    // Loom lifts its own lock to remove a tree, but not one of the user's.
    await lock("unlock");
    await lock("lock");
    try {
      await assert.rejects(
        c.request("session.markDone", { id, force: true }),
        /could not remove the worktree/,
      );
    } finally {
      await lock("unlock");
    }
    assert.notEqual((await get(c, id)).status.kind, "done");
    assert.deepEqual(
      await holdOf(c, id),
      { hold: "interrupt", by: "supervisor" },
      "no user's hold left by an archive that did not happen",
    );
  });

  test("H6: a close that fails puts back the hold it set", async (env) => {
    const { c } = env;
    const { id, fs } = await idleSession(env);
    const close = fs.close.bind(fs);
    fs.close = () => Promise.reject(new Error("stuck"));
    try {
      await assert.rejects(c.request("session.markDone", { id }), /stuck/);
      assert.deepEqual(await holdOf(c, id), { hold: null, by: null });
    } finally {
      // Teardown closes it for real.
      fs.close = close;
    }
  });

  test("H7: while busy nothing goes, by any path; the user's send and release answer busy", async (env) => {
    const { c, h } = env;
    const { id, fs } = await queuedBehind(env, "m1");
    await c.request("session.interrupt", { id });
    h.daemon.sessions.setBusy(id, true);
    await assert.rejects(send(c, id, "now"), /workspace operation/);
    await assert.rejects(c.request("session.queueRelease", { id }), /workspace operation/);
    // Send now is not refused, but waits.
    const view = (await entries(c, id))[0]!;
    await c.request("session.queueSendNow", { id, entryId: view.id, revision: view.revision });
    // A Loom agent's message is queued, not refused.
    const sup = h.daemon.sessions.enqueue(
      id,
      { entryId: "sup", text: "from above", author: "supervisor:x", delivery: "end_of_turn" },
      { sender: "child" },
    );
    assert.equal(sup.result.ok, true);
    await h.daemon.sessions.dispatch(id);
    await delay(50);
    assert.deepEqual(fs.sends, [], "nothing went while busy");
    // The operation ends: what waited goes, by its own rules.
    h.daemon.sessions.setBusy(id, false);
    await waitFor(() => fs.sends.includes("m1"));
    assert.deepEqual(fs.sends, ["m1"], "send now's entry alone; the hold stays");
    assert.equal((await holdOf(c, id)).hold, "interrupt");
  });
});
