import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, test as nodeTest } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type ClientState, LoomClient } from "@loom/client";
import type { DaemonSnapshot, SessionSnapshot } from "@loom/core/wire";
import { makeHarness, type Harness } from "@loom/harness";

const ctx = new AsyncLocalStorage<{ h: Harness }>();

const client = (reconnect = false): Promise<LoomClient> => {
  const { h } = ctx.getStore()!;
  return LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
    reconnect,
  });
};

const withHarness = async (fn: () => Promise<void>): Promise<void> => {
  const h = await makeHarness();
  try {
    await ctx.run({ h }, fn);
  } finally {
    await h.cleanup();
  }
};

const test = (name: string, fn: () => Promise<void>) => nodeTest(name, () => withHarness(fn));

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 2000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start >= ms) throw new Error("condition not met in time");
    await delay(5);
  }
};

/** The fleet as the client's current snapshot sees it, or null while pending. */
const fleet = (c: LoomClient): DaemonSnapshot | null => {
  const s = c.getState();
  return s.tag === "data" ? s.value : null;
};

const sessionIds = (c: LoomClient): string[] => (fleet(c)?.sessions ?? []).map((s) => s.id).sort();

describe("client state subscription", { concurrency: 4 }, () => {
  test("connect installs one complete snapshot; no session.list needed", async () => {
    const c = await client();
    const stub = await c.request<SessionSnapshot>("session.createStub", { prompt: "one" });

    await waitFor(() => sessionIds(c).includes(stub.id));
    const snap = fleet(c);
    assert.ok(snap, "a snapshot is installed");
    assert.equal(snap.daemon.repoRoot, ctx.getStore()!.h.repoRoot);
    assert.ok(snap.providers.length > 0, "providers ride the same snapshot");
    assert.equal(snap.sessions.find((s) => s.id === stub.id)?.title, "one");
    await c.close();
  });

  test("subscribe fires immediately with the current value, then on every change", async () => {
    const c = await client();
    const seen: ClientState[] = [];
    const unsubscribe = c.subscribe((s) => seen.push(s));
    assert.equal(seen.length, 1, "fires synchronously on subscribe");
    assert.equal(seen[0]?.tag, "data");

    const stub = await c.request<SessionSnapshot>("session.createStub", { prompt: "two" });
    await waitFor(() =>
      seen.some((s) => s.tag === "data" && s.value.sessions.some((x) => x.id === stub.id)),
    );

    unsubscribe();
    const countAtUnsubscribe = seen.length;
    await c.request("session.createStub", { prompt: "three" });
    await delay(50);
    assert.equal(seen.length, countAtUnsubscribe, "no deliveries after unsubscribe");
    await c.close();
  });

  test("additions and removals reach two clients through snapshots alone", async () => {
    const a = await client();
    const b = await client();

    const stub = await a.request<SessionSnapshot>("session.createStub", { prompt: "shared" });
    await waitFor(() => sessionIds(a).includes(stub.id) && sessionIds(b).includes(stub.id));

    await a.request("session.remove", { id: stub.id, force: true });
    await waitFor(() => !sessionIds(a).includes(stub.id) && !sessionIds(b).includes(stub.id));

    await a.close();
    await b.close();
  });

  test("a disconnect goes pending; reconnect carries changes made while away", async () => {
    const observer = await client(true);
    const driver = await client();
    // Record every transition — the reconnect can complete inside a poll
    // interval, so `pending` is only reliably observable as a state the client
    // passed *through*.
    const tags: Array<ClientState["tag"]> = [];
    observer.subscribe((s) => tags.push(s.tag));

    const before = await driver.request<SessionSnapshot>("session.createStub", {
      prompt: "before",
    });
    await waitFor(() => sessionIds(observer).includes(before.id));

    observer.dropForTest();

    // Both an addition and a removal land while the observer has no connection.
    const during = await driver.request<SessionSnapshot>("session.createStub", {
      prompt: "during",
    });
    await driver.request("session.remove", { id: before.id, force: true });

    await waitFor(() => {
      const ids = sessionIds(observer);
      return ids.includes(during.id) && !ids.includes(before.id);
    });

    assert.ok(tags.includes("pending"), `expected a pending state; saw ${tags.join(",")}`);
    // The first snapshot after reconnect is the whole current fleet, not a
    // patch applied to the stale one.
    assert.deepEqual(sessionIds(observer), sessionIds(driver));

    await observer.close();
    await driver.close();
  });

  test("no post-reconnect snapshot ever repopulates the pre-drop fleet", async () => {
    const observer = await client(true);
    const driver = await client();

    const before = await driver.request<SessionSnapshot>("session.createStub", {
      prompt: "before",
    });
    await waitFor(() => sessionIds(observer).includes(before.id));

    observer.dropForTest();
    await driver.request("session.remove", { id: before.id, force: true });
    const after = await driver.request<SessionSnapshot>("session.createStub", { prompt: "after" });
    await waitFor(() => sessionIds(observer).includes(after.id));

    // From here on, a frame from the superseded socket — or a stale response
    // settling late — could only show up as the removed session coming back.
    const regressions: string[][] = [];
    observer.subscribe((s) => {
      if (s.tag === "data" && s.value.sessions.some((x) => x.id === before.id)) {
        regressions.push(s.value.sessions.map((x) => x.id));
      }
    });
    await driver.request("session.createStub", { prompt: "settle" });
    await delay(100);

    assert.deepEqual(regressions, [], "the removed session never reappeared");
    assert.deepEqual(sessionIds(observer), sessionIds(driver));

    await observer.close();
    await driver.close();
  });

  test("close returns the state to idle", async () => {
    const c = await client();
    await waitFor(() => c.getState().tag === "data");
    await c.close();
    assert.equal(c.getState().tag, "idle");
  });
});
