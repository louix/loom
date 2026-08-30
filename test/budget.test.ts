import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import type { SessionSnapshot } from "@loom/core/wire";
import type { FakeProvider, FakeSession } from "@loom/connector-mock";
import { makeHarness, type Harness } from "@loom/harness";

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 1000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start >= ms) throw new Error("condition not met in time");
    await delay(5);
  }
}

async function session(h: Harness): Promise<{ c: LoomClient; id: string; fs: FakeSession }> {
  const c = await LoomClient.connect({ repoRoot: h.repoRoot, sockPath: h.sockPath, autospawn: false });
  const snap = await c.request<SessionSnapshot>("session.create", { prompt: "spend money", provider: "fake" });
  const fake = (await h.daemon.providers.get("fake")) as FakeProvider;
  await waitFor(() => fake.session(snap.id) !== undefined);
  return { c, id: snap.id, fs: fake.session(snap.id) as FakeSession };
}

async function get(c: LoomClient, id: string): Promise<SessionSnapshot> {
  return c.request<SessionSnapshot>("session.get", { id });
}

test("no cap is applied by default — there's no real number to guess", async () => {
  const h = await makeHarness();
  try {
    const { c, id } = await session(h);
    const created = await get(c, id);
    assert.equal(created.budget.maxCostUsd, null);
    assert.equal(created.budgetState, "ok");
    await c.close();
  } finally {
    await h.cleanup();
  }
});

test("a soft breach warns but keeps the session running", async () => {
  const h = await makeHarness({ config: "[budget]\ndefault_max_cost_usd = 5.0\n" }); // on_breach defaults to soft
  try {
    const { c, id, fs } = await session(h);
    const created = await get(c, id);
    assert.equal(created.budget.maxCostUsd, 5); // the configured default was applied
    assert.equal(created.budgetState, "ok");

    fs.finishTurn({ costUsd: 6 });
    await waitFor(async () => (await get(c, id)).budgetState === "warned");
    const s = await get(c, id);
    assert.notEqual(s.status, "interrupted");
    assert.equal(fs.interruptCount, 0);

    // a second breach doesn't re-warn / doesn't escalate on soft
    fs.finishTurn({ costUsd: 6 });
    await delay(40);
    assert.equal((await get(c, id)).budgetState, "warned");
    await c.close();
  } finally {
    await h.cleanup();
  }
});

test("a hard breach halts and interrupts the session; setBudget clears it", async () => {
  const h = await makeHarness({ config: "[budget]\ndefault_max_cost_usd = 2.0\non_breach = \"hard\"\n" });
  try {
    const { c, id, fs } = await session(h);
    assert.equal((await get(c, id)).budget.maxCostUsd, 2);

    fs.finishTurn({ costUsd: 3 });
    await waitFor(async () => (await get(c, id)).budgetState === "halted");
    await waitFor(async () => (await get(c, id)).status === "interrupted");
    assert.equal(fs.interruptCount, 1);
    const hist = await c.request<Array<{ status: string; reason: string | null }>>("session.history", { id });
    assert.equal(hist.at(-1)?.reason, "budget");

    const raised = await c.request<SessionSnapshot>("session.setBudget", { id, maxCostUsd: 100 });
    assert.equal(raised.budgetState, "ok");
    assert.equal(raised.budget.maxCostUsd, 100);
    await c.close();
  } finally {
    await h.cleanup();
  }
});

test("a per-provider default overrides the flat default_max_cost_usd", async () => {
  const h = await makeHarness({
    config: "[budget]\ndefault_max_cost_usd = 5.0\n\n[budget.per_provider]\nfake = 750.0\n",
  });
  try {
    const { c, id } = await session(h);
    assert.equal((await get(c, id)).budget.maxCostUsd, 750);
    await c.close();
  } finally {
    await h.cleanup();
  }
});

test("session.setBudget rejects a call with no fields", async () => {
  const h = await makeHarness();
  try {
    const { c, id } = await session(h);
    await assert.rejects(c.request("session.setBudget", { id }), /at least one of/);
    await c.close();
  } finally {
    await h.cleanup();
  }
});
