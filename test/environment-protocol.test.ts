import assert from "node:assert/strict";
import {
  readEnvironmentOutput,
  serveEnvironment,
} from "../runtime/src/session-vm/environment-protocol.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(bytes(chunk));
      controller.close();
    },
  });

Deno.test("environment readiness follows initialization and survives fragmented transport", async () => {
  const initialized = Promise.withResolvers<void>();
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const output = new TransformStream<Uint8Array, Uint8Array>();
  let ready = false;
  let ended = false;
  const consumer = readEnvironmentOutput(
    output.readable.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          for (const byte of chunk) controller.enqueue(new Uint8Array([byte]));
        },
      }),
    ),
    () => {
      ready = true;
    },
  );
  const guest = serveEnvironment(() => initialized.promise, input.readable, output.writable);
  void guest.then(() => {
    ended = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ready, false);
  initialized.resolve();
  // A marker write must complete before serveEnvironment reads stdin.
  const writer = input.writable.getWriter();
  await writer.close();
  await guest;
  assert.equal(ended, true);
  assert.equal(output.writable.locked, false);
  await output.writable.close();
  await consumer;
  assert.equal(ready, true);
});

Deno.test("initialization failure never announces a usable environment", async () => {
  const output: Uint8Array[] = [];
  await assert.rejects(
    serveEnvironment(
      async () => {
        throw new Error("activation failed");
      },
      stream(),
      new WritableStream({
        write: (chunk) => {
          output.push(chunk);
        },
      }),
    ),
    /activation failed/,
  );
  assert.equal(output.length, 0);
});

Deno.test("environment readiness rejects EOF, worker frames, extra bytes and unknown versions", async () => {
  for (const text of [
    "",
    '{"loomEnvironmentReady":',
    '{"loomEnvironmentReady":2}\n',
    '{"type":"ready"}\n',
    "private vendor output\n",
  ]) {
    let called = false;
    await assert.rejects(
      readEnvironmentOutput(stream(text), () => {
        called = true;
      }),
    );
    assert.equal(called, false);
  }
  await assert.rejects(
    readEnvironmentOutput(stream('{"loomEnvironmentReady":1}\n', "unexpected"), () => {}),
    /Invalid environment readiness output/,
  );
});

Deno.test("readiness publication is awaited and errors stop the channel", async () => {
  const error = new Error("recovery write failed");
  await assert.rejects(
    readEnvironmentOutput(stream('{"loomEnvironmentReady":1}\n'), () => Promise.reject(error)),
    (value) => value === error,
  );
});

Deno.test("standalone environment input cannot start a conversation or command", async () => {
  await assert.rejects(
    serveEnvironment(
      async () => {},
      stream('{"method":"create"}\n'),
      new WritableStream({ write() {} }),
    ),
    /does not accept commands/,
  );
});
