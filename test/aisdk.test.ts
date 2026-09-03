import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { tool, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import type { HarnessEvent, SessionState } from "@loom/core/events";
import type { UsageDelta } from "@loom/daemon/store/sessions";
import { openDb } from "@loom/daemon/store/db";
import { SessionManager } from "@loom/daemon/daemon/session-manager";
import { makeLogger, setLogLevel } from "@loom/core/logger";
import {
  AisdkProvider,
  dropDanglingToolCalls,
  repairMalformedToolInputs,
} from "@loom/aisdk/provider";
import { resolveModelFactory } from "@loom/connector-generic";
import { AisdkEventMapper } from "@loom/aisdk/map";
import { ProviderMessageStore } from "@loom/daemon/store/provider-messages";
import { runTurn } from "@loom/aisdk/loop";
import { contextLimitFor, estimateTokens, knownContextLimit } from "@loom/core/tokens";

setLogLevel("error");

// --- helpers ---------------------------------------------------------------

type Chunk = LanguageModelV2StreamPart;

const model = (chunks: Chunk[], opts: { chunkDelayInMs?: number } = {}): LanguageModel => {
  return new MockLanguageModelV2({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks,
        initialDelayInMs: 0,
        ...(opts.chunkDelayInMs != null ? { chunkDelayInMs: opts.chunkDelayInMs } : {}),
      }),
    }),
  }) as unknown as LanguageModel;
};

const textReply = (
  text: string,
  usage: Partial<{
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
  }> = {},
  opts: { chunkDelayInMs?: number } = {},
): LanguageModel => {
  return model(
    [
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: "r", modelId: "mock", timestamp: new Date(0) },
      { type: "text-start", id: "t" },
      ...text
        .split(" ")
        .map((w, i) => ({ type: "text-delta" as const, id: "t", delta: i === 0 ? w : ` ${w}` })),
      { type: "text-end", id: "t" },
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: usage.inputTokens ?? 10,
          outputTokens: usage.outputTokens ?? 3,
          totalTokens: usage.totalTokens ?? 13,
          ...(usage.cachedInputTokens != null
            ? { cachedInputTokens: usage.cachedInputTokens }
            : {}),
        },
      },
    ],
    opts,
  );
};

const provider = (
  make: (id: string) => LanguageModel,
  store: ProviderMessageStore,
): AisdkProvider => {
  return new AisdkProvider(
    { id: "openai", model: "gpt-5", models: ["gpt-5"], makeModel: make },
    store,
  );
};

const tmpDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-aisdk-"));
  const db = openDb(join(dir, "t.db"));
  db.prepare(
    "INSERT INTO sessions (id, provider, mode, created_at, updated_at) VALUES (?, 'openai', 'default', 0, 0)",
  ).run("s1");
  db.prepare(
    "INSERT INTO sessions (id, provider, mode, created_at, updated_at) VALUES (?, 'openai', 'default', 0, 0)",
  ).run("s2");
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

test("ProviderMessageStore: replaceFrom past the end throws; copyTo refuses a non-empty target", () => {
  const { db, cleanup } = tmpDb();
  try {
    const store = new ProviderMessageStore(db);
    store.append("s1", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
    assert.doesNotThrow(() => store.replaceFrom("s1", 3, [])); // == append nothing, keep all
    assert.doesNotThrow(() => store.replaceFrom("s1", 2, [{ role: "assistant", content: "b2" }]));
    assert.throws(() => store.replaceFrom("s1", 99, []), /past the end/);

    store.append("s2", [{ role: "user", content: "x" }]);
    assert.throws(() => store.copyTo("s1", "s2"), /already has messages/);
    store.clear("s2");
    assert.doesNotThrow(() => store.copyTo("s1", "s2"));
    assert.equal(store.count("s2"), store.count("s1"));
  } finally {
    cleanup();
  }
});

const drain = async (
  events: AsyncIterable<HarnessEvent>,
  until: (ev: HarnessEvent) => boolean,
): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const ev of events) {
    out.push(ev);
    if (until(ev)) break;
  }
  return out;
};

// --- tokens --------------------------------------------------------------

test("contextLimitFor matches on model-id prefix, falls back to 128k", () => {
  assert.equal(contextLimitFor("gpt-5-mini"), 400_000);
  assert.equal(contextLimitFor("deepseek-reasoner"), 128_000);
  assert.equal(contextLimitFor("glm-4.6"), 200_000);
  assert.equal(contextLimitFor("glm-5.3-flash"), 1_048_576);
  assert.equal(contextLimitFor("glm-5.3-flash-0824"), 1_048_576);
  assert.equal(contextLimitFor("zai-org/glm-5.3-flash"), 1_048_576);
  // real-world id shape: vendor prefix + mixed case still resolves
  assert.equal(contextLimitFor("zai-org/GLM-5.3-Flash"), 1_048_576);
  // separator-fuzzy fallback when the strict pass misses
  assert.equal(contextLimitFor("GLM5.3Flash"), 1_048_576);
  assert.equal(contextLimitFor("glm_5.3_flash"), 1_048_576);
  assert.equal(contextLimitFor("something-unknown"), 128_000);
  assert.equal(contextLimitFor(null), 128_000);
  // native anthropic / google aisdk backends
  assert.equal(contextLimitFor("claude-sonnet-5"), 200_000);
  assert.equal(contextLimitFor("anthropic/claude-3-5-haiku"), 200_000);
  assert.equal(contextLimitFor("gemini-2.5-pro"), 1_000_000);
  assert.equal(contextLimitFor("gemini-1.5-pro"), 1_000_000);
});

