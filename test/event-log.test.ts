import assert from "node:assert/strict";
import { test } from "node:test";
import { EventLog } from "../src/daemon/event-log.ts";
import type { PushFrame } from "../src/protocol/wire.ts";

function evt(sessionId: string, text: string): Omit<Extract<PushFrame, { type: "event" }>, "seq"> {
  return {
    kind: "push",
    type: "event",
    event: { type: "assistant_text", sessionId, text, ts: 0 },
  };
}

test("append assigns strictly increasing seq from 1", () => {
  const log = new EventLog(10);
  assert.equal(log.head, 0);
  const a = log.append(evt("s1", "a"));
  const b = log.append(evt("s1", "b"));
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(log.head, 2);
  assert.equal(log.oldest, 1);
  assert.equal(log.size, 2);
});

test("since() returns frames strictly after the given seq", () => {
  const log = new EventLog(10);
  for (const c of ["a", "b", "c", "d"]) log.append(evt("s1", c));

  const r = log.since(2);
  assert.equal(r.rolled, false);
  assert.deepEqual(
    r.frames.map((f) => f.seq),
    [3, 4],
  );

  assert.deepEqual(log.since(4).frames, []);
  assert.equal(log.since(4).rolled, false);
  assert.equal(log.since(0).frames.length, 4);
});

test("since() reports rolled when the buffer has evicted the requested point", () => {
  const log = new EventLog(3);
  for (let i = 0; i < 6; i++) log.append(evt("s1", String(i)));
  // buffer now holds seq 4,5,6
  assert.equal(log.oldest, 4);
  assert.equal(log.head, 6);

  const rolled = log.since(2);
  assert.equal(rolled.rolled, true);

  // asking from exactly oldest-1 is still recoverable
  const ok = log.since(3);
  assert.equal(ok.rolled, false);
  assert.deepEqual(
    ok.frames.map((f) => f.seq),
    [4, 5, 6],
  );
});

test("since() with a seq ahead of head signals rolled (daemon restart)", () => {
  const log = new EventLog(10);
  log.append(evt("s1", "a"));
  const r = log.since(50);
  assert.equal(r.rolled, true);
  assert.deepEqual(r.frames, []);
});

test("capacity is enforced by evicting the oldest frame", () => {
  const log = new EventLog(2);
  log.append(evt("s1", "a"));
  log.append(evt("s1", "b"));
  log.append(evt("s1", "c"));
  assert.equal(log.size, 2);
  assert.equal(log.oldest, 2);
  assert.equal(log.head, 3);
});

test("subscribers receive every appended frame and can unsubscribe", () => {
  const log = new EventLog(10);
  const seen: number[] = [];
  const off = log.subscribe((f) => seen.push(f.seq));
  log.append(evt("s1", "a"));
  log.append(evt("s1", "b"));
  off();
  log.append(evt("s1", "c"));
  assert.deepEqual(seen, [1, 2]);
  assert.equal(log.listenerCount, 0);
});

test("a throwing subscriber does not stall the fan-out", () => {
  const log = new EventLog(10);
  const seen: number[] = [];
  log.subscribe(() => {
    throw new Error("boom");
  });
  log.subscribe((f) => seen.push(f.seq));
  log.append(evt("s1", "a"));
  assert.deepEqual(seen, [1]);
});

test("constructor rejects a capacity below 1", () => {
  assert.throws(() => new EventLog(0));
});
