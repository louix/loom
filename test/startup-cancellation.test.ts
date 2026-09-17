import assert from "node:assert/strict";
import { test } from "node:test";
import { startupSignal, startWorker } from "../backend/daemon/src/daemon/startup.ts";

test("startup cancellation terminates its worker and awaits cleanup", async () => {
  const controller = new AbortController();
  const stopped = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let cleaned = false;
  const operation = startWorker({ [startupSignal]: controller.signal }, async (own) => {
    own({
      pid: 1,
      input: new WritableStream(),
      output: new ReadableStream(),
      exited: stopped.promise,
      terminate: () => stopped.resolve(),
      cleanup: async () => {
        await stopped.promise;
        cleaned = true;
      },
    });
    entered.resolve();
    await stopped.promise;
    throw new Error("worker ended");
  });
  const rejected = assert.rejects(operation);
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(cleaned, true);
});

test("cancelled startup never launches, and late workers are reaped", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    startWorker({ [startupSignal]: controller.signal }, async () => {
      assert.fail("must not launch");
    }),
    { name: "AbortError" },
  );
  const late = new AbortController();
  let terminated = false;
  let cleaned = false;
  await assert.rejects(
    startWorker({ [startupSignal]: late.signal }, async (own) => {
      late.abort();
      own({
        pid: 1,
        input: new WritableStream(),
        output: new ReadableStream(),
        exited: Promise.resolve(),
        terminate: () => {
          terminated = true;
        },
        cleanup: async () => {
          cleaned = true;
        },
      });
    }),
    { name: "AbortError" },
  );
  assert.equal(terminated, true);
  assert.equal(cleaned, true);
});