test("context overrides (endpoint-reported / model_context pins) beat the table", () => {
  assert.equal(contextLimitFor("gpt-5", { "gpt-5": 999_999 }), 999_999);
  // a pin keyed on the bare name covers the vendor-prefixed id…
  assert.equal(contextLimitFor("zai-org/GLM-5.3-Flash", { "glm-5.3-flash": 500_000 }), 500_000);
  // …but never leaks to a sibling model
  assert.equal(contextLimitFor("gpt-5-mini", { "gpt-5": 999_999 }), 400_000);
  // knownContextLimit distinguishes "reported" from the table's guess
  assert.equal(knownContextLimit("gpt-5", undefined), undefined);
  assert.equal(knownContextLimit("totally-unknown", { other: 123 }), undefined);
  assert.equal(knownContextLimit("gpt-5-mini", { "gpt-5": 999_999 }), undefined);
  assert.equal(
    knownContextLimit("zai-org/GLM-5.3-Flash", { "zai-org/GLM-5.3-Flash": 1_048_576 }),
    1_048_576,
  );
});

test("estimateTokens is chars/4 over message content, and shrugs off malformed rows", () => {
  assert.equal(estimateTokens([{ role: "user", content: "12345678" }]), 2);
  assert.equal(estimateTokens([]), 0);
  // a row with no content / a circular structure must not throw
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  assert.equal(
    estimateTokens([{ role: "user" } as never, { role: "user", content: circular } as never]),
    0,
  );
});

// --- mapper ------------------------------------------------------------------

test("mapper buffers text deltas and flushes assistant_text at text-end", () => {
  const m = new AisdkEventMapper("s1", "gpt-5");
  assert.deepEqual(m.map({ type: "text-start", id: "a" } as never), []);
  assert.deepEqual(m.map({ type: "text-delta", id: "a", text: "Hel" } as never), []);
  assert.deepEqual(m.map({ type: "text-delta", id: "a", text: "lo" } as never), []);
  const out = m.map({ type: "text-end", id: "a" } as never);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.type, "assistant_text");
  assert.equal((out[0] as { text: string }).text, "Hello");
});

test("a flush with no *-end parts emits thinking before the answer it produced", () => {
  // Some OpenAI-compatible endpoints (GLM via e.g. Sference) never send
  // text-end / reasoning-end; the blocks flush together at the next tool call.
  // The model reasoned first, so the log must show thinking above the answer.
  const m = new AisdkEventMapper("s1", "gpt-5");
  m.map({ type: "reasoning-delta", id: "r", text: "the user asks about…" } as never);
  m.map({ type: "text-delta", id: "a", text: "Good question — no." } as never);
  const out = m.map({ type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} } as never);
  assert.deepEqual(
    out.map((e) => e.type),
    ["thinking", "assistant_text", "tool_call"],
  );
});

test("mapper turns reasoning into thinking and tool parts into tool_call/tool_result", () => {
  const m = new AisdkEventMapper("s1", "gpt-5");
  m.map({ type: "reasoning-delta", id: "r", text: "hmm" } as never);
  assert.equal(m.map({ type: "reasoning-end", id: "r" } as never)[0]?.type, "thinking");

  const call = m.map({
    type: "tool-call",
    toolCallId: "c1",
    toolName: "echo",
    input: { x: 1 },
  } as never)[0];
  assert.equal(call?.type, "tool_call");
  assert.deepEqual(call, {
    type: "tool_call",
    sessionId: "s1",
    ts: (call as { ts: number }).ts,
    id: "c1",
    name: "echo",
    input: { x: 1 },
  });

  const res = m.map({
    type: "tool-result",
    toolCallId: "c1",
    toolName: "echo",
    input: {},
    output: "ok",
  } as never)[0];
  assert.equal(res?.type, "tool_result");
  assert.equal((res as { ok: boolean }).ok, true);

  const errp = m.map({
    type: "tool-error",
    toolCallId: "c1",
    toolName: "echo",
    input: {},
    error: new Error("boom"),
  } as never)[0];
  assert.equal((errp as { ok: boolean }).ok, false);
  assert.equal((errp as { output: unknown }).output, "boom");
});

test("mapper flushes buffered text / reasoning before a tool_call (no text-end sent)", () => {
  const m = new AisdkEventMapper("s1", "gpt-5");
  m.map({ type: "reasoning-delta", id: "r", text: "let me look" } as never);
  m.map({ type: "text-delta", id: "t", text: "I'll check the repo." } as never);
  // provider jumps straight to the tool call without closing the blocks
  const out = m.map({
    type: "tool-call",
    toolCallId: "c1",
    toolName: "bash",
    input: { command: "ls" },
  } as never);
  assert.deepEqual(
    out.map((e) => e.type),
    ["thinking", "assistant_text", "tool_call"],
  );
  assert.equal((out[1] as { text: string }).text, "I'll check the repo.");
  // a second parallel tool call has nothing left to flush
  assert.deepEqual(
    m
      .map({ type: "tool-call", toolCallId: "c2", toolName: "bash", input: {} } as never)
      .map((e) => e.type),
    ["tool_call"],
  );
});

test("mapper splits cached tokens out of input on finish-step", () => {
  const m = new AisdkEventMapper("s1", "gpt-5");
  const ev = m.map({
    type: "finish-step",
    finishReason: "stop",
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 40 },
    response: {},
    providerMetadata: undefined,
  } as never)[0];
  assert.equal(ev?.type, "usage");
  assert.deepEqual((ev as { tokens: unknown }).tokens, {
    input: 60,
    output: 20,
    cacheRead: 40,
    cacheWrite: 0,
  });
  assert.equal((ev as { contextUsed: number }).contextUsed, 100);
  assert.equal((ev as { contextLimit: number }).contextLimit, 400_000);
});

