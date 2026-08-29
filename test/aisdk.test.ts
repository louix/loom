import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { tool, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import type { HarnessEvent, SessionStatus } from "../src/protocol/events.ts";
import type { UsageDelta } from "../src/store/sessions.ts";
import { openDb } from "../src/store/db.ts";
import { SessionManager } from "../src/daemon/session-manager.ts";
import { makeLogger, setLogLevel } from "../src/util/logger.ts";
import { AisdkProvider, resolveModelFactory } from "../src/provider/aisdk/adapter.ts";
import { AisdkEventMapper } from "../src/provider/aisdk/map.ts";
import { ProviderMessageStore } from "../src/provider/aisdk/store.ts";
import { runTurn } from "../src/provider/aisdk/loop.ts";
import { contextLimitFor, estimateTokens } from "../src/provider/aisdk/tokens.ts";

setLogLevel("error");

// --- helpers ---------------------------------------------------------------

type Chunk = LanguageModelV2StreamPart;

function model(chunks: Chunk[], opts: { chunkDelayInMs?: number } = {}): LanguageModel {
  return new MockLanguageModelV2({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks,
        initialDelayInMs: 0,
        ...(opts.chunkDelayInMs != null ? { chunkDelayInMs: opts.chunkDelayInMs } : {}),
      }),
    }),
  }) as unknown as LanguageModel;
}

function textReply(
  text: string,
  usage: Partial<{ inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number }> = {},
  opts: { chunkDelayInMs?: number } = {},
): LanguageModel {
  return model(
    [
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: "r", modelId: "mock", timestamp: new Date(0) },
      { type: "text-start", id: "t" },
      ...text.split(" ").map((w, i) => ({ type: "text-delta" as const, id: "t", delta: i === 0 ? w : ` ${w}` })),
      { type: "text-end", id: "t" },
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: usage.inputTokens ?? 10,
          outputTokens: usage.outputTokens ?? 3,
          totalTokens: usage.totalTokens ?? 13,
          ...(usage.cachedInputTokens != null ? { cachedInputTokens: usage.cachedInputTokens } : {}),
        },
      },
    ],
    opts,
  );
}

function provider(make: (id: string) => LanguageModel, store: ProviderMessageStore): AisdkProvider {
  return new AisdkProvider(
    { id: "openai", model: "gpt-5", models: ["gpt-5"], makeModel: make },
    store,
  );
}

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "loom-aisdk-"));
  const db = openDb(join(dir, "t.db"));
  db.prepare(
    "INSERT INTO sessions (id, provider, mode, created_at, updated_at) VALUES (?, 'openai', 'default', 0, 0)",
  ).run("s1");
  db.prepare("INSERT INTO sessions (id, provider, mode, created_at, updated_at) VALUES (?, 'openai', 'default', 0, 0)").run(
    "s2",
  );
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function drain(events: AsyncIterable<HarnessEvent>, until: (ev: HarnessEvent) => boolean): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const ev of events) {
    out.push(ev);
    if (until(ev)) break;
  }
  return out;
}

// --- tokens --------------------------------------------------------------

test("contextLimitFor matches on model-id prefix, falls back to 128k", () => {
  assert.equal(contextLimitFor("gpt-5-mini"), 400_000);
  assert.equal(contextLimitFor("deepseek-reasoner"), 128_000);
  assert.equal(contextLimitFor("glm-4.6"), 200_000);
  assert.equal(contextLimitFor("something-unknown"), 128_000);
  assert.equal(contextLimitFor(null), 128_000);
  // native anthropic / google aisdk backends
  assert.equal(contextLimitFor("claude-sonnet-5"), 200_000);
  assert.equal(contextLimitFor("anthropic/claude-3-5-haiku"), 200_000);
  assert.equal(contextLimitFor("gemini-2.5-pro"), 1_000_000);
  assert.equal(contextLimitFor("gemini-1.5-pro"), 1_000_000);
});

