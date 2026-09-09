import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelRows } from "@loom/daemon/daemon/model-catalog";

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
    pricing: { input: 0.2, output: 0.5, cacheRead: 0.07, cacheWrite: 0, missing: ["cacheWrite"] },
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
    pricing: { input: 1.5, output: 2, cacheRead: 0.15, cacheWrite: 0, missing: ["cacheWrite"] },
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

test("parseModelRows reads reasoning-effort metadata: flat and OpenRouter-nested dialects", () => {
  const rows = parseModelRows({
    data: [
      {
        id: "codex/gpt-5",
        // flat dialect — supported_reasoning_efforts / default_reasoning_effort
        supported_reasoning_efforts: ["minimal", "low", "medium", "high"],
        default_reasoning_effort: "medium",
      },
      {
        id: "anthropic/claude-fable-5.1",
        // OpenRouter nests the same facts under `reasoning`
        reasoning: {
          mandatory: true,
          supported_efforts: ["max", "high", "low"],
          default_effort: "high",
        },
      },
      { id: "no-efforts", default_reasoning_effort: "high" }, // list missing → nothing
      { id: "junk-efforts", supported_reasoning_efforts: ["high", 7] }, // non-strings → dropped
      { id: "empty-efforts", supported_reasoning_efforts: [] },
      {
        id: "default-not-in-list",
        supported_reasoning_efforts: ["low"],
        default_reasoning_effort: "bogus",
      },
    ],
  });
  // ids are sorted, so the anthropic row comes first
  assert.deepEqual(rows[1], {
    id: "codex/gpt-5",
    efforts: ["minimal", "low", "medium", "high"],
    defaultEffort: "medium",
  });
  assert.deepEqual(rows[0], {
    id: "anthropic/claude-fable-5.1",
    efforts: ["max", "high", "low"],
    defaultEffort: "high",
  });
  for (const r of rows.slice(3)) {
    assert.equal(r.efforts, undefined, r.id);
    assert.equal(r.defaultEffort, undefined, r.id);
  }
  // the advertised default passes through even when it's not in the list —
  // the picker just fails to mark it
  assert.deepEqual(rows[2], {
    id: "default-not-in-list",
    efforts: ["low"],
    defaultEffort: "bogus",
  });
});

test("catalog worker is limited to the configured endpoint, including redirects", async () => {
  const { probeOpenAiModels } = await import("../backend/daemon/src/daemon/model-catalog.ts");
  let escaped = 0;
  const target = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () => {
    escaped++;
    return Response.json({ data: [] });
  });
  const origin = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () =>
    Response.redirect(`http://127.0.0.1:${target.addr.port}/models`),
  );
  try {
    await assert.rejects(
      probeOpenAiModels(`http://127.0.0.1:${origin.addr.port}`, "fixture-secret"),
      /Model catalog request failed/,
    );
    assert.equal(escaped, 0);
  } finally {
    await origin.shutdown();
    await target.shutdown();
  }
});