test("mapper takes a context-limit resolver (endpoint-reported sizes)", () => {
  const m = new AisdkEventMapper("s1", "zai-org/GLM-5.3-Flash", () => 1_048_576);
  const ev = m.map({
    type: "finish-step",
    finishReason: "stop",
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    response: {},
    providerMetadata: undefined,
  } as never)[0];
  assert.equal((ev as { contextLimit: number }).contextLimit, 1_048_576);
});

test("provider modelContext reaches the session's context meter", async () => {
  const { db, cleanup } = tmpDb();
  try {
    const store = new ProviderMessageStore(db);
    const p = new AisdkProvider(
      {
        id: "openai",
        model: "zai-org/GLM-5.3-Flash",
        models: ["zai-org/GLM-5.3-Flash"],
        // keyed on the bare name — the after-slash candidate must still hit
        modelContext: { "glm-5.3-flash": 1_048_576 },
        makeModel: () => textReply("done", { inputTokens: 30, outputTokens: 4, totalTokens: 34 }),
      },
      store,
    );
    const s = await p.createSession({
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "hello",
      mode: "default",
      mcpServers: [],
    });
    assert.equal(s.snapshot().contextLimit, 1_048_576);
    const events = await drain(s.events(), (e) => e.type === "result");
    const usage = events.find((e) => e.type === "usage") as { contextLimit: number };
    assert.equal(usage?.contextLimit, 1_048_576);
    await s.close();
  } finally {
    cleanup();
  }
});

test("mapper surfaces a stream error part as a fatal error event", () => {
  const m = new AisdkEventMapper("s1", "gpt-5");
  const ev = m.map({ type: "error", error: new Error("network down") } as never)[0];
  assert.deepEqual(ev, {
    type: "error",
    sessionId: "s1",
    ts: (ev as { ts: number }).ts,
    message: "network down",
    fatal: true,
  });
});
test("mapper error events carry the provider status + response body, not just statusText", () => {
  const m = new AisdkEventMapper("s1", "glm-5");
  const err = Object.assign(new Error("Bad Request"), {
    statusCode: 400,
    responseBody:
      '{"detail":{"title":"Bad Request","detail":"This request\'s prompt could not be rendered for the selected model."}}',
  });
  const ev = m.map({ type: "error", error: err } as never)[0] as { message: string };
  assert.equal(ev.message.includes("HTTP 400"), true);
  assert.equal(ev.message.includes("prompt could not be rendered"), true);
});

// --- runTurn ---------------------------------------------------------------

test("runTurn streams text + usage and captures the response messages", async () => {
  const events: HarnessEvent[] = [];
  const appended: unknown[] = [];
  const mapper = new AisdkEventMapper("s1", "gpt-5");
  const r = await runTurn({
    sessionId: "s1",
    model: textReply("hello there", { inputTokens: 8, outputTokens: 2, totalTokens: 10 }),
    system: undefined,
    messages: [{ role: "user", content: "hi" }],
    maxSteps: 1,
    abortSignal: new AbortController().signal,
    mapper,
    hooks: { emit: (e) => events.push(e), appendMessages: (m) => appended.push(...m) },
  });
  assert.deepEqual(r, {
    aborted: false,
    errored: false,
    hitStepLimit: false,
    hitContextLimit: false,
    stoppedEarly: false,
  });
  assert.equal(events.find((e) => e.type === "assistant_text") !== undefined, true);
  const usage = events.find((e) => e.type === "usage");
  assert.equal((usage as { tokens: { output: number } } | undefined)?.tokens.output, 2);
  assert.equal(appended.length >= 1, true);
});

test("runTurn splices a mid-turn injection in after the current tool result", async () => {
  const prompts: string[][] = [];
  let n = 0;
  const model = new MockLanguageModelV2({
    doStream: async (opts) => {
      n += 1;
      prompts.push(
        opts.prompt.flatMap((m) =>
          typeof m.content === "string"
            ? [m.content]
            : m.content.map((p) => ("text" in p && typeof p.text === "string" ? p.text : p.type)),
        ),
      );
      const chunks: Chunk[] =
        n === 1
          ? [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "r1", modelId: "mock", timestamp: new Date(0) },
              { type: "tool-input-start", id: "tc1", toolName: "ping" },
              { type: "tool-input-delta", id: "tc1", delta: "{}" },
              { type: "tool-input-end", id: "tc1" },
              { type: "tool-call", toolCallId: "tc1", toolName: "ping", input: "{}" },
              {
                type: "finish",
                finishReason: "tool-calls",
                usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
              },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "r2", modelId: "mock", timestamp: new Date(0) },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "on it" },
              { type: "text-end", id: "t" },
              {
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 },
              },
            ];
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0 }) };
    },
  }) as unknown as LanguageModel;

  const appended: ModelMessage[] = [];
  let handed = false;
  const r = await runTurn({
    sessionId: "s1",
    model,
    system: undefined,
    messages: [{ role: "user", content: "start" }],
    tools: {
      ping: tool({ description: "p", inputSchema: z.object({}), execute: async () => "pong" }),
    },
    maxSteps: 6,
    abortSignal: new AbortController().signal,
    mapper: new AisdkEventMapper("s1", "mock"),
    drainInjections: () => {
      if (handed) return [];
      handed = true;
      return [{ role: "user", content: "ALSO do X" }];
    },
    hooks: { emit: () => {}, appendMessages: (m) => appended.push(...m) },
  });

  assert.deepEqual(r, {
    aborted: false,
    errored: false,
    hitStepLimit: false,
    hitContextLimit: false,
    stoppedEarly: false,
  });
  // the model's second request carried the injected user message
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1]?.includes("ALSO do X"), true);
  // persisted order: tool call, tool result, the injection, then the reply
  const injIdx = appended.findIndex((m) => m.content === "ALSO do X");
  assert.equal(injIdx > 0, true);
  assert.equal(appended[injIdx - 1]?.role, "tool");
  assert.equal(appended.at(-1)?.role, "assistant");
  assert.equal(appended.filter((m) => m.role === "user").length, 1);
});

