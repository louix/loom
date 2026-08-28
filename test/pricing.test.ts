import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { costOf, loadPriceTable, parsePriceTable } from "../src/config/pricing.ts";

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
  const t = parsePriceTable({ "m": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } });
  const cost = costOf(t, "m", { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 0 });
  // 3.00 + 1.50 + 0.60 = 5.10
  assert.ok(Math.abs((cost ?? 0) - 5.1) < 1e-9);
});

test("costOf returns null for an unpriced or unknown model", () => {
  const t = parsePriceTable({ "m": { input: 1, output: 1 } });
  assert.equal(costOf(t, "other", { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(costOf(t, null, { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }), null);
});
