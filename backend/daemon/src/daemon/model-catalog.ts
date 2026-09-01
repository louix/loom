/**
 * Parsing for OpenAI-compatible `/models` rows. Endpoints agree on
 * `data[].id` and little else — OpenRouter uses `context_length` plus
 * per-token `pricing` strings, vLLM / LiteLLM / LM Studio have their own
 * context field, sference uses `context_tokens` and per-million pricing.
 * Everything here is best-effort: a row that only partially parses still
 * yields its id.
 */
import type { PriceRow } from "../config/pricing.ts";

export interface ProbedModel {
  id: string;
  /** Context window in tokens, when the endpoint advertises one. */
  context?: number;
  /** Display name, when the endpoint gives one (`display_name` / `name`). */
  label?: string;
  /** Advertised USD-per-million prices, when the endpoint lists them. */
  pricing?: PriceRow;
}

/** Context-window field names seen in the wild, in preference order.
 *  `max_tokens` is deliberately absent — on LiteLLM that's the output cap. */
const CONTEXT_FIELDS = [
  "context_length",
  "context_tokens",
  "max_model_len",
  "max_input_tokens",
  "max_context_length",
] as const;

const positiveNumber = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
};

/** First advertised context field on a row, or undefined. */
const advertisedContext = (row: Record<string, unknown>): number | undefined => {
  for (const field of CONTEXT_FIELDS) {
    const n = positiveNumber(row[field]);
    if (n !== undefined) return n;
  }
  return undefined;
};

/**
 * Advertised pricing, in two dialects: per-million USD numbers
 * (`input_per_million_usd` — sference) or per-token strings/numbers
 * (`prompt` / `completion` — OpenRouter, ×1M to normalize). Returns
 * undefined when nothing usable is present.
 */
const advertisedPricing = (row: Record<string, unknown>): PriceRow | undefined => {
  const p = row["pricing"];
  if (!p || typeof p !== "object") return undefined;
  const r = p as Record<string, unknown>;
  const perMillion = (v: unknown): number | undefined => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    // sanity-banded: an advertised price is a smallish non-negative number
    return Number.isFinite(n) && n >= 0 && n < 100_000 ? n : undefined;
  };
  const input = perMillion(r["input_per_million_usd"]);
  const output = perMillion(r["output_per_million_usd"]);
  const cacheRead = perMillion(r["cached_input_per_million_usd"]);
  if (input !== undefined || output !== undefined) {
    return { input: input ?? 0, output: output ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: 0 };
  }
  // OpenRouter-style: USD per token, as strings.
  const perToken = (v: unknown): number | undefined => {
    const n = perMillion(v);
    return n === undefined ? undefined : n * 1_000_000;
  };
  const pInput = perToken(r["prompt"]);
  const pOutput = perToken(r["completion"]);
  const pCache = perToken(r["input_cache_read"] ?? r["cache"]);
  if (pInput !== undefined || pOutput !== undefined) {
    return { input: pInput ?? 0, output: pOutput ?? 0, cacheRead: pCache ?? 0, cacheWrite: 0 };
  }
  return undefined;
};

/** Parse a `/models` response body into probed rows (ids sorted). */
export const parseModelRows = (body: unknown): ProbedModel[] => {
  const data =
    body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data as Array<Record<string, unknown>>)
      : [];
  return data
    .filter((m): m is Record<string, unknown> & { id: string } => typeof m?.id === "string")
    .map((m) => {
      const context = advertisedContext(m);
      const pricing = advertisedPricing(m);
      const label =
        typeof m["display_name"] === "string" && m["display_name"] !== ""
          ? m["display_name"]
          : typeof m["name"] === "string" && m["name"] !== ""
            ? m["name"]
            : undefined;
      return {
        id: m.id,
        ...(context !== undefined ? { context } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(pricing !== undefined ? { pricing } : {}),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

/** `GET {base_url}/models` → parsed rows. Throws on a non-OK / dead endpoint. */
export const probeOpenAiModels = async (
  baseUrl: string,
  apiKey: string,
): Promise<ProbedModel[]> => {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(8_000), // a black-hole base_url must not hang the RPC
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return parseModelRows(await res.json());
};

/**
 * Feed advertised pricing into the daemon's cost table for models the user's
 * `models.toml` doesn't price — the file always wins. Mutates `table`.
 */
export const mergeAdvertisedPricing = (
  table: Map<string, PriceRow>,
  profiles: Array<{ modelPricing: Record<string, PriceRow> }>,
): void => {
  for (const p of profiles) {
    for (const [model, row] of Object.entries(p.modelPricing)) {
      if (!table.has(model)) table.set(model, row);
    }
  }
};