test("runTurn flags hitStepLimit when the model is still calling tools at the ceiling", async () => {
  let step = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      step += 1;
      return {
        stream: simulateReadableStream({
          initialDelayInMs: 0,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: `r${step}`, modelId: "mock", timestamp: new Date(0) },
            { type: "tool-call", toolCallId: `c${step}`, toolName: "ping", input: "{}" },
            {
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
            },
          ],
        }),
      };
    },
  }) as unknown as LanguageModel;

  const stop = await runTurn({
    sessionId: "s1",
    model,
    system: undefined,
    messages: [{ role: "user", content: "go" }],
    tools: {
      ping: tool({ description: "p", inputSchema: z.object({}), execute: async () => "pong" }),
    },
    maxSteps: 3,
    abortSignal: new AbortController().signal,
    mapper: new AisdkEventMapper("s1", "mock"),
    hooks: { emit: () => {}, appendMessages: () => {} },
  });
  assert.deepEqual(stop, {
    aborted: false,
    errored: false,
    hitStepLimit: true,
    hitContextLimit: false,
    stoppedEarly: false,
  });
  assert.equal(step, 3);

  // A turn that ends on its own text is not flagged.
  const done = await runTurn({
    sessionId: "s1",
    model: textReply("all done"),
    system: undefined,
    messages: [{ role: "user", content: "go" }],
    maxSteps: 3,
    abortSignal: new AbortController().signal,
    mapper: new AisdkEventMapper("s1", "mock"),
    hooks: { emit: () => {}, appendMessages: () => {} },
  });
  assert.equal(done.hitStepLimit, false);
});

test("runTurn ends a segment early when shouldStopForContext trips (A9)", async () => {
  let step = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      step += 1;
      return {
        stream: simulateReadableStream({
          initialDelayInMs: 0,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: `r${step}`, modelId: "mock", timestamp: new Date(0) },
            { type: "tool-call", toolCallId: `c${step}`, toolName: "ping", input: "{}" },
            {
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
            },
          ],
        }),
      };
    },
  }) as unknown as LanguageModel;

  let checks = 0;
  const r = await runTurn({
    sessionId: "s1",
    model,
    system: undefined,
    messages: [{ role: "user", content: "go" }],
    tools: {
      ping: tool({ description: "p", inputSchema: z.object({}), execute: async () => "pong" }),
    },
    maxSteps: 50,
    abortSignal: new AbortController().signal,
    mapper: new AisdkEventMapper("s1", "mock"),
    hooks: { emit: () => {}, appendMessages: () => {} },
    shouldStopForContext: () => {
      checks += 1;
      return checks >= 3; // "context near the window" after a couple of steps
    },
  });

  assert.equal(r.hitContextLimit, true);
  assert.equal(r.hitStepLimit, false, "a context stop is not a step-ceiling stop");
  assert.ok(step < 50, `stopped early (${step} steps), well short of maxSteps`);
});

test("runTurn breaks on an error part and stops consuming the stream (A4)", async () => {
  const events: HarnessEvent[] = [];
  const chunks: Chunk[] = [
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "r", modelId: "mock", timestamp: new Date(0) },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "before" },
    { type: "text-end", id: "t" },
    { type: "error", error: new Error("mid-stream boom") },
    // Anything past the error must not be mapped — the loop has already broken.
    { type: "text-start", id: "u" },
    { type: "text-delta", id: "u", delta: "after the error" },
    { type: "text-end", id: "u" },
    {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ];
  const r = await runTurn({
    sessionId: "s1",
    model: model(chunks),
    system: undefined,
    messages: [{ role: "user", content: "hi" }],
    maxSteps: 1,
    abortSignal: new AbortController().signal,
    mapper: new AisdkEventMapper("s1", "mock"),
    hooks: { emit: (e) => events.push(e), appendMessages: () => {} },
  });
  assert.deepEqual(r, {
    aborted: false,
    errored: true,
    hitStepLimit: false,
    hitContextLimit: false,
    stoppedEarly: false,
  });
  assert.ok(
    events.some((e) => e.type === "error" && (e as { fatal?: boolean }).fatal),
    "the error part surfaced as a fatal error event",
  );
  assert.ok(
    !events.some(
      (e) => e.type === "assistant_text" && (e as { text: string }).text.includes("after"),
    ),
    "text streamed after the error part was not mapped",
  );
});

// --- session via provider ------------------------------------------------

