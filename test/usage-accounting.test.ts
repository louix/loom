import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "@loom/daemon/store/db";
import { SessionStore } from "@loom/daemon/store/sessions";
import { EndpointPricing } from "../backend/daemon/src/daemon/endpoint-pricing.ts";
import { costOf } from "@loom/daemon/config/pricing";
import { parseModelRows } from "@loom/daemon/daemon/model-catalog";

test("cache observations ignore bookkeeping, preserve session TTL, and record cold gaps", () => {
  const db = openDb(":memory:");
  try {
    const s = new SessionStore(db);
    s.create({ id: "a", provider: "p" });
    s.create({ id: "b", provider: "p" });
    const at = 1_700_000_000_000;
    s.addModelUsage("a", "p", "m", { cacheWrite: 100, lastCacheTtlMinutes: 5, lastTurnAt: at });
    s.addModelUsage("b", "p", "m", { cacheWrite: 100, lastCacheTtlMinutes: 60, lastTurnAt: at });
    assert.equal(s.modelUsage("a")[0]?.ttlMinutes, 5);
    assert.equal(s.modelUsage("b")[0]?.ttlMinutes, 60);
    s.addModelUsage("a", "p", "m", { contextUsed: 100 });
    s.addModelUsage("a", "p", "m", { turns: 1 });
    s.addModelUsage("a", "p", "m", { cacheRead: 100, lastTurnAt: at + 660_000 });
    assert.equal(s.modelUsage("a")[0]?.maxHitGapSec, 660);
    s.addModelUsage("a", "p", "m", { input: 100, lastTurnAt: at + 780_000 });
    assert.equal(s.modelUsage("a")[0]?.minMissGapSec, 120);
    assert.equal(s.modelUsage("a")[0]?.maxHitGapSec, 660);
  } finally {
    db.close();
  }
});

test("account readings persist independently of sessions and expire at reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-account-usage-"));
  let db = openDb(join(dir, "db"));
  try {
    let s = new SessionStore(db);
    s.create({ id: "a", provider: "p" });
    s.recordAccountUsage("account-1", {
      type: "rate_limit",
      sessionId: "a",
      ts: 1000,
      window: "five_hour",
      status: "allowed",
      utilization: 40,
      resetsAt: 5000,
    });
    s.recordAccountUsage("account-1", {
      type: "rate_limit",
      sessionId: "a",
      ts: 999,
      window: "five_hour",
      status: "allowed",
      utilization: 20,
      resetsAt: 5000,
    });
    s.delete("a");
    db.close();
    db = openDb(join(dir, "db"));
    s = new SessionStore(db);
    assert.equal(s.accountUsage("account-1", 2000).five_hour?.utilization, 40);
    assert.deepEqual(s.accountUsage("account-2", 2000), {});
    assert.deepEqual(s.accountUsage("account-1", 5000), {});
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost provenance preserves mixed and incomplete lifetime totals", () => {
  const db = openDb(":memory:");
  try {
    const s = new SessionStore(db);
    s.create({ id: "a", provider: "p" });
    s.addUsage("a", { input: 10, costUsd: 0, costSource: "provider" });
    assert.equal(s.get("a")?.costSource, "provider");
    s.addUsage("a", { input: 10, costUsd: 1, costSource: "table" });
    assert.equal(s.get("a")?.costSource, "mixed");
    s.addUsage("a", { input: 10, costSource: "none" });
    s.addUsage("a", { input: 10, costUsd: 2, costSource: "provider" });
    assert.equal(s.get("a")?.costSource, "partial");
    assert.equal(s.get("a")?.costUsd, 3);
  } finally {
    db.close();
  }
});

test("endpoint pricing is isolated, expiring, and refreshed dynamically", async () => {
  let calls = 0;
  const cache = new EndpointPricing(async (url) => {
    calls++;
    return [
      { id: "m", pricing: { input: url === "a" ? 1 : 10, output: 2, cacheRead: 0, cacheWrite: 0 } },
    ];
  });
  await Promise.all([cache.refresh("a", "a", ""), cache.refresh("b", "b", "")]);
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.equal(costOf(cache.table("a"), "m", tokens), 1);
  assert.equal(costOf(cache.table("b"), "m", tokens), 10);
  await cache.refresh("a", "a", "");
  assert.equal(calls, 2);
  assert.equal(cache.table("a", Date.now() + 3_600_000).size, 0);
  await cache.refresh("a", "a", "", true);
  assert.equal(calls, 3);
});

test("omitted endpoint rates are unknown, explicit zero is a known price", () => {
  const rows = parseModelRows({ data: [{ id: "m", pricing: { prompt: "0", completion: "0" } }] });
  const table = new Map(rows.map((r) => [r.id, r.pricing!]));
  assert.equal(costOf(table, "m", { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }), 0);
  assert.equal(costOf(table, "m", { input: 10, output: 2, cacheRead: 30, cacheWrite: 0 }), null);
  const freeWrite = parseModelRows({
    data: [
      {
        id: "free",
        pricing: {
          prompt: "0.000003",
          completion: "0",
          input_cache_read: "0",
          input_cache_write: "0",
        },
      },
    ],
  });
  assert.equal(
    costOf(
      new Map([["free", freeWrite[0]!.pricing!]]),
      "free",
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 1000 },
      60,
    ),
    0,
  );
});
