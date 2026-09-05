import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { streamText } from "ai";
import { AisdkEventMapper } from "@loom/aisdk/map";
import { createChatGPTModels } from "@loom/connector-chatgpt/oauth";
import { mcpConfig } from "@loom/connector-chatgpt/app-server";

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

test("Code Mode serializes Loom MCP mounts and configured Kagi into app-server config", () => {
  assert.equal(
    mcpConfig([
      { name: "tilth", spec: { transport: "stdio", command: "tilth", args: ["--mcp", "--edit"] } },
      { name: "remote", spec: { transport: "http", url: "https://example.invalid/mcp" } },
    ]),
    '{ "tilth" = { command = "tilth", args = ["--mcp", "--edit"] }, "remote" = { url = "https://example.invalid/mcp" } }',
  );
  assert.equal(
    mcpConfig([], { backend: "kagi", apiKey: "secret", apiBase: "", maxResults: 6 }),
    '{ "kagi" = { url = "https://mcp.kagi.com/mcp", bearer_token_env_var = "LOOM_CODEX_KAGI_API_KEY" } }',
  );
});

test("ChatGPT serializes tool history as Responses input items", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-chatgpt-tools-test-"));
  const authPath = join(dir, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({ tokens: { access_token: "test-token", account_id: "test-account" } }),
  );
  const originalFetch = globalThis.fetch;
  let request: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/codex/models"))
      return Response.json({ models: [{ slug: "gpt-5.5", base_instructions: "test" }] });
    if (url.includes("/codex/responses")) {
      const body = init?.body;
      if (typeof body !== "string") throw new Error("expected a JSON request body");
      request = JSON.parse(body) as Record<string, unknown>;
      return new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const { makeModel } = createChatGPTModels({ authPath });
    await makeModel("gpt-5.5").doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "Run pwd" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "shell",
              input: { command: "pwd" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "shell",
              output: { type: "text", value: "/workspace" },
            },
          ],
        },
      ],
    } as never);
    assert.deepEqual(request?.["input"], [
      { role: "user", content: "Run pwd" },
      { type: "function_call", call_id: "call-1", name: "shell", arguments: '{"command":"pwd"}' },
      { type: "function_call_output", call_id: "call-1", output: "/workspace" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
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