test("createSession runs the first turn, emits result, and persists the transcript", async () => {
  const { db, cleanup } = tmpDb();
  try {
    const store = new ProviderMessageStore(db);
    const p = provider(() => textReply("a concise answer"), store);
    const s = await p.createSession({
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "do a thing",
      mode: "default",
      mcpServers: [],
    });
    const evs = await drain(s.events(), (e) => e.type === "result");
    await s.close();

    assert.equal(
      evs.some((e) => e.type === "assistant_text"),
      true,
    );
    assert.equal(
      evs.some((e) => e.type === "usage"),
      true,
    );
    assert.equal(evs.at(-1)?.type, "result");

    // user prompt + assistant reply persisted, in order.
    const stored = store.load("s1");
    assert.equal(stored[0]?.role, "user");
    assert.equal(stored.at(-1)?.role, "assistant");
    assert.equal(s.snapshot().turns, 1);
  } finally {
    cleanup();
  }
});
test("a chosen reasoning effort rides into providerOptions on every model call", async () => {
  const { db, cleanup } = tmpDb();
  try {
    const store = new ProviderMessageStore(db);
    const seen: Array<Record<string, unknown> | undefined> = [];
    let roundTrips = 0;
    const model = new MockLanguageModelV2({
      doStream: async (opts) => {
        roundTrips += 1;
        seen.push(opts.providerOptions as Record<string, unknown> | undefined);
        return {
          stream: simulateReadableStream({
            initialDelayInMs: 0,
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "response-metadata",
                id: `r${roundTrips}`,
                modelId: "mock",
                timestamp: new Date(0),
              },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "ok" },
              { type: "text-end", id: "t" },
              {
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
              },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;
    const p = new AisdkProvider(
      {
        id: "mygw",
        model: "gpt-5",
        models: ["gpt-5"],
        makeModel: () => model,
        providerOptionsName: "mygw",
      },
      store,
    );
    const s = await p.createSession({
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "first",
      mode: "default",
      mcpServers: [],
      effort: "high",
    });
    assert.equal(s.snapshot().effort, "high");
    const results: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const e of s.events()) if (e.type === "result") results.push(e);
    })();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(seen[0], { mygw: { reasoningEffort: "high" } });

    // a live switch takes effect from the next turn on
    await s.setEffort("low");
    assert.equal(s.snapshot().effort, "low");
    await s.send("again");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(roundTrips, 2);
    assert.deepEqual(seen.at(-1), { mygw: { reasoningEffort: "low" } });
    await s.close();
    await reader;
    assert.equal(results.length, 2);

    // a resume restores the effort from the session ref
    const s2 = await p.resumeSession({
      sessionId: "s2",
      providerRef: "s2",
      cwd: "/tmp",
      mode: "default",
      effort: "xhigh",
    });
    assert.equal(s2.snapshot().effort, "xhigh");
    await s2.close();
  } finally {
    cleanup();
  }
});

test("interrupt aborts the running turn — no result, status not idle", async () => {
  const { db, cleanup } = tmpDb();
  try {
    const store = new ProviderMessageStore(db);
    const p = provider(
      () => textReply("one two three four five six", {}, { chunkDelayInMs: 20 }),
      store,
    );
    const s = await p.createSession({
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "go",
      mode: "default",
      mcpServers: [],
    });
    const seen: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const ev of s.events()) seen.push(ev);
    })();
    await new Promise((r) => setTimeout(r, 15));
    await s.interrupt();
    await s.close();
    await reader;

    assert.equal(
      seen.some((e) => e.type === "result"),
      false,
    );
    assert.notEqual(s.snapshot().status.kind, "idle");
  } finally {
    cleanup();
  }
});

