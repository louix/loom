import assert from "node:assert/strict";
import { test } from "node:test";
import { mkSessionQueue } from "../backend/daemon/src/daemon/session-queue.ts";

/** A promise plus the handle to settle it — races here are driven by explicit
 *  barriers, never by sleeping and hoping. */
const mkDeferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("mkSessionQueue runs same-key ops one at a time, in issue order", async () => {
  // given
  const q = mkSessionQueue();
  const first = mkDeferred<void>();
  const log: string[] = [];

  // when — `a` parks; `b` and `c` are issued while it holds the key
  const a = q.run("s1", async () => {
    log.push("a:start");
    await first.promise;
    log.push("a:end");
  });
  const b = q.run("s1", async () => {
    log.push("b");
  });
  const c = q.run("s1", async () => {
    log.push("c");
  });
  // Ops start a microtask after they are issued (the chain hop), so let the
  // queue turn over before reading. Nothing behind `a` may have run — that is
  // the whole guarantee.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(log, ["a:start"]);
  first.resolve();
  await Promise.all([a, b, c]);

  // then
  assert.deepEqual(log, ["a:start", "a:end", "b", "c"]);
});

test("mkSessionQueue lets distinct keys run concurrently", async () => {
  // given
  const q = mkSessionQueue();
  const held = mkDeferred<void>();
  const log: string[] = [];

  // when
  const blocked = q.run("s1", async () => {
    await held.promise;
    log.push("s1");
  });
  await q.run("s2", async () => {
    log.push("s2");
  });

  // then — s2 finished while s1 is still parked
  assert.deepEqual(log, ["s2"]);
  held.resolve();
  await blocked;
  assert.deepEqual(log, ["s2", "s1"]);
});

test("mkSessionQueue does not let a failed op reject the ops queued behind it", async () => {
  // given
  const q = mkSessionQueue();
  const log: string[] = [];

  // when
  const failing = q.run("s1", async () => {
    log.push("boom");
    throw new Error("boom");
  });
  const after = q.run("s1", async () => {
    log.push("after");
    return 7;
  });

  // then — the failure reaches its own caller and nobody else's
  await assert.rejects(() => failing, /boom/);
  assert.equal(await after, 7);
  assert.deepEqual(log, ["boom", "after"]);
});

test("mkSessionQueue forgets a key once its chain drains", async () => {
  // given
  const q = mkSessionQueue();
  const held = mkDeferred<void>();

  // when
  const running = q.run("s1", () => held.promise);
  assert.deepEqual([...q.activeKeys], ["s1"]);
  held.resolve();
  await running;
  // The key is dropped from a `.then` on the settled tail, so let the
  // microtask queue turn over before reading it.
  await Promise.resolve();
  await Promise.resolve();

  // then — one dead entry per session ever configured would otherwise leak
  assert.deepEqual([...q.activeKeys], []);
});

test("mkSessionQueue keeps a key that a later op is still queued on", async () => {
  // given
  const q = mkSessionQueue();
  const held = mkDeferred<void>();

  // when — the *first* op finishing must not drop a chain the second is on
  const a = q.run("s1", async () => {});
  const b = q.run("s1", () => held.promise);
  await a;
  await Promise.resolve();
  await Promise.resolve();

  // then
  assert.deepEqual([...q.activeKeys], ["s1"]);
  held.resolve();
  await b;
});
