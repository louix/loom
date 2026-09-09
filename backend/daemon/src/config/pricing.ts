import type { CacheCreation } from "@loom/core/cache";
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
import type { TokenUsage } from "@loom/core/events";

export interface PriceRow {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** An endpoint omitted these rates; zero placeholders must not imply free usage. */
  missing?: Array<"input" | "output" | "cacheRead" | "cacheWrite">;
}

export type PriceTable = Map<string, PriceRow>;

const num = (v: unknown): number => {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
};

/** Parse a raw TOML tree into a price table. Unknown / malformed rows are skipped. */
export const parsePriceTable = (raw: unknown): PriceTable => {
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
};

/** Load and parse the table; returns an empty table if the file is absent. */
export const loadPriceTable = (path: string): PriceTable => {
  let raw: unknown = {};
  try {
    raw = parseToml(readFileSync(path, "utf8"));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw new Error(`failed to read price table ${path}: ${e.message}`);
  }
  return parsePriceTable(raw);
};

/**
 * Price-table lookup, tolerating id shape: an exact key first, then
 * case-insensitively, then the part after the last `/` (so a hand-written
 * `["glm-5.3-flash"]` row prices a session running `zai-org/GLM-5.3-Flash`).
 */
const lookupRow = (table: PriceTable, model: string): PriceRow | undefined => {
  const exact = table.get(model);
  if (exact) return exact;
  const lower = model.toLowerCase();
  const lowerHit = table.get(lower);
  if (lowerHit) return lowerHit;
  const slash = lower.lastIndexOf("/");
  return slash >= 0 ? table.get(lower.slice(slash + 1)) : undefined;
};

/**
 * What a cache write costs per million when the price table doesn't say.
 *
 * Anthropic bills an ephemeral write as a multiple of base input — 1.25x for
 * the 5-minute TTL, 2x for the hour. A measured TTL is itself the signal that
 * this is an Anthropic-style ephemeral cache: nobody else reports one, and
 * OpenAI-compatible endpoints have no write premium at all, so they keep the
 * 0 the catalogue gives them and are priced correctly by doing nothing.
 *
 * An explicit `cache_write` in the table always wins. A row that sets it to 0
 * cannot opt out of this — 0 and absent are indistinguishable after parsing,
 * and a free ephemeral write does not exist.
 */
export const derivedCacheWrite = (inputPerMillion: number, ttlMinutes = 0): number => {
  if (ttlMinutes <= 0 || inputPerMillion <= 0) return 0;
  return inputPerMillion * (ttlMinutes >= 60 ? 2 : 1.25);
};

/**
 * Dollar cost of a token delta at the given model's prices, or `null` when
 * unpriced. `cacheTtlMinutes` is the TTL the turn's cache writes went into, and
 * only matters when the table prices no cache write of its own.
 */
export const costOf = (
  table: PriceTable,
  model: string | null | undefined,
  delta: TokenUsage,
  cacheTtlMinutes = 0,
  cacheCreation?: CacheCreation,
): number | null => {
  if (!model) return null;
  const row = lookupRow(table, model);
  if (!row) return null;
  if (row.missing?.some((key) => delta[key] > 0 && !(key === "cacheWrite" && cacheTtlMinutes > 0)))
    return null;
  const explicitWrite =
    row.cacheWrite > 0 || (row.missing !== undefined && !row.missing.includes("cacheWrite"));
  if (delta.cacheWrite > 0 && !explicitWrite && row.missing?.includes("input")) return null;
  const cacheWrite = explicitWrite ? row.cacheWrite : derivedCacheWrite(row.input, cacheTtlMinutes);
  const short = num(cacheCreation?.ephemeral_5m_input_tokens);
  const long = num(cacheCreation?.ephemeral_1h_input_tokens);
  // Use the split only when it accounts for the reported writes in full.
  const writeCost =
    !explicitWrite && short + long === delta.cacheWrite && short + long > 0
      ? short * derivedCacheWrite(row.input, 5) + long * derivedCacheWrite(row.input, 60)
      : delta.cacheWrite * cacheWrite;
  return (
    (delta.input * row.input +
      delta.output * row.output +
      delta.cacheRead * row.cacheRead +
      writeCost) /
    1_000_000
  );
};