test("a message sent mid-turn with no step to catch it folds into the same turn", async () => {
  const { db, cleanup } = tmpDb();
  try {
    const store = new ProviderMessageStore(db);
    let roundTrips = 0;
    const model = new MockLanguageModelV2({
      doStream: async () => {
        roundTrips += 1;
        return {
          stream: simulateReadableStream({
            initialDelayInMs: 0,
            chunkDelayInMs: 5,
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "response-metadata",
                id: `r${roundTrips}`,
                modelId: "mock",
                timestamp: new Date(0),
              },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: `reply ${roundTrips}` },
              { type: "text-end", id: "t" },
              {
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
              },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;
    const p = provider(() => model, store);
    const s = await p.createSession({
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "first",
      mode: "default",
      mcpServers: [],
    });
    // the turn is already running (single text step, no tool boundary), so
    // "second" is queued and flushed after the turn → the loop chains one more
    // round-trip for it without emitting a separate `result`.
    const results: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const e of s.events()) if (e.type === "result") results.push(e);
    })();
    await s.send("second");
    await new Promise((r) => setTimeout(r, 400));
    await s.close();
    await reader;

    const stored = store.load("s1");
    assert.deepEqual(
      stored.map((m) => m.role),
      ["user", "assistant", "user", "assistant"],
    );
    assert.equal(stored[2]?.content, "second");
    assert.equal(roundTrips, 2, "two model round-trips");
    assert.equal(results.length, 1, "but a single end-of-turn result");
    assert.equal(s.snapshot().turns, 1);
  } finally {
    cleanup();
  }
});

test("two near-simultaneous sends to an idle session don't double-run a turn", async () => {
  const { db, cleanup } = tmpDb();
  try {
    const store = new ProviderMessageStore(db);
    let rt = 0;
    const model = new MockLanguageModelV2({
      doStream: async () => {
        rt += 1;
        return {
          stream: simulateReadableStream({
            initialDelayInMs: 0,
            chunkDelayInMs: 4,
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: `r${rt}`, modelId: "mock", timestamp: new Date(0) },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: `r${rt}` },
              { type: "text-end", id: "t" },
              {
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
              },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;
    const p = provider(() => model, store);
    const s = await p.createSession({
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "first",
      mode: "default",
      mcpServers: [],
    });
    await drain(s.events(), (e) => e.type === "result"); // turn 1 → idle

    await Promise.all([s.send("A"), s.send("B")]); // fired together, not awaited apart
    await drain(s.events(), (e) => e.type === "result"); // A's turn (B folded in)
    await s.close();

    // A ran a turn; B was queued (not a second overlapping turn) and folded in.
    assert.deepEqual(
      store.load("s1").map((m) => m.role),
      ["user", "assistant", "user", "assistant", "user", "assistant"],
    );
    const contents = store.load("s1").map((m) => m.content);
    assert.equal(contents[2], "A");
    assert.equal(contents[4], "B");
  } finally {
    cleanup();
  }
});

test("a turn that fails to start clears the busy flag; the next send recovers", async () => {
  const { db, cleanup } = tmpDb();
  try {
    const store = new ProviderMessageStore(db);
    let attempt = 0;
    const model = new MockLanguageModelV2({
      doStream: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("transient upstream failure");
        return {
          stream: simulateReadableStream({
            initialDelayInMs: 0,
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "recovered" },
              { type: "text-end", id: "t" },
              {
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
              },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;
    const p = provider(() => model, store);
    const s = await p.createSession({
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "go",
      mode: "default",
      mcpServers: [],
    });
    await drain(s.events(), (e) => e.type === "error");
    await new Promise((r) => setTimeout(r, 20)); // let #runTurn reach its terminal branch
    assert.notEqual(s.snapshot().status.kind, "running");

    // The session is not wedged — a fresh send starts a new turn. If the busy
    // flag were stuck, this would queue as an injection and never run, and the
    // drain below would hang.
    await s.send("try again");
    await drain(s.events(), (e) => e.type === "result");
    assert.equal(s.snapshot().status.kind, "idle");
    assert.equal(store.load("s1").at(-1)?.role, "assistant");
    await s.close();
  } finally {
    cleanup();
  }
});

test("dropDanglingToolCalls trims an assistant turn whose tool calls were never answered", () => {
  const user = { role: "user", content: "go" } as const;
  const asstCalls = {
    role: "assistant",
    content: [
      { type: "text", text: "on it" },
      { type: "tool-call", toolCallId: "a", toolName: "bash", input: {} },
      { type: "tool-call", toolCallId: "b", toolName: "bash", input: {} },
    ],
  } as const;
  const resultA = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "a",
        toolName: "bash",
        output: { type: "text", value: "ok" },
      },
    ],
  } as const;
  const resultB = { ...resultA, content: [{ ...resultA.content[0], toolCallId: "b" }] } as const;

  // one result missing → the assistant turn (and the partial result) are dropped
  assert.deepEqual(dropDanglingToolCalls([user, asstCalls, resultA] as never), [user]);
  // fully answered → left untouched
  const complete = [user, asstCalls, resultA, resultB] as never;
  assert.equal(dropDanglingToolCalls(complete), complete);
  // no tool calls at all → untouched
  const plain = [user, { role: "assistant", content: "hi" }] as never;
  assert.equal(dropDanglingToolCalls(plain), plain);
});
test("repairMalformedToolInputs normalizes string tool-call inputs; healthy ones pass through", () => {
  const poisoned = '{"path": "a.ts", "sections": \x3carg_value\x3e["300-520"]}';
  const healthy = { command: "pwd" };
  const asst = {
    role: "assistant",
    content: [
      { type: "text", text: "reading" },
      { type: "tool-call", toolCallId: "t1", toolName: "tilth_read", input: poisoned },
      { type: "tool-call", toolCallId: "t2", toolName: "bash", input: healthy },
      {
        type: "tool-call",
        toolCallId: "t3",
        toolName: "bash",
        input: '"{\\"command\\":\\"ls\\"}"',
      },
    ],
  };
  const out = repairMalformedToolInputs([{ role: "user", content: "go" }, asst] as never);
  const parts = ((out[1]?.content ?? []) as Array<{ type: string; input?: unknown }>).filter(
    (p) => p.type === "tool-call",
  );
  // unparseable garbage → wrapped as an OBJECT carrying the raw text (a
  // string input would go out double-encoded and sference still rejects it)
  assert.deepEqual(parts[0]?.input, { malformed_tool_input: poisoned });
  // already-an-object input is untouched (same reference)
  assert.equal(parts[1]?.input, healthy);
  // a double-encoded (quoted-JSON) string unwraps to its parsed value
  assert.deepEqual(parts[2]?.input, { command: "ls" });
  // a clean transcript comes back as the same array, untouched
  const clean = [{ role: "user", content: "go" }] as never;
  assert.equal(repairMalformedToolInputs(clean), clean);
});

test("runTurn repairs a poisoned transcript tool-call before the request goes out", async () => {
  const prompts: Array<Array<{ type: string; input?: string }>> = [];
  const capturing = new MockLanguageModelV2({
    doStream: async (opts) => {
      prompts.push(
        opts.prompt.flatMap((m) => (typeof m.content === "string" ? [] : m.content)) as never,
      );
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "r", modelId: "mock", timestamp: new Date(0) },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "ok" },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
            },
          ],
          initialDelayInMs: 0,
        }),
      };
    },
  }) as unknown as LanguageModel;

  await runTurn({
    sessionId: "s1",
    model: capturing,
    system: undefined,
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "tilth_read",
            input: '{"sections": \x3carg_value\x3e["300-520"]}',
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "tilth_read",
            output: { type: "error-text", value: "JSON parsing failed" },
          },
        ],
      },
    ] as never,
    maxSteps: 1,
    abortSignal: new AbortController().signal,
    mapper: new AisdkEventMapper("s1", "mock"),
    hooks: { emit: () => {}, appendMessages: () => {} },
  });

  // the model saw a parseable (re-wrapped) tool-call input, not the raw garbage
  const calls = prompts[0]?.filter((p) => p.type === "tool-call") ?? [];
  const seen = calls[0]?.input as unknown as { malformed_tool_input?: string };
  assert.equal(typeof seen.malformed_tool_input, "string");
});

