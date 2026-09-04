import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  costOf,
  derivedCacheWrite,
  loadPriceTable,
  parsePriceTable,
} from "@loom/daemon/config/pricing";

const TABLE = `
["claude-sonnet-5"]
input       = 3.00
output      = 15.00
cache_read  = 0.30
cache_write = 3.75

["fake-1"]
input  = 1.0
output = 2.0
`;

test("parsePriceTable reads per-model rows and skips empty ones", () => {
  const t = parsePriceTable({
    "m-a": { input: 1, output: 2, cache_read: 0.1, cache_write: 0.5 },
    "m-b": { input: 0, output: 0 },
    "m-c": "nonsense",
  });
  assert.deepEqual(t.get("m-a"), { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 });
  assert.ok(!t.has("m-b"));
  assert.ok(!t.has("m-c"));
});

test("loadPriceTable: missing file is not an error", () => {
  assert.equal(loadPriceTable(join(tmpdir(), "does-not-exist-xyz.toml")).size, 0);
});

test("loadPriceTable parses a real file", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-price-"));
  try {
    const p = join(dir, "models.toml");
    writeFileSync(p, TABLE);
    const t = loadPriceTable(p);
    assert.equal(t.get("claude-sonnet-5")?.output, 15);
    assert.equal(t.get("fake-1")?.input, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("costOf multiplies token deltas by the per-million price", () => {
  const t = parsePriceTable({ m: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } });
  const cost = costOf(t, "m", {
    input: 1_000_000,
    output: 100_000,
    cacheRead: 2_000_000,
    cacheWrite: 0,
  });
  // 3.00 + 1.50 + 0.60 = 5.10
  assert.ok(Math.abs((cost ?? 0) - 5.1) < 1e-9);
});

test("costOf returns null for an unpriced or unknown model", () => {
  const t = parsePriceTable({ m: { input: 1, output: 1 } });
  assert.equal(costOf(t, "other", { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(costOf(t, null, { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }), null);
});

test("costOf matches past a vendor prefix and case, so hand-written rows price endpoint ids", () => {
  const t = parsePriceTable({ "glm-5.3-flash": { input: 0.2, output: 0.5, cache_read: 0.07 } });
  const delta = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  // the session's model id, exactly as sference lists it
  assert.ok(Math.abs((costOf(t, "zai-org/GLM-5.3-Flash", delta) ?? 0) - 0.2) < 1e-9);
  // lowercase / prefixed variants hit the same row
  assert.equal(costOf(t, "zai-org/glm-5.3-flash", delta), costOf(t, "GLM-5.3-Flash", delta));
  // a different family stays unpriced
  assert.equal(costOf(t, "zai-org/GLM-5.2", delta), null);
});

test("an unpriced cache write is charged at the ephemeral multiple of input", () => {
  // Anthropic bills a write as 1.25x base input at 5m and 2x at 1h. Endpoint
  // catalogues advertise no write price at all, so before this a session's
  // cache writes — the bulk of a caching agent's prompt spend — cost nothing.
  const t = parsePriceTable({ m: { input: 3, output: 15, cache_read: 0.3 } });
  const write = (ttl: number) =>
    costOf(t, "m", { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }, ttl);

  assert.ok(Math.abs((write(5) ?? 0) - 3.75) < 1e-9); // 1.25 x 3.00
  assert.ok(Math.abs((write(60) ?? 0) - 6.0) < 1e-9); // 2.00 x 3.00
  // No measured TTL ⇒ no ephemeral cache ⇒ no premium. OpenAI-compatible
  // endpoints report no TTL and genuinely have no write premium, so they stay
  // priced at zero rather than being charged an Anthropic rate by accident.
  assert.equal(write(0), 0);
});

test("an explicit cache_write in the table always wins over the derived rate", () => {
  const t = parsePriceTable({ m: { input: 3, output: 15, cache_write: 1.0 } });
  const cost = costOf(t, "m", { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }, 60);
  // 1.00 as configured, not the 6.00 a 1h write would otherwise derive.
  assert.ok(Math.abs((cost ?? 0) - 1.0) < 1e-9);
});

test("derivedCacheWrite is inert without both an input price and a TTL", () => {
  assert.equal(derivedCacheWrite(3, 0), 0);
  assert.equal(derivedCacheWrite(0, 60), 0);
  assert.equal(derivedCacheWrite(3, 5), 3.75);
  assert.equal(derivedCacheWrite(3, 60), 6);
  // Anything between the two buckets prices as the short one; only the hour
  // carries the 2x premium.
  assert.equal(derivedCacheWrite(3, 59), 3.75);
});
