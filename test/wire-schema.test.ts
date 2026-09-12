import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeWorkerFrame, decodeWorkerRequest } from "../core/src/worker.ts";
import { isPushFrame, isResponseFrame } from "../core/src/wire-decode.ts";
import { sessionInteractionSchema } from "../core/src/interaction.ts";

test("worker and client accept nullable provider cache counts and reject malformed Loom payloads", () => {
  const event = {
    type: "usage",
    sessionId: "s",
    ts: 1,
    tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    contextUsed: 10,
    contextLimit: 100,
    cacheCreation: { ephemeral_5m_input_tokens: null, ephemeral_1h_input_tokens: 4 },
  };
  assert.deepEqual(decodeWorkerFrame({ kind: "event", seq: 1, event }), {
    kind: "event",
    seq: 1,
    event,
  });
  assert.equal(isPushFrame({ kind: "push", type: "event", seq: 1, epoch: "e", event }), true);
  const broken = { ...event, tokens: { ...event.tokens, output: "wrong" } };
  assert.throws(() => decodeWorkerFrame({ kind: "event", seq: 1, event: broken }));
  assert.equal(
    isPushFrame({ kind: "push", type: "event", seq: 1, epoch: "e", event: broken }),
    false,
  );
  assert.equal(
    sessionInteractionSchema.safeParse({ kind: "question", id: "q", at: 1, question: 3 }).success,
    false,
  );
});

test("transcript schemas preserve opaque vendor metadata and require content", () => {
  const messages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      providerOptions: { vendor: { opaque: [1, null] } },
    },
  ];
  const request = { kind: "request", id: 1, method: "seedTranscript", args: [messages] };
  assert.deepEqual(decodeWorkerRequest(JSON.parse(JSON.stringify(request))), request);
  assert.throws(() => decodeWorkerRequest({ ...request, args: [[{ role: "assistant" }]] }));
  assert.equal(isResponseFrame({ kind: "res", id: 1, ok: true }), false);
  assert.equal(isResponseFrame({ kind: "res", id: 1, ok: true, result: null }), true);
});

test("validation diagnostics never include opaque values", () => {
  assert.throws(
    () =>
      decodeWorkerFrame({
        kind: "response",
        id: 1,
        error: { code: "secret-token", message: "secret-payload" },
      }),
    (e) => {
      assert(e instanceof Error);
      assert.equal(e.message, "invalid worker frame payload");
      return true;
    },
  );
});