test("runTurn sanitizes a tool call the model generated mid-turn before the next step", async () => {
  const prompts: Array<Array<{ type: string; input?: unknown }>> = [];
  let n = 0;
  const glitchy = new MockLanguageModelV2({
    doStream: async (opts) => {
      n += 1;
      prompts.push(
        opts.prompt.flatMap((m) => (typeof m.content === "string" ? [] : m.content)) as never,
      );
      const chunks: Chunk[] =
        n === 1
          ? [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "r1", modelId: "mock", timestamp: new Date(0) },
              {
                type: "tool-call",
                toolCallId: "tc1",
                toolName: "ping",
                input: '{"broken": \x3carg_value\x3e}',
              },
              {
                type: "finish",
                finishReason: "tool-calls",
                usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
              },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "r2", modelId: "mock", timestamp: new Date(0) },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "done" },
              { type: "text-end", id: "t" },
              {
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 },
              },
            ];
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0 }) };
    },
  }) as unknown as LanguageModel;

  await runTurn({
    sessionId: "s1",
    model: glitchy,
    system: undefined,
    messages: [{ role: "user", content: "start" }],
    tools: {
      ping: tool({ description: "p", inputSchema: z.object({}), execute: async () => "pong" }),
    },
    maxSteps: 3,
    abortSignal: new AbortController().signal,
    mapper: new AisdkEventMapper("s1", "mock"),
    hooks: { emit: () => {}, appendMessages: () => {} },
  });

  // step 2's prompt must carry the mid-turn tool call re-wrapped, not the raw
  // garbage the SDK would otherwise put straight on the wire
  assert.equal(prompts.length >= 2, true);
  const calls = prompts[1]?.filter((p) => p.type === "tool-call") ?? [];
  const seen = calls[0]?.input as unknown as { malformed_tool_input?: string };
  assert.equal(typeof seen.malformed_tool_input, "string");
});
test("resumeSession reloads the transcript; the next turn sees the history", async () => {
  const { db, cleanup } = tmpDb();
  try {
    const store = new ProviderMessageStore(db);
    let seenMessages = 0;
    const make = (): LanguageModel =>
      new MockLanguageModelV2({
        doStream: async (opts) => {
          seenMessages = opts.prompt.length;
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "ok" },
                { type: "text-end", id: "t" },
                {
                  type: "finish",
                  finishReason: "stop",
                  usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
                },
              ],
            }),
          };
        },
      }) as unknown as LanguageModel;

    const p1 = provider(make, store);
    const s1 = await p1.createSession({
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "first",
      mode: "default",
      mcpServers: [],
    });
    await drain(s1.events(), (e) => e.type === "result");
    await s1.close();
    const afterFirst = store.count("s1");
    assert.equal(afterFirst >= 2, true);

    const p2 = provider(make, store);
    const s2 = await p2.resumeSession({
      sessionId: "s1",
      providerRef: "s1",
      cwd: "/tmp",
      model: "gpt-5",
    });
    await s2.send("second");
    await drain(s2.events(), (e) => e.type === "result");
    await s2.close();

    // the resumed turn was handed the full prior transcript + the new user msg.
    assert.equal(seenMessages > 2, true);
    assert.equal(store.count("s1") > afterFirst, true);
  } finally {
    cleanup();
  }
});

// --- through the SessionManager ----------------------------------------------

