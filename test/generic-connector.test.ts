import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { streamText } from "ai";
import { resolveModelFactory } from "@loom/connector-generic";

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
