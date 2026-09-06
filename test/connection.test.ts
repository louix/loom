import assert from "node:assert/strict";
import { test } from "node:test";
import type { Frame, PushFrame, StatePush } from "@loom/core/wire";
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
 *  promise open to simulate a client that isn't draining, feeds bytes to the
 *  read loop, and fires its EOF (`read()` resolving `null`) on close. */
const fakeConn = () => {
  // Incoming bytes a test has fed but the read loop hasn't taken yet, and the
  // read that is parked waiting for them. Only one read is ever outstanding.
  let inbox = "";
  let eof = false;
  let waiting: (() => void) | null = null;
  const encoder = new TextEncoder();
  let writeGate: { resolve: (n: number) => void } | null = null;
  const decoder = new TextDecoder();
  return {
    writes: [] as string[],
    destroyed: false,
    /** Deliver `s` to the connection's read loop as if the peer sent it. */
    feed(s: string): void {
      inbox += s;
      waiting?.();
      waiting = null;
    },
    async read(p: Uint8Array): Promise<number | null> {
      for (;;) {
        if (inbox !== "") {
          const bytes = encoder.encode(inbox);
          const n = Math.min(bytes.length, p.length);
          p.set(bytes.subarray(0, n));
          inbox = decoder.decode(bytes.subarray(n));
          return n;
        }
        if (eof) return null;
        await new Promise<void>((r) => {
          waiting = r;
        });
      }
    },
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
      eof = true;
      waiting?.();
      waiting = null;
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

// --- §3: the outgoing backlog ceiling covers every frame kind --------------

/** A legal whole-fleet snapshot ~3 MiB wide, so a handful of them cross the
 *  8 MiB ceiling on their own. The bulk rides a real string field. */
const bigStateFrame = (n: number): StatePush => ({
  kind: "push",
  type: "state",
  state: {
    daemon: { pid: 1, version: "x", startedAt: 0, repoRoot: "/tmp", epoch: "e1" },
    providers: [
      {
        id: `p${n}`,
        models: ["y".repeat(3 * 1024 * 1024)],
        defaultModel: "",
        defaultEffort: "",
        defaultMode: "default",
        tag: "",
        color: "",
        isDefault: true,
      },
    ],
    sessions: [],
  },
});

test("a stalled writer cannot be outrun by snapshots alone", async () => {
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

  // The first snapshot is handed to `write()` and held there — the client has
  // stopped reading. Everything after it queues behind it.
  c.pushState(bigStateFrame(1));
  await flush();
  assert.equal(conn.writes.length, 0, "the first write is held open");

  // Snapshots are the *only* thing enqueued from here. Each supersedes the last
  // as a value, but not as an encoded buffer already sitting in the chain —
  // without a ceiling this grows for as long as the client stays wedged.
  for (let i = 2; i <= 6; i++) c.pushState(bigStateFrame(i));
  await flush();

  assert.equal(conn.destroyed, true, "the wedged connection was dropped");
  assert.equal(closedCount, 1, "onClose fired exactly once");

  conn.releaseWrite();
  await flush();
  assert.equal(conn.writes.length, 1, "only the already-in-flight write completes");

  c.pushState(bigStateFrame(99));
  await flush();
  assert.equal(conn.writes.length, 1, "and the closed connection takes no more");
});

test("the server reader drops a connection on a line it cannot parse", async () => {
  const conn = fakeConn();
  const frames: Frame[] = [];
  let closedCount = 0;
  new Connection(
    conn as unknown as FramedConn,
    (f) => frames.push(f),
    () => {
      closedCount += 1;
    },
  );

  // A good frame, then a line that is not JSON, then another good frame. The
  // middle line is not a frame to skip past: whatever it was, this stream is no
  // longer one we can claim to be reading.
  conn.feed('{"kind":"req","id":1,"method":"ping"}\n');
  conn.feed("{not json\n");
  conn.feed('{"kind":"req","id":2,"method":"ping"}\n');
  await flush();

  assert.deepEqual(
    frames.map((f) => (f as { id?: number }).id),
    [1],
    "only the frame before the corruption was routed",
  );
  assert.equal(conn.destroyed, true, "the connection was dropped");
  assert.equal(closedCount, 1);
});

test("the server reader drops a connection on a frame that isn't a routable request", async () => {
  const conn = fakeConn();
  const frames: Frame[] = [];
  let closedCount = 0;
  new Connection(
    conn as unknown as FramedConn,
    (f) => frames.push(f),
    () => {
      closedCount += 1;
    },
  );

  // Valid JSON and a valid `kind`, but no id to answer on. Ignoring it leaves
  // the peer waiting for a reply that can never be addressed to it.
  conn.feed('{"kind":"req","method":"ping"}\n');
  await flush();

  assert.equal(frames.length, 0);
  assert.equal(conn.destroyed, true, "the connection was dropped");
  assert.equal(closedCount, 1);
});
