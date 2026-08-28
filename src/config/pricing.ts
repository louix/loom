/**
 * Per-model price table (M7b). Loaded from `[pricing] table` (default
 * `.loom/models.toml`); a missing file is not an error — the daemon just falls
 * back to whatever cost the provider reports. Prices are USD per million tokens.
 *
 * ```toml
 * ["claude-sonnet-5"]
 * input       = 3.00
 * output      = 15.00
 * cache_read  = 0.30
 * cache_write = 3.75
 * ```
 */
import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import type { TokenUsage } from "../protocol/events.ts";

export interface PriceRow {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type PriceTable = Map<string, PriceRow>;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Parse a raw TOML tree into a price table. Unknown / malformed rows are skipped. */
export function parsePriceTable(raw: unknown): PriceTable {
  const table: PriceTable = new Map();
  if (!raw || typeof raw !== "object") return table;
  for (const [model, row] of Object.entries(raw as Record<string, unknown>)) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const priced: PriceRow = {
      input: num(r["input"]),
      output: num(r["output"]),
      cacheRead: num(r["cache_read"]),
      cacheWrite: num(r["cache_write"]),
    };
    if (priced.input || priced.output || priced.cacheRead || priced.cacheWrite) {
      table.set(model, priced);
    }
  }
  return table;
}

/** Load and parse the table; returns an empty table if the file is absent. */
export function loadPriceTable(path: string): PriceTable {
  let raw: unknown = {};
  try {
    raw = parseToml(readFileSync(path, "utf8"));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw new Error(`failed to read price table ${path}: ${e.message}`);
  }
  return parsePriceTable(raw);
}

/** Dollar cost of a token delta at the given model's prices, or `null` when unpriced. */
export function costOf(table: PriceTable, model: string | null | undefined, delta: TokenUsage): number | null {
  if (!model) return null;
  const row = table.get(model);
  if (!row) return null;
  return (
    (delta.input * row.input +
      delta.output * row.output +
      delta.cacheRead * row.cacheRead +
      delta.cacheWrite * row.cacheWrite) /
    1_000_000
  );
}
