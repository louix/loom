import assert from "node:assert/strict";
import { test } from "node:test";
import { entryIdFor, mkComposer, outboxOf, release, type SendReply } from "@loom/tui/composer";

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** A composer whose `session.send` calls park until the test settles them. */
const fixture = () => {
  const calls: Array<{
    params: { text: string; entryId: string; delivery: string };
    resolve: (r: SendReply) => void;
    reject: (e: Error) => void;
  }> = [];
  const composer = mkComposer({
    send: (_id, params) =>
      new Promise<SendReply>((resolve, reject) => calls.push({ params, resolve, reject })),
  });
  return { composer, calls };
};

const dropped = () => Object.assign(new Error("connection dropped"), { code: "disconnected" });

test("a send is only on the wire until the daemon answers; the queue is the daemon's", async () => {
  const f = fixture();
  const sent = f.composer.send("a", "hello", "end_of_turn");
  assert.equal(f.composer.get().a?.t, "sending");
  assert.equal(f.calls[0]?.params.delivery, "end_of_turn");
  f.calls[0]!.resolve({ entryId: f.calls[0]!.params.entryId, state: "queued" });
  assert.equal((await sent).state, "queued");
  assert.equal(outboxOf(f.composer.get(), "a").t, "idle", "nothing is kept locally");
});

test("a send whose reply never came is held, and re-sending it unchanged reuses its id", async () => {
  const f = fixture();
  await assert.rejects(
    (async () => {
      const p = f.composer.send("a", "same", "next_boundary");
      f.calls[0]!.reject(dropped());
      await p;
    })(),
  );
  const held = f.composer.get().a;
  assert.equal(held?.t, "held");
  assert.equal(held?.t === "held" && held.failure, "uncertain");
  assert.equal(f.calls.length, 1, "never re-sent by itself");
  // Opening the prompt hands it back.
  assert.equal(release(held!)?.text, "same");
  // Sent again unchanged: the same entry id, so the daemon answers rather
  // than queueing it twice; edited, a fresh one.
  void f.composer.send("a", "same", "next_boundary").catch(() => {});
  assert.equal(f.calls[1]?.params.entryId, f.calls[0]?.params.entryId);
  assert.notEqual(entryIdFor(f.composer.get().a!, "edited"), f.calls[0]?.params.entryId);
});

test("a refused send is held as rejected; a later send owns the box", async () => {
  const f = fixture();
  const first = f.composer.send("a", "one", "next_boundary").catch(() => {});
  const second = f.composer.send("a", "two", "next_boundary");
  // The first fails after the second went out: it must not clobber it.
  f.calls[0]!.reject(new Error("queue full"));
  await first;
  await flush();
  assert.equal(f.composer.get().a?.t, "sending");
  f.calls[1]!.resolve({ entryId: f.calls[1]!.params.entryId, state: "consumed" });
  await second;
  assert.equal(outboxOf(f.composer.get(), "a").t, "idle");
  const third = f.composer.send("a", "three", "next_boundary").catch(() => {});
  f.calls[2]!.reject(new Error("queue full"));
  await third;
  const box = f.composer.get().a;
  assert.equal(box?.t === "held" && box.failure, "rejected");
});