test("SessionManager drains an aisdk session: usage rollup + result + idle", async () => {
  const { db, cleanup } = tmpDb();
  try {
    const store = new ProviderMessageStore(db);
    const p = provider(
      () =>
        textReply("done", {
          inputTokens: 30,
          outputTokens: 4,
          totalTokens: 34,
          cachedInputTokens: 10,
        }),
      store,
    );

    const events: HarnessEvent[] = [];
    const usage: UsageDelta[] = [];
    const statuses: Array<{ status: SessionState; note: string | undefined }> = [];
    let results = 0;
    const mgr = new SessionManager({
      emitEvent: (ev) => events.push(ev),
      onStatus: (_id, status, note) => statuses.push({ status, note }),
      onUsage: (_id, d) => usage.push(d),
      onResult: () => {
        results += 1;
      },
      onSubagents: () => {},
      onBackgroundTasks: () => {},
      onRestructuring: () => {},
      onProviderRef: () => {},
      onMode: () => {},
      log: makeLogger("test"),
    });

    await mgr.create(p, {
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "hello",
      mode: "default",
      mcpServers: [],
    });
    // wait for the turn to finish
    for (let i = 0; i < 200 && results === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await mgr.shutdown();

    assert.equal(results, 1);
    assert.equal(
      statuses.some((s) => s.status.kind === "idle"),
      true,
    );
    const withTokens = usage.find((d) => (d.input ?? 0) > 0 || (d.cacheRead ?? 0) > 0);
    assert.equal(withTokens?.cacheRead, 10);
    assert.equal(withTokens?.input, 20);
    assert.equal(withTokens?.contextLimit, 400_000);
  } finally {
    cleanup();
  }
});

test("SessionManager.respondToPlan pushes the decision's mode — no stale plan chip", async () => {
  const { db, cleanup } = tmpDb();
  try {
    const store = new ProviderMessageStore(db);
    // Step 1 presents a plan; the chained implement turn answers with text.
    const planChunks: Chunk[] = [
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: "r1", modelId: "mock", timestamp: new Date(0) },
      {
        type: "tool-call",
        toolCallId: "p1",
        toolName: "exit_plan",
        input: JSON.stringify({ plan: "1. do the thing" }),
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      },
    ];
    const doneChunks: Chunk[] = [
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: "r2", modelId: "mock", timestamp: new Date(0) },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Implemented." },
      { type: "text-end", id: "t" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      },
    ];
    let call = 0;
    const m = new MockLanguageModelV2({
      doStream: async () => {
        call += 1;
        return {
          stream: simulateReadableStream({
            chunks: call === 1 ? planChunks : doneChunks,
            initialDelayInMs: 0,
          }),
        };
      },
    }) as unknown as LanguageModel;
    const p = provider(() => m, store);

    const evs: HarnessEvent[] = [];
    const modes: string[] = [];
    let results = 0;
    const mgr = new SessionManager({
      emitEvent: (ev) => evs.push(ev),
      onStatus: () => {},
      onUsage: () => {},
      onResult: () => {
        results += 1;
      },
      onSubagents: () => {},
      onBackgroundTasks: () => {},
      onRestructuring: () => {},
      onProviderRef: () => {},
      onMode: (_id, mode) => modes.push(mode),
      log: makeLogger("test"),
    });

    await mgr.create(p, {
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "plan then build",
      mode: "plan",
      mcpServers: [],
      loomServer: true,
    });
    let review: Extract<HarnessEvent, { type: "plan_review" }> | undefined;
    for (let i = 0; i < 200 && !review; i++) {
      await new Promise((r) => setTimeout(r, 5));
      review = evs.find(
        (e): e is Extract<HarnessEvent, { type: "plan_review" }> => e.type === "plan_review",
      );
    }
    assert.ok(review, "expected a plan_review");

    const r = await mgr.respondToPlan("s1", review.id, { action: "implement", mode: "auto" });
    assert.deepEqual(r, { ok: true, alreadyResolved: false });
    // The mode chip a client reads comes from this registry sync — it must
    // carry the decision's mode, not the "plan" the adapter still reported
    // while the exploration turn was parked.
    assert.equal(modes.at(-1), "auto");

    for (let i = 0; i < 200 && results === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(results, 1);
    // and the adapter's own snapshot agrees once the implement turn runs
    assert.equal(mgr.snapshot("s1")?.mode, "auto");
    await mgr.shutdown();
  } finally {
    cleanup();
  }
});
test("SessionManager keep-warm: toggle, ping counter, and cleanup on close", async () => {
  const { db, cleanup } = tmpDb();
  try {
    const store = new ProviderMessageStore(db);
    const p = provider(() => textReply("ok"), store);
    let results = 0;
    const mgr = new SessionManager({
      emitEvent: () => {},
      onStatus: () => {},
      onUsage: () => {},
      onResult: () => {
        results += 1;
      },
      onSubagents: () => {},
      onBackgroundTasks: () => {},
      onRestructuring: () => {},
      onProviderRef: () => {},
      onMode: () => {},
      log: makeLogger("test"),
    });
    const settle = async () => {
      const target = results + 1;
      for (let i = 0; i < 200 && results < target; i++) await new Promise((r) => setTimeout(r, 5));
    };

    await mgr.create(p, {
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "hello",
      mode: "default",
      mcpServers: [],
    });
    await settle();

    assert.equal(mgr.keepWarm("s1"), false);
    mgr.setKeepWarm("s1", true);
    assert.equal(mgr.keepWarm("s1"), true);
    assert.deepEqual(mgr.keepWarmIds(), ["s1"]);

    // A keep-warm ping bumps the loop-guard counter…
    await mgr.send("s1", "ping", { keepWarm: true });
    await settle();
    await mgr.send("s1", "ping", { keepWarm: true });
    await settle();
    assert.equal(mgr.warmPingCount("s1"), 2);

    // …and a real user message resets it.
    await mgr.send("s1", "actual work");
    await settle();
    assert.equal(mgr.warmPingCount("s1"), 0);

    await mgr.close("s1");
    assert.equal(mgr.keepWarm("s1"), false);
    assert.deepEqual(mgr.keepWarmIds(), []);

    await mgr.shutdown();
  } finally {
    cleanup();
  }
});

// --- resolveModelFactory: the @ai-sdk/* backend per connector --------------

test("connector-generic / -gemini build the right SDK client for each `sdk`", async () => {
  const { resolveModelFactory: geminiFactory } = await import("@loom/connector-gemini");
  const meta = (m: LanguageModel) => m as unknown as { provider: string; modelId: string };

  const oai = await resolveModelFactory("openai", { id: "x", baseUrl: "http://x/v1", apiKey: "k" });
  assert.match(meta(oai("some-model")).provider, /^x\./); // openai-compatible names by `id`

  const g = await geminiFactory({ baseUrl: "", apiKey: "k" });
  assert.equal(meta(g("gemini-2.5-pro")).provider, "google.generative-ai");
  assert.equal(meta(g("gemini-2.5-pro")).modelId, "gemini-2.5-pro");

  const a = await resolveModelFactory("anthropic", { id: "claude-api", baseUrl: "", apiKey: "k" });
  assert.equal(meta(a("claude-sonnet-5")).provider, "anthropic.messages");
});

test("AisdkSession.rewind truncates the transcript in memory and in the store", async () => {
  const { db, cleanup } = tmpDb();
  try {
    const store = new ProviderMessageStore(db);
    let n = 0;
    const make = (): LanguageModel =>
      new MockLanguageModelV2({
        doStream: async () => {
          n += 1;
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: `reply ${n}` },
                { type: "text-end", id: "t" },
                {
                  type: "finish",
                  finishReason: "stop",
                  usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
                },
              ],
            }),
          };
        },
      }) as unknown as LanguageModel;

    const s = await provider(make, store).createSession({
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "first",
      mode: "default",
      mcpServers: [],
    });
    await drain(s.events(), (e) => e.type === "result"); // turn 1: [user, assistant]
    await s.send("second");
    await drain(s.events(), (e) => e.type === "result"); // turn 2: + [user, assistant]

    assert.equal(store.load("s1").length, 4);

    await s.rewind(2); // keep just turn 1
    assert.equal(store.load("s1").length, 2);
    assert.deepEqual(
      store.load("s1").map((m) => m.role),
      ["user", "assistant"],
    );

    // the next turn continues from the truncated history
    await s.send("third");
    await drain(s.events(), (e) => e.type === "result");
    assert.equal(store.load("s1").length, 4);
    await s.close();
  } finally {
    cleanup();
  }
});