test("estimateTokens is chars/4 over message content, and shrugs off malformed rows", () => {
  assert.equal(estimateTokens([{ role: "user", content: "12345678" }]), 2);
  assert.equal(estimateTokens([]), 0);
  // a row with no content / a circular structure must not throw
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  assert.equal(estimateTokens([{ role: "user" } as never, { role: "user", content: circular } as never]), 0);
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

test("mapper turns reasoning into thinking and tool parts into tool_call/tool_result", () => {
  const m = new AisdkEventMapper("s1", "gpt-5");
  m.map({ type: "reasoning-delta", id: "r", text: "hmm" } as never);
  assert.equal(m.map({ type: "reasoning-end", id: "r" } as never)[0]?.type, "thinking");

  const call = m.map({ type: "tool-call", toolCallId: "c1", toolName: "echo", input: { x: 1 } } as never)[0];
  assert.equal(call?.type, "tool_call");
  assert.deepEqual(call, { type: "tool_call", sessionId: "s1", ts: (call as { ts: number }).ts, id: "c1", name: "echo", input: { x: 1 } });

  const res = m.map({ type: "tool-result", toolCallId: "c1", toolName: "echo", input: {}, output: "ok" } as never)[0];
  assert.equal(res?.type, "tool_result");
  assert.equal((res as { ok: boolean }).ok, true);

  const errp = m.map({ type: "tool-error", toolCallId: "c1", toolName: "echo", input: {}, error: new Error("boom") } as never)[0];
  assert.equal((errp as { ok: boolean }).ok, false);
  assert.equal((errp as { output: unknown }).output, "boom");
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
  assert.deepEqual((ev as { tokens: unknown }).tokens, { input: 60, output: 20, cacheRead: 40, cacheWrite: 0 });
  assert.equal((ev as { contextUsed: number }).contextUsed, 100);
  assert.equal((ev as { contextLimit: number }).contextLimit, 400_000);
});

test("mapper surfaces a stream error part as a fatal error event", () => {
  const m = new AisdkEventMapper("s1", "gpt-5");
  const ev = m.map({ type: "error", error: new Error("network down") } as never)[0];
  assert.deepEqual(ev, { type: "error", sessionId: "s1", ts: (ev as { ts: number }).ts, message: "network down", fatal: true });
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
  assert.deepEqual(r, { aborted: false, errored: false });
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
              { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "r2", modelId: "mock", timestamp: new Date(0) },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "on it" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: "stop", usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 } },
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
    tools: { ping: tool({ description: "p", inputSchema: z.object({}), execute: async () => "pong" }) },
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

  assert.deepEqual(r, { aborted: false, errored: false });
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

    assert.equal(evs.some((e) => e.type === "assistant_text"), true);
    assert.equal(evs.some((e) => e.type === "usage"), true);
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

test("interrupt aborts the running turn — no result, status not idle", async () => {
  const { db, cleanup } = tmpDb();
  try {
    const store = new ProviderMessageStore(db);
    const p = provider(() => textReply("one two three four five six", {}, { chunkDelayInMs: 20 }), store);
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

    assert.equal(seen.some((e) => e.type === "result"), false);
    assert.notEqual(s.snapshot().status, "idle");
  } finally {
    cleanup();
  }
});

test("a message sent mid-turn with no step to catch it rides the next turn", async () => {
  const { db, cleanup } = tmpDb();
  try {
    const store = new ProviderMessageStore(db);
    let calls = 0;
    const p = provider(() => {
      calls += 1;
      return textReply(`reply ${calls}`, {}, { chunkDelayInMs: 10 });
    }, store);
    const s = await p.createSession({
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "first",
      mode: "default",
      mcpServers: [],
    });
    // the turn is already running (single text step, no tool boundary)
    await s.send("second");
    await drain(s.events(), (e) => e.type === "result"); // turn 1
    await drain(s.events(), (e) => e.type === "result"); // chained turn for "second"
    await s.close();

    const roles = store.load("s1").map((m) => m.role);
    assert.deepEqual(roles, ["user", "assistant", "user", "assistant"]);
    assert.equal(store.load("s1")[2]?.content, "second");
    assert.equal(s.snapshot().turns, 2);
  } finally {
    cleanup();
  }
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
                { type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } },
              ],
            }),
          };
        },
      }) as unknown as LanguageModel;

    const p1 = provider(make, store);
    const s1 = await p1.createSession({ sessionId: "s1", cwd: "/tmp", prompt: "first", mode: "default", mcpServers: [] });
    await drain(s1.events(), (e) => e.type === "result");
    await s1.close();
    const afterFirst = store.count("s1");
    assert.equal(afterFirst >= 2, true);

    const p2 = provider(make, store);
    const s2 = await p2.resumeSession({ sessionId: "s1", providerRef: "s1", cwd: "/tmp", model: "gpt-5" });
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
    const p = provider(() => textReply("done", { inputTokens: 30, outputTokens: 4, totalTokens: 34, cachedInputTokens: 10 }), store);

    const events: HarnessEvent[] = [];
    const usage: UsageDelta[] = [];
    const statuses: Array<{ status: SessionStatus; reason: string | null }> = [];
    let results = 0;
    const mgr = new SessionManager({
      emitEvent: (ev) => events.push(ev),
      onStatus: (_id, status, reason) => statuses.push({ status, reason }),
      onUsage: (_id, d) => usage.push(d),
      onResult: () => {
        results += 1;
      },
      onSubagents: () => {},
      onProviderRef: () => {},
      log: makeLogger("test"),
    });

    await mgr.create(p, { sessionId: "s1", cwd: "/tmp", prompt: "hello", mode: "default", mcpServers: [] });
    // wait for the turn to finish
    for (let i = 0; i < 200 && results === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await mgr.shutdown();

    assert.equal(results, 1);
    assert.equal(statuses.some((s) => s.status === "idle"), true);
    const withTokens = usage.find((d) => (d.input ?? 0) > 0 || (d.cacheRead ?? 0) > 0);
    assert.equal(withTokens?.cacheRead, 10);
    assert.equal(withTokens?.input, 20);
    assert.equal(withTokens?.contextLimit, 400_000);
  } finally {
    cleanup();
  }
});

// --- resolveModelFactory: the @ai-sdk/* backend per profile `sdk` -----------

test("resolveModelFactory builds the right SDK client for each `sdk`", async () => {
  const meta = (m: LanguageModel) => m as unknown as { provider: string; modelId: string };

  const oai = await resolveModelFactory("openai", { id: "x", baseUrl: "http://x/v1", apiKey: "k" });
  assert.match(meta(oai("some-model")).provider, /^x\./); // openai-compatible names by `id`

  const g = await resolveModelFactory("google", { id: "gemini", baseUrl: "", apiKey: "k" });
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
                { type: "finish", finishReason: "stop", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
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
    assert.deepEqual(store.load("s1").map((m) => m.role), ["user", "assistant"]);

    // the next turn continues from the truncated history
    await s.send("third");
    await drain(s.events(), (e) => e.type === "result");
    assert.equal(store.load("s1").length, 4);
    await s.close();
  } finally {
    cleanup();
  }
});
