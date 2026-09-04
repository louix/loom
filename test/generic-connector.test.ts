import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { streamText } from "ai";
import { resolveModelFactory } from "@loom/connector-generic";
import { AisdkEventMapper } from "@loom/aisdk/map";
import type { HarnessEvent } from "@loom/core/events";

/**
 * The context meter and cost rollup die silently when an endpoint streams no
 * token usage — sference (and several others) only include `usage` when the
 * request carries `stream_options: { include_usage: true }`. The generic
 * connector must ask for it by default, and omit it when a provider opts out
 * (`include_usage = false`) because some strict endpoints reject the field.
 */

/** One-shot OpenAI-compatible SSE stub; resolves with the captured request body. */
const serve = (): Promise<{
  base: string;
  body: () => string;
  close: () => Promise<void>;
}> => {
  return new Promise((resolve) => {
    let lastBody = "";
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        lastBody = raw;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
        res.write(
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }],
          }),
        );
        res.write(
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        );
        // usage only arrives because the client asked for it (include_usage)
        res.write(
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }),
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}/v1`,
        body: () => lastBody,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
};

test("streamed requests ask for usage: stream_options.include_usage by default", async () => {
  const srv = await serve();
  try {
    const make = await resolveModelFactory("openai", { id: "t", baseUrl: srv.base, apiKey: "" });
    const res = streamText({ model: make("m"), prompt: "hi" });
    await res.consumeStream();
    const body = JSON.parse(srv.body()) as { stream_options?: { include_usage?: boolean } };
    assert.equal(body.stream_options?.include_usage, true);
  } finally {
    await srv.close();
  }
});

test("include_usage = false leaves stream_options out (strict endpoints)", async () => {
  const srv = await serve();
  try {
    const make = await resolveModelFactory("openai", {
      id: "t",
      baseUrl: srv.base,
      apiKey: "",
      includeUsage: false,
    });
    const res = streamText({ model: make("m"), prompt: "hi" });
    await res.consumeStream();
    const body = JSON.parse(srv.body()) as { stream_options?: unknown };
    assert.equal("stream_options" in body, false);
  } finally {
    await srv.close();
  }
});

test("reasoningEffort provider options under the connector id reach the body as reasoning_effort", async () => {
  const srv = await serve();
  try {
    // the connector builds the SDK client with `name: <provider id>` — the key
    // sessions must put their reasoning effort under for openai-compatible
    const make = await resolveModelFactory("openai", { id: "mygw", baseUrl: srv.base, apiKey: "" });
    const res = streamText({
      model: make("m"),
      prompt: "hi",
      providerOptions: { mygw: { reasoningEffort: "high" } },
    });
    await res.consumeStream();
    const body = JSON.parse(srv.body()) as { reasoning_effort?: string };
    assert.equal(body.reasoning_effort, "high");
  } finally {
    await srv.close();
  }
});

test("usage from the final chunk reaches the AI SDK when requested", async () => {
  const srv = await serve();
  try {
    const make = await resolveModelFactory("openai", { id: "t", baseUrl: srv.base, apiKey: "" });
    const res = streamText({ model: make("m"), prompt: "hi" });
    await res.consumeStream();
    const usage = await res.usage;
    assert.equal(usage?.inputTokens, 3);
    assert.equal(usage?.outputTokens, 1);
  } finally {
    await srv.close();
  }
});

/**
 * One-shot Anthropic-shaped SSE stub. The native path is the one that has to
 * ask for a cache breakpoint, and the only proof it works is the request body
 * `@ai-sdk/anthropic` actually puts on the wire.
 */
const serveAnthropic = (): Promise<{
  base: string;
  body: () => string;
  close: () => Promise<void>;
}> => {
  return new Promise((resolve) => {
    let lastBody = "";
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        lastBody = raw;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const ev = (type: string, obj: unknown) =>
          `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
        res.write(
          ev("message_start", {
            type: "message_start",
            message: {
              id: "m1",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-5",
              content: [],
              stop_reason: null,
              usage: {
                input_tokens: 30,
                output_tokens: 0,
                cache_read_input_tokens: 9000,
                cache_creation_input_tokens: 1200,
                cache_creation: {
                  ephemeral_5m_input_tokens: 0,
                  ephemeral_1h_input_tokens: 1200,
                },
              },
            },
          }),
        );
        res.write(
          ev("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
        );
        res.write(
          ev("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          }),
        );
        res.write(ev("content_block_stop", { type: "content_block_stop", index: 0 }));
        res.write(
          ev("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          }),
        );
        res.write(ev("message_stop", { type: "message_stop" }));
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}/v1`,
        body: () => lastBody,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
};

test("anthropic cacheControl provider options reach the body as cache_control", async () => {
  const srv = await serveAnthropic();
  try {
    const make = await resolveModelFactory("anthropic", {
      id: "anthropic",
      baseUrl: srv.base,
      apiKey: "k",
    });
    const res = streamText({
      model: make("claude-sonnet-5"),
      prompt: "hi",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
    });
    await res.consumeStream();
    const body = JSON.parse(srv.body()) as { cache_control?: { type: string; ttl?: string } };
    assert.deepEqual(body.cache_control, { type: "ephemeral", ttl: "1h" });
  } finally {
    await srv.close();
  }
});

test("anthropic reports cache writes and the TTL bucket back through the mapper", async () => {
  const srv = await serveAnthropic();
  try {
    const make = await resolveModelFactory("anthropic", {
      id: "anthropic",
      baseUrl: srv.base,
      apiKey: "k",
    });
    const m = new AisdkEventMapper("s1", "claude-sonnet-5", () => 200_000);
    const res = streamText({ model: make("claude-sonnet-5"), prompt: "hi" });
    const usage: HarnessEvent[] = [];
    for await (const part of res.fullStream) {
      for (const e of m.map(part)) if (e.type === "usage") usage.push(e);
    }
    const last = usage.at(-1) as
      | {
          tokens: { input: number; cacheRead: number; cacheWrite: number };
          cacheTtlMinutes?: number;
        }
      | undefined;
    assert.equal(last?.tokens.cacheRead, 9000);
    assert.equal(last?.tokens.cacheWrite, 1200);
    // input_tokens is already the uncached remainder — not re-subtracted.
    assert.equal(last?.tokens.input, 30);
    assert.equal(last?.cacheTtlMinutes, 60);
  } finally {
    await srv.close();
  }
});
