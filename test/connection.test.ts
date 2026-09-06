import assert from "node:assert/strict";
import { test } from "node:test";
import type { Frame, PushFrame } from "@loom/core/wire";
import { setLogLevel } from "@loom/core/logger";
import { Connection, type FramedConn } from "@loom/daemon/daemon/connection";

setLogLevel("error");

/** Resolve on the next microtask — enough hops for a `Connection#push`'s
 *  fire-and-forget `write()` chain (queue → write → backlog decrement) to
 *  settle before a test asserts on it. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** A `FramedConn` stand-in: records writes, lets a test hold a write's
 *  promise open to simulate a client that isn't draining, and fires the
 *  read loop's EOF (`read()` resolving `null`) to simulate a close. */
const fakeConn = () => {
  let resolveRead: (n: number | null) => void = () => {};
  const readGate = new Promise<number | null>((r) => {
    resolveRead = r;
  });
  let writeGate: { resolve: (n: number) => void } | null = null;
  const decoder = new TextDecoder();
  return {
    writes: [] as string[],
    destroyed: false,
    /** Never resolves on its own — this stand-in only exercises writes. */
    read: (_p: Uint8Array): Promise<number | null> => readGate,
    write(p: Uint8Array): Promise<number> {
      if (writeGate) {
        // A write is being held open (simulating backpressure) — this call
        // shouldn't happen until the held one resolves.
        throw new Error("fakeConn: overlapping write while one is held open");
      }
      return new Promise((resolve) => {
        writeGate = {
          resolve: (n) => {
            this.writes.push(decoder.decode(p));
            resolve(n);
          },
        };
      });
    },
    /** Resolve the currently in-flight `write()`, letting its backlog clear. */
    releaseWrite(): void {
      writeGate?.resolve(0); // length unused by the harness below
      writeGate = null;
    },
    close(): void {
      this.destroyed = true;
      resolveRead(null);
    },
  };
};

const pushFrame: PushFrame = {
  kind: "push",
  seq: 1,
  epoch: "e1",
  type: "event",
  event: { type: "assistant_text", sessionId: "s1", ts: 0, text: "hi" },
};

test("push drops a connection whose write backlog crosses the ceiling", async () => {
  const conn = fakeConn();
  let closedCount = 0;
  const c = new Connection(
    conn as unknown as FramedConn,
    () => {},
    () => {
      closedCount += 1;
    },
  );
  c.subscribed = true;

  // Hold the first write open — nothing has drained it yet, so the backlog
  // this frame contributes never clears.
  const bigFrame: PushFrame = {
    kind: "push",
    seq: 1,
    epoch: "e1",
    type: "event",
    event: {
      type: "assistant_text",
      sessionId: "s1",
      ts: 0,
      text: "x".repeat(9 * 1024 * 1024),
    },
  };
  c.push(bigFrame);
  await flush();
  assert.equal(conn.writes.length, 0, "the write is held open, not yet flushed");

  // The client stopped reading — the held write's bytes count as backlog past
  // the ceiling, so the *next* push drops the connection outright.
  c.push(pushFrame);
  await flush();

  assert.equal(conn.destroyed, true, "the slow connection was dropped");
  assert.equal(closedCount, 1, "onClose fired exactly once");
  assert.equal(conn.writes.length, 0, "neither frame has reached the wire yet");

  // Releasing the stuck write lets it complete — that's fine, it was already
  // in flight — but it's the *only* one that ever does.
  conn.releaseWrite();
  await flush();
  assert.equal(conn.writes.length, 1, "only the first, already-in-flight write completes");

  // Further pushes on the dead connection are silent no-ops.
  c.push(pushFrame);
  await flush();
  assert.equal(conn.writes.length, 1, "the closed connection took no new writes");
});

test("an unsubscribed connection is never written to", async () => {
  const conn = fakeConn();
  const c = new Connection(
    conn as unknown as FramedConn,
    () => {},
    () => {},
  );
  c.push(pushFrame); // subscribed defaults to false
  await flush();
  assert.equal(conn.writes.length, 0);
});

test("frames the dispatcher hands back still reach a healthy socket", async () => {
  const conn = fakeConn();
  const c = new Connection(
    conn as unknown as FramedConn,
    () => {},
    () => {},
  );
  const res: Frame = { kind: "res", id: 1, ok: true, result: null };
  c.respond(res);
  // Writes are queued on the connection's chain, so the `write()` this frame
  // triggers isn't in flight until the chain has been given a turn.
  await flush();
  conn.releaseWrite();
  await flush();
  assert.equal(conn.writes.length, 1);
  assert.match(conn.writes[0]!, /"id":1/);
});

/**
 * A `FramedConn` that accepts at most `chunkBytes` per `write()` — the partial
 * write every `Deno.Writer` is allowed to do, and the one real sockets actually
 * do under pressure. Records the raw byte stream so a test can check frames
 * arrived whole and in order rather than interleaved.
 */
const partialWriteConn = (chunkBytes: number) => {
  let resolveRead: (n: number | null) => void = () => {};
  const readGate = new Promise<number | null>((r) => {
    resolveRead = r;
  });
  const decoder = new TextDecoder();
  return {
    stream: "",
    inFlight: 0,
    destroyed: false,
    read: (_p: Uint8Array): Promise<number | null> => readGate,
    async write(p: Uint8Array): Promise<number> {
      this.inFlight += 1;
      // Yield, so an unchained caller gets the chance to start a second write
      // between this one's halves — which is exactly the corruption we're
      // asserting cannot happen.
      await Promise.resolve();
      if (this.inFlight > 1) throw new Error("overlapping write on one socket");
      const n = Math.min(chunkBytes, p.length);
      this.stream += decoder.decode(p.subarray(0, n));
      this.inFlight -= 1;
      return n;
    },
    close(): void {
      this.destroyed = true;
      resolveRead(null);
    },
  };
};

test("frames written back to back arrive whole and in order despite partial writes", async () => {
  const conn = partialWriteConn(7);
  const c = new Connection(
    conn as unknown as FramedConn,
    () => {},
    () => {},
  );
  c.subscribed = true;

  const frames: PushFrame[] = ["alpha", "bravo", "charlie"].map((text, i) => ({
    kind: "push",
    seq: i + 1,
    epoch: "e1",
    type: "event",
    event: { type: "assistant_text", sessionId: "s1", ts: 0, text },
  }));
  for (const f of frames) c.push(f);
  for (let i = 0; i < 200; i++) await Promise.resolve();

  const lines = conn.stream.split("\n").filter((l) => l !== "");
  assert.equal(lines.length, 3, "every frame arrived exactly once");
  assert.deepEqual(
    lines.map((l) => (JSON.parse(l) as PushFrame & { event: { text: string } }).event.text),
    ["alpha", "bravo", "charlie"],
    "in the order they were pushed, each one parseable on its own line",
  );
});

test("a write that fails drops the connection rather than losing frames silently", async () => {
  const conn = fakeConn();
  let closedCount = 0;
  const c = new Connection(
    conn as unknown as FramedConn,
    () => {},
    () => {
      closedCount += 1;
    },
  );
  c.subscribed = true;
  conn.write = () => Promise.reject(new Error("EPIPE"));

  c.push(pushFrame);
  await flush();

  assert.equal(conn.destroyed, true, "the connection was dropped");
  assert.equal(closedCount, 1, "onClose fired");
});
