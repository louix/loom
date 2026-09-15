import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeTextStream } from "../core/src/text-stream.ts";

test("text decoding preserves UTF-8 split at every byte boundary and flushes incomplete input", async () => {
  const text = "Starting… café 🧵\n";
  const bytes = new TextEncoder().encode(text);
  const chunks = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.enqueue(Uint8Array.of(0xe2, 0x82));
      controller.close();
    },
  });
  assert.equal((await Array.fromAsync(decodeTextStream(chunks))).join(""), text + "\uFFFD");
});

test("text decoding propagates stream failures", async () => {
  const failure = new Error("read failed");
  const chunks = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(failure);
    },
  });
  await assert.rejects(Array.fromAsync(decodeTextStream(chunks)), (error) => error === failure);
});

test("stopping text consumption cancels the source stream", async () => {
  let cancelled = false;
  const chunks = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("ready"));
    },
    cancel() {
      cancelled = true;
    },
  });
  for await (const text of decodeTextStream(chunks)) {
    assert.equal(text, "ready");
    break;
  }
  assert.equal(cancelled, true);
});
