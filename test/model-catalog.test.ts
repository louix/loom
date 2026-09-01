import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeAdvertisedPricing, parseModelRows } from "@loom/daemon/daemon/model-catalog";
import type { PriceRow } from "@loom/daemon/config/pricing";

test("parseModelRows reads sference-style rows: context_tokens, per-million pricing, display_name", () => {
  const rows = parseModelRows({
    data: [
      {
        id: "zai-org/GLM-5.3-Flash",
        display_name: "GLM 5.3 Flash",
        context_tokens: 1_048_576,
        pricing: {
          input_per_million_usd: 0.2,
          output_per_million_usd: 0.5,
          cached_input_per_million_usd: 0.07,
        },
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: "zai-org/GLM-5.3-Flash",
    context: 1_048_576,
    label: "GLM 5.3 Flash",
    pricing: { input: 0.2, output: 0.5, cacheRead: 0.07, cacheWrite: 0 },
  });
});

test("parseModelRows reads OpenRouter-style rows: context_length, per-token string pricing", () => {
  const rows = parseModelRows({
    data: [
      {
        id: "deepseek/deepseek-chat",
        name: "DeepSeek Chat",
        context_length: 128_000,
        pricing: { prompt: "0.0000015", completion: "0.000002", input_cache_read: "0.00000015" },
      },
    ],
  });
  assert.deepEqual(rows[0], {
    id: "deepseek/deepseek-chat",
    context: 128_000,
    label: "DeepSeek Chat",
    pricing: { input: 1.5, output: 2, cacheRead: 0.15, cacheWrite: 0 },
  });
});

test("parseModelRows: vLLM / LiteLLM context fields, bare ids, junk tolerated", () => {
  const rows = parseModelRows({
    data: [
      { id: "b", max_model_len: 32_768 },
      { id: "c", max_input_tokens: 200_000 },
      { id: "a" }, // bare — the only thing every endpoint agrees on
      { id: "d", context_tokens: -5 }, // junk context → dropped, id kept
      { id: "e", pricing: { prompt: "garbage" } }, // junk pricing → no pricing
      { not_an_id: true }, // no id → skipped
    ],
  });
  assert.deepEqual(
    rows.map((r) => [r.id, r.context]),
    [
      ["a", undefined],
      ["b", 32_768],
      ["c", 200_000],
      ["d", undefined],
      ["e", undefined],
    ],
  );
  assert.equal(rows[4]?.pricing, undefined);
  // numeric-string contexts and string-less bodies don't crash
  assert.equal(parseModelRows({ data: [{ id: "f", context_tokens: "8192" }] })[0]?.context, 8_192);
  assert.deepEqual(parseModelRows(null), []);
  assert.deepEqual(parseModelRows({}), []);
});

test("mergeAdvertisedPricing fills gaps in the table; the TOML row wins", () => {
  const tomlRow: PriceRow = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const table = new Map<string, PriceRow>([["claude-sonnet-5", tomlRow]]);
  mergeAdvertisedPricing(table, [
    {
      modelPricing: {
        "zai-org/GLM-5.3-Flash": { input: 0.2, output: 0.5, cacheRead: 0.07, cacheWrite: 0 },
        // same key as a TOML row → must NOT overwrite
        "claude-sonnet-5": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    },
  ]);
  assert.deepEqual(table.get("zai-org/GLM-5.3-Flash"), {
    input: 0.2,
    output: 0.5,
    cacheRead: 0.07,
    cacheWrite: 0,
  });
  assert.equal(table.get("claude-sonnet-5"), tomlRow);
});
