import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncChannel } from "@loom/core/channel";

test("buffers values pushed before the consumer asks for them", async () => {
  const ch = new AsyncChannel<number>();
  ch.push(1);
  ch.push(2);
  ch.close();
  const got: number[] = [];
  for await (const v of ch) got.push(v);
  assert.deepEqual(got, [1, 2]);
});

test("delivers values pushed while the consumer is waiting", async () => {
  const ch = new AsyncChannel<string>();
  const got: string[] = [];
  const done = (async () => {
    for await (const v of ch) got.push(v);
  })();
  await Promise.resolve();
  ch.push("a");
  ch.push("b");
  await Promise.resolve();
  ch.close();
  await done;
  assert.deepEqual(got, ["a", "b"]);
});

test("close ends the loop even with a blocked consumer; further pushes are ignored", async () => {
  const ch = new AsyncChannel<number>();
  const done = (async () => {
    for await (const _v of ch) void _v;
  })();
  ch.close();
  ch.push(99); // no-op after close
  await done;
  assert.equal(ch.closed, true);
});

test("drain discards buffered values but keeps the stream open", async () => {
  const ch = new AsyncChannel<number>();
  ch.push(1);
  ch.push(2);
  assert.equal(ch.pending, 2);
  ch.drain();
  assert.equal(ch.pending, 0);
  assert.equal(ch.closed, false);
  ch.push(3);
  ch.close();
  const got: number[] = [];
  for await (const v of ch) got.push(v);
  assert.deepEqual(got, [3]);
});

test("undefined is a valid buffered value", async () => {
  const ch = new AsyncChannel<number | undefined>();
  ch.push(undefined);
  ch.push(5);
  ch.close();
  const got: Array<number | undefined> = [];
  for await (const v of ch) got.push(v);
  assert.deepEqual(got, [undefined, 5]);
});

test("at capacity, push drops the oldest and counts it", async () => {
  const ch = new AsyncChannel<number>(3);
  for (let i = 0; i < 6; i++) ch.push(i); // 0..5, cap 3
  ch.close();
  const got: number[] = [];
  for await (const v of ch) got.push(v);
  assert.deepEqual(got, [3, 4, 5], "kept the newest `capacity` items");
  assert.equal(ch.dropped, 3);
  assert.equal(ch.pending, 0);
});

test("a waiting consumer takes each push straight off the waiter — nothing is dropped", async () => {
  const ch = new AsyncChannel<number>(2); // tiny cap, but the consumer keeps pace
  const got: number[] = [];
  const done = (async () => {
    for await (const v of ch) {
      got.push(v);
      await new Promise((r) => setTimeout(r, 0));
    }
  })();
  for (let i = 0; i < 8; i++) {
    ch.push(i);
    await new Promise((r) => setTimeout(r, 1));
  }
  ch.close();
  await done;
  assert.deepEqual(got, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(ch.dropped, 0);
});

test("second concurrent iterator throws; sequential re-iteration is fine", async () => {
  const ch = new AsyncChannel<number>();
  ch.push(1);

  const first = ch[Symbol.asyncIterator]();
  await first.next(); // now actively iterating
  assert.throws(() => ch[Symbol.asyncIterator](), /single-consumer/);
  await first.return?.(undefined); // release

  // A fresh iterator after the first finished works and sees the rest.
  ch.push(2);
  ch.close();
  const got: number[] = [];
  for await (const v of ch) got.push(v);
  assert.deepEqual(got, [2]);
});
