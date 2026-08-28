import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncChannel } from "../src/util/channel.ts";

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

test("undefined is a valid buffered value", async () => {
  const ch = new AsyncChannel<number | undefined>();
  ch.push(undefined);
  ch.push(5);
  ch.close();
  const got: Array<number | undefined> = [];
  for await (const v of ch) got.push(v);
  assert.deepEqual(got, [undefined, 5]);
});
