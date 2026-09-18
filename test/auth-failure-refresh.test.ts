import assert from "node:assert/strict";
import { FakeSession } from "../connectors/mock/src/fake.ts";
import { refreshOnAuthFailure } from "../backend/daemon/src/daemon/auth-failure-refresh.ts";

Deno.test("early 401 refreshes once without blocking error delivery or replaying the turn", async () => {
  const base = new FakeSession("auth", { mode: "default" });
  let refreshes = 0;
  let sends = 0;
  base.send = async () => {
    sends++;
  };
  const pending = Promise.withResolvers<void>();
  const session = refreshOnAuthFailure(base, () => {
    refreshes++;
    return pending.promise;
  });
  const events = session.events()[Symbol.asyncIterator]();
  try {
    base.emit({ type: "error", message: "401 authentication_error", fatal: false });
    assert.equal((await events.next()).value?.type, "error");
    assert.equal(refreshes, 1);
    base.emit({ type: "error", message: "401 authentication_error", fatal: false });
    assert.equal((await events.next()).value?.type, "error");
    assert.equal(refreshes, 1);
    assert.equal(sends, 0);
  } finally {
    pending.resolve();
    await session.close();
    await events.return?.();
  }
});

Deno.test("ordinary provider errors do not refresh credentials", async () => {
  const base = new FakeSession("auth", { mode: "default" });
  let refreshes = 0;
  const session = refreshOnAuthFailure(base, async () => {
    refreshes++;
  });
  const events = session.events()[Symbol.asyncIterator]();
  try {
    base.emit({ type: "error", message: "rate limited: 429", fatal: false });
    assert.equal((await events.next()).value?.type, "error");
    assert.equal(refreshes, 0);
  } finally {
    await session.close();
    await events.return?.();
  }
});

Deno.test("Claude SDK authentication_failed refreshes even when the 401 is assistant text", async () => {
  const base = new FakeSession("auth", { mode: "default" });
  let refreshes = 0;
  let sends = 0;
  base.send = async () => {
    sends++;
  };
  const session = refreshOnAuthFailure(base, async () => {
    refreshes++;
  });
  const events = session.events()[Symbol.asyncIterator]();
  try {
    base.emit({ type: "error", message: "assistant: authentication_failed", fatal: false });
    assert.equal((await events.next()).value?.type, "error");
    assert.equal(refreshes, 1);
    base.emit({
      type: "assistant_text",
      text: "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
    });
    assert.equal((await events.next()).value?.type, "assistant_text");
    base.emit({ type: "error", message: "result: success", fatal: false });
    assert.equal((await events.next()).value?.type, "error");
    base.emit({ type: "error", message: "assistant: authentication_failed", fatal: false });
    assert.equal((await events.next()).value?.type, "error");
    assert.equal(refreshes, 1);
    assert.equal(sends, 0);
  } finally {
    await session.close();
    await events.return?.();
  }
});
