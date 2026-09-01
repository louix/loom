import assert from "node:assert/strict";
import { test } from "node:test";
import type { Socket } from "node:net";
import type { Frame, PushFrame } from "@loom/core/wire";
import { setLogLevel } from "@loom/core/logger";
import { Connection } from "@loom/daemon/daemon/connection";

setLogLevel("error");

/** A `net.Socket` stand-in: records writes, lets a test drive `writableLength`
 *  and fire lifecycle events. */
const fakeSocket = () => {
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  return {
    writableLength: 0,
    writes: [] as string[],
    ended: false,
    destroyed: false,
    setNoDelay() {},
    setEncoding() {},
    on(ev: string, fn: (...a: unknown[]) => void) {
      const list = handlers.get(ev) ?? [];
      list.push(fn);
      handlers.set(ev, list);
      return this;
    },
    write(s: string) {
      this.writes.push(s);
      return true;
    },
    end() {
      this.ended = true;
    },
    destroy() {
      this.destroyed = true;
      for (const fn of handlers.get("close") ?? []) fn();
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

test("push drops a connection whose write backlog crosses the ceiling", () => {
  const sock = fakeSocket();
  let closedCount = 0;
  const conn = new Connection(
    sock as unknown as Socket,
    () => {},
    () => {
      closedCount += 1;
    },
  );
  conn.subscribed = true;

  // Healthy: frames go straight out.
  conn.push(pushFrame);
  conn.push(pushFrame);
  assert.equal(sock.writes.length, 2);

  // The client stopped reading — Node's write buffer piles up past 8 MB.
  sock.writableLength = 9 * 1024 * 1024;
  conn.push(pushFrame);

  assert.equal(sock.destroyed, true, "the slow connection was dropped");
  assert.equal(closedCount, 1, "onClose fired exactly once");
  assert.equal(sock.writes.length, 2, "the frame that tripped the limit was not written");

  // Further pushes on the dead connection are silent no-ops.
  conn.push(pushFrame);
  assert.equal(sock.writes.length, 2);
});

test("an unsubscribed connection is never written to", () => {
  const sock = fakeSocket();
  const conn = new Connection(
    sock as unknown as Socket,
    () => {},
    () => {},
  );
  conn.push(pushFrame); // subscribed defaults to false
  assert.equal(sock.writes.length, 0);
});

test("frames the dispatcher hands back still reach a healthy socket", () => {
  const sock = fakeSocket();
  const conn = new Connection(
    sock as unknown as Socket,
    () => {},
    () => {},
  );
  const res: Frame = { kind: "res", id: 1, ok: true, result: null };
  conn.respond(res);
  assert.equal(sock.writes.length, 1);
  assert.match(sock.writes[0]!, /"id":1/);
});
