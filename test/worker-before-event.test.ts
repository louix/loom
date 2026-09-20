import assert from "node:assert/strict";
import { FakeProvider } from "../connectors/mock/src/fake.ts";
import { decodeWorkerFrame } from "../core/src/worker.ts";
import type { HarnessEvent } from "../core/src/events.ts";
import { serveWorker } from "../runtime/src/worker/serve.ts";
import { FrameWriter, readFrames } from "../runtime/src/worker/transport.ts";

Deno.test("worker finishes its pre-event work before the daemon sees a turn end", async () => {
  const requests = new TransformStream<Uint8Array, Uint8Array>();
  const frames = new TransformStream<Uint8Array, Uint8Array>();
  const provider = new FakeProvider();
  const order: string[] = [];
  const published = Promise.withResolvers<void>();
  const serving = serveWorker(
    requests.readable,
    frames.writable,
    async () => provider,
    () => {},
    async (event: HarnessEvent) => {
      if (event.type !== "result") return;
      order.push("publish started");
      await published.promise;
      order.push("publish finished");
    },
  );
  const send = new FrameWriter(requests.writable);
  // One reader feeds a log, so concurrent waits cannot take each other's frames.
  type Frame = ReturnType<typeof decodeWorkerFrame>;
  const log: Frame[] = [];
  let changed = Promise.withResolvers<void>();
  const reading = (async () => {
    for await (const frame of readFrames(frames.readable, decodeWorkerFrame)) {
      log.push(frame);
      changed.resolve();
      changed = Promise.withResolvers<void>();
    }
  })();
  const until = async (match: (frame: Frame) => boolean) => {
    for (let index = 0; ; index++) {
      while (index >= log.length) await changed.promise;
      if (match(log[index]!)) return log[index]!;
    }
  };
  await until((frame) => frame.kind === "hello");
  await send.send({
    kind: "request",
    id: 1,
    method: "initialize",
    args: [
      {
        generation: "g",
        providerId: "mock",
        sessionId: "s",
        connector: "@loom/connector-mock",
        config: {},
        role: "session",
      },
    ],
  });
  await until((frame) => frame.kind === "ready");
  await send.send({
    kind: "request",
    id: 2,
    method: "create",
    args: [{ sessionId: "s", cwd: "/", prompt: "p", mode: "default", mcpServers: [] }],
  });
  await until((frame) => frame.kind === "response" && frame.id === 2);

  provider.session("s")!.finishTurn();
  const seen = until((frame) => frame.kind === "event" && frame.event.type === "result").then(() =>
    order.push("daemon saw result"),
  );
  // The usage event before it is forwarded at once; the result waits for the publish.
  await until((frame) => frame.kind === "event" && frame.event.type === "usage");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(order, ["publish started"]);
  published.resolve();
  await seen;
  assert.deepEqual(order, ["publish started", "publish finished", "daemon saw result"]);

  await send.send({ kind: "request", id: 3, method: "close", args: [] });
  await serving;
  // The worker leaves its output open for the supervisor to close.
  void reading;
});
