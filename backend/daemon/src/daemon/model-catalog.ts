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
  /** Reasoning-effort levels the endpoint advertises for this model
   *  (`supported_reasoning_efforts`, or OpenRouter's `reasoning.supported_efforts`). */
  efforts?: string[];
  /** The endpoint's default effort, when it names one (`default_reasoning_effort`). */
  defaultEffort?: string;
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

/** Coerce a JSON scalar to a number; any other shape is NaN. */
const toNumber = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  return NaN;
};

const nonEmptyString = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

const positiveNumber = (v: unknown): number | undefined => {
  const n = toNumber(v);
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
    const n = toNumber(v);
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

/**
 * Advertised reasoning-effort metadata, in two dialects: flat
 * `supported_reasoning_efforts` / `default_reasoning_effort` (OpenAI-codex-style
 * `/models` rows) or nested `reasoning.supported_efforts` /
 * `reasoning.default_effort` (OpenRouter). A list is required — a lone default
 * without an enumeration tells the picker nothing it can trust. Levels pass
 * through verbatim (they may name values outside Loom's `EffortLevel` union).
 */
const advertisedEfforts = (
  row: Record<string, unknown>,
): { efforts: string[]; defaultEffort?: string } | undefined => {
  const levels = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x !== "")
      ? (v as string[])
      : undefined;
  const nested =
    row["reasoning"] && typeof row["reasoning"] === "object"
      ? (row["reasoning"] as Record<string, unknown>)
      : undefined;
  const efforts =
    levels(row["supported_reasoning_efforts"]) ?? levels(nested?.["supported_efforts"]);
  if (!efforts) return undefined;
  const dflt =
    nonEmptyString(row["default_reasoning_effort"]) ?? nonEmptyString(nested?.["default_effort"]);
  return { efforts, ...(dflt !== undefined ? { defaultEffort: dflt } : {}) };
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
      const label = nonEmptyString(m["display_name"]) ?? nonEmptyString(m["name"]);
      const efforts = advertisedEfforts(m);
      return {
        id: m.id,
        ...(context !== undefined ? { context } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(pricing !== undefined ? { pricing } : {}),
        ...(efforts
          ? {
              efforts: efforts.efforts,
              ...(efforts.defaultEffort !== undefined
                ? { defaultEffort: efforts.defaultEffort }
                : {}),
            }
          : {}),
      };
    })
    .sort((a, b) => {
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
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
