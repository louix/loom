import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { streamText } from "ai";
import { AisdkEventMapper } from "@loom/aisdk/map";
import { createChatGPTModels } from "@loom/connector-chatgpt/oauth";

test("ChatGPT OAuth connector constructs a v5 model without reading credentials eagerly", () => {
  // Constructing the provider must not touch ~/.codex/auth.json: a user should
  // be able to configure Loom before running `codex login`, then get the
  // provider's actionable auth error only when starting a session.
  const { makeModel } = createChatGPTModels({ authPath: "/definitely/not/a/credential.json" });
  const model = makeModel("gpt-5.6-terra");
  assert.equal(model.specificationVersion, "v2");
  assert.equal(model.provider, "chatgpt");
  assert.equal(model.modelId, "gpt-5.6-terra");
});

test("ChatGPT cached-input usage feeds Loom's provider/model cache observation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-chatgpt-test-"));
  const authPath = join(dir, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({ tokens: { access_token: "test-token", account_id: "test-account" } }),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/codex/models"))
      return Response.json({ models: [{ slug: "gpt-5.5", base_instructions: "test" }] });
    if (url.includes("/codex/responses")) {
      const event = {
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens: 20,
          },
        },
      };
      return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, {
        headers: {
          "x-codex-primary-used-percent": "42",
          "x-codex-primary-window-minutes": "60",
          "x-codex-primary-reset-at": "1700000000",
          "x-codex-secondary-used-percent": "84",
          "x-codex-secondary-reset-at": "1700003600",
        },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const { makeModel } = createChatGPTModels({ authPath });
    const result = streamText({
      model: makeModel("gpt-5.5"),
      prompt: "hello",
    });
    const mapper = new AisdkEventMapper("session", "gpt-5.5");
    const events = [];
    for await (const part of result.fullStream) {
      events.push(...mapper.map(part));
    }
    const usage = events.find((event) => event.type === "usage");
    assert.ok(usage && usage.type === "usage");
    assert.deepEqual(usage.tokens, { input: 60, output: 20, cacheRead: 40, cacheWrite: 0 });
    assert.equal(usage.contextUsed, 100);
    assert.deepEqual(
      events.filter((event) => event.type === "rate_limit"),
      [
        {
          type: "rate_limit",
          sessionId: "session",
          ts: events[0]?.ts,
          window: "codex-primary",
          status: "allowed",
          utilization: 42,
          resetsAt: 1_700_000_000_000,
        },
        {
          type: "rate_limit",
          sessionId: "session",
          ts: events[0]?.ts,
          window: "codex-secondary",
          status: "allowed_warning",
          utilization: 84,
          resetsAt: 1_700_003_600_000,
        },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});
