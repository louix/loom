import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import type { LanguageModel } from "ai";
import { setLogLevel } from "@loom/core/logger";
import { openDb } from "@loom/daemon/store/db";
import { ProviderMessageStore } from "@loom/daemon/store/provider-messages";
import { AisdkProvider } from "@loom/aisdk/provider";
import type { HarnessEvent } from "@loom/core/events";

setLogLevel("error");
const FAKE_MCP = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

type Chunk = LanguageModelV2StreamPart;

/** Model whose Nth `doStream` returns the Nth chunk list (last repeats). */
const stepModel = (steps: Chunk[][]): LanguageModel => {
  let n = 0;
  return new MockLanguageModelV2({
    doStream: async () => {
      const chunks = steps[Math.min(n, steps.length - 1)] ?? [];
      n += 1;
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0 }) };
    },
  }) as unknown as LanguageModel;
};

const callStep = (id: string, name: string, input: string): Chunk[] => {
  return [
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: `r-${id}`, modelId: "mock", timestamp: new Date(0) },
    { type: "tool-call", toolCallId: id, toolName: name, input },
    {
      type: "finish",
      finishReason: "tool-calls",
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    },
  ];
};

const textStep = (text: string): Chunk[] => {
  return [
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "r-t", modelId: "mock", timestamp: new Date(0) },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    },
  ];
};

const env = () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-plan-"));
  const db = openDb(join(dir, "t.db"));
  db.prepare(
    "INSERT INTO sessions (id, provider, mode, created_at, updated_at) VALUES ('s1','openai','default',0,0)",
  ).run();
  return {
    dir,
    db,
    store: new ProviderMessageStore(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const provider = (make: () => LanguageModel, store: ProviderMessageStore) => {
  return new AisdkProvider({ id: "openai", model: "m", models: ["m"], makeModel: make }, store);
};

const pump = async (
  events: AsyncIterable<HarnessEvent>,
  handlers: {
    onPlan?: (ev: Extract<HarnessEvent, { type: "plan_review" }>) => void | Promise<void>;
    onPerm?: (ev: Extract<HarnessEvent, { type: "permission_request" }>) => void | Promise<void>;
  },
): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const ev of events) {
    out.push(ev);
    if (ev.type === "plan_review" && handlers.onPlan) await handlers.onPlan(ev);
    if (ev.type === "permission_request" && handlers.onPerm) await handlers.onPerm(ev);
    if (ev.type === "result" || (ev.type === "error" && ev.fatal)) break;
  }
  return out;
};

// --- plan mode -------------------------------------------------------------

test("plan mode: exit_plan → plan_review → implement chains an acceptEdits turn", async () => {
  const { dir, store, cleanup } = env();
  try {
    const notePath = join(dir, "n.txt");
    const model = stepModel([
      callStep("p1", "exit_plan", JSON.stringify({ plan: "1. write the note\n2. done" })),
      // The approval must END the exploration turn: its tool set was built in
      // plan mode (mutators withheld), so a write attempted there would be an
      // unavailable-tool error. The write lands in the chained turn instead.
      callStep("w1", "write_note", JSON.stringify({ path: notePath, content: "implemented" })),
      textStep("Implemented the plan."),
    ]);
    const s = await provider(() => model, store).createSession({
      sessionId: "s1",
      cwd: dir,
      prompt: "plan then build",
      mode: "plan",
      mcpServers: [
        { name: "fake", spec: { transport: "stdio", command: process.execPath, args: [FAKE_MCP] } },
      ],
      loomServer: true,
    });

    let planText = "";
    const perms: string[] = [];
    const evs = await pump(s.events(), {
      onPlan: async (ev) => {
        planText = ev.plan;
        await s.respondToPlan(ev.id, { action: "implement" });
      },
      onPerm: async (ev) => {
        perms.push(ev.tool);
        await s.respondToPermission(ev.id, { behavior: "allow" });
      },
    });
    await s.close();

    assert.match(planText, /write the note/);
    // write_note ran without a prompt — mode flipped to acceptEdits on approval
    assert.deepEqual(perms, []);
    assert.equal(
      evs.some((e) => e.type === "tool_result" && e.ok),
      true,
    );
    assert.equal(evs.at(-1)?.type, "result");
    assert.equal(readFileSync(notePath, "utf8"), "implemented");
    assert.equal(s.snapshot().mode, "acceptEdits");
  } finally {
    cleanup();
  }
});

test("plan mode: the plan decision's mode picks what the implementation runs in", async () => {
  const { dir, store, cleanup } = env();
  try {
    const notePath = join(dir, "n.txt");
    const model = stepModel([
      callStep("p1", "exit_plan", JSON.stringify({ plan: "1. write the note\n2. done" })),
      textStep("Planning complete."),
      callStep("w1", "write_note", JSON.stringify({ path: notePath, content: "implemented" })),
      textStep("Implemented the plan."),
    ]);
    const s = await provider(() => model, store).createSession({
      sessionId: "s1",
      cwd: dir,
      prompt: "plan then build",
      mode: "plan",
      mcpServers: [
        { name: "fake", spec: { transport: "stdio", command: process.execPath, args: [FAKE_MCP] } },
      ],
      loomServer: true,
    });

    const perms: string[] = [];
    const evs = await pump(s.events(), {
      onPlan: async (ev) => {
        // `m` cycled to manual in the review — the implementation must land in
        // `default`, so the mutator is gated instead of auto-accepted.
        await s.respondToPlan(ev.id, { action: "implement", mode: "default" });
      },
      onPerm: async (ev) => {
        perms.push(ev.tool);
        await s.respondToPermission(ev.id, { behavior: "allow" });
      },
    });
    await s.close();

    // unlike the plain-implement test above, the write is gated in default mode
    assert.deepEqual(perms, ["write_note"]);
    assert.equal(s.snapshot().mode, "default");
    assert.equal(readFileSync(notePath, "utf8"), "implemented");
    assert.equal(evs.at(-1)?.type, "result");
  } finally {
    cleanup();
  }
});

test("plan mode: discuss keeps the session planning", async () => {
  const { dir, store, cleanup } = env();
  try {
    const model = stepModel([
      callStep("p1", "exit_plan", JSON.stringify({ plan: "draft plan" })),
      textStep("Okay, I'll refine it."),
    ]);
    const s = await provider(() => model, store).createSession({
      sessionId: "s1",
      cwd: dir,
      prompt: "plan it",
      mode: "plan",
      mcpServers: [],
      loomServer: true,
    });

    let planReviews = 0;
    const evs = await pump(s.events(), {
      onPlan: async (ev) => {
        planReviews += 1;
        await s.respondToPlan(ev.id, { action: "discuss", message: "add a test step" });
      },
    });
    await s.close();

    assert.equal(planReviews, 1);
    assert.equal(s.snapshot().mode, "plan");
    const tr = evs.find((e) => e.type === "tool_result");
    assert.match(JSON.stringify((tr as { output: unknown }).output), /add a test step/);
    assert.equal(evs.at(-1)?.type, "result");
  } finally {
    cleanup();
  }
});

// --- compaction ----------------------------------------------------------

test("compact() summarises the history and rebuilds it to one message", async () => {
  const { store, cleanup } = env();
  try {
    const model = stepModel([textStep("SUMMARY: built the parser; TODO wire the CLI.")]);
    const s = await provider(() => model, store).createSession({
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "do a long thing",
      mode: "default",
      mcpServers: [],
    });
    // drain the initial turn
    await pump(s.events(), {});

    const before = store.load("s1").length;
    assert.ok(before >= 2);

    const compactEvents: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const ev of s.events()) if (ev.type === "compact") compactEvents.push(ev);
    })();
    await s.compact("keep it tight");
    await s.close();
    await reader;

    assert.equal(compactEvents.length, 1);
    const ce = compactEvents[0] as Extract<HarnessEvent, { type: "compact" }>;
    assert.equal(ce.trigger, "manual");
    assert.match(ce.summary ?? "", /SUMMARY: built the parser/);
    assert.ok(ce.before > 0 && ce.after > 0);

    const after = store.load("s1");
    assert.equal(after.length, 1);
    assert.match(JSON.stringify(after[0]), /built the parser/);
  } finally {
    cleanup();
  }
});

test("compact() emits a compact_progress heartbeat before the compact lands", async () => {
  const { store, cleanup } = env();
  try {
    const model = stepModel([textStep("SUMMARY: did the thing.")]);
    const s = await provider(() => model, store).createSession({
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "do a long thing",
      mode: "default",
      mcpServers: [],
    });
    await pump(s.events(), {});

    const seen: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const ev of s.events()) {
        if (ev.type === "compact_progress" || ev.type === "compact") seen.push(ev);
        if (ev.type === "compact") break;
      }
    })();
    await s.compact();
    await s.close();
    await reader;

    const beat = seen.find((e) => e.type === "compact_progress") as
      | Extract<HarnessEvent, { type: "compact_progress" }>
      | undefined;
    assert.ok(beat, "expected a compact_progress heartbeat");
    assert.ok(beat.before > 0);
    assert.ok(beat.elapsedMs >= 0);
    assert.ok(beat.generated >= 0);
    // the heartbeat precedes the boundary
    assert.ok(
      seen.findIndex((e) => e.type === "compact_progress") <
        seen.findIndex((e) => e.type === "compact"),
    );
  } finally {
    cleanup();
  }
});

test("a failed summariser emits a non-fatal error and leaves the transcript intact", async () => {
  const { store, cleanup } = env();
  try {
    // step 0 = the initial turn; step 1 = the summariser, which produces no text.
    const model = stepModel([textStep("did a thing"), textStep("")]);
    const s = await provider(() => model, store).createSession({
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "do a long thing",
      mode: "default",
      mcpServers: [],
    });
    await pump(s.events(), {});
    const before = store.load("s1");

    const seen: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const ev of s.events()) {
        seen.push(ev);
        if (ev.type === "error") break;
      }
    })();
    await s.compact();
    await s.close();
    await reader;

    const err = seen.find((e) => e.type === "error") as Extract<HarnessEvent, { type: "error" }>;
    assert.ok(err, "expected a non-fatal error");
    assert.equal(err.fatal, false);
    assert.ok(!seen.some((e) => e.type === "compact"), "no boundary on a failed compaction");
    assert.deepEqual(store.load("s1"), before, "transcript untouched");
  } finally {
    cleanup();
  }
});

/** Call #1 (the first turn) is instant; every later call (the summariser) drips
 *  its chunks slowly, so a test can `interrupt()` / `close()` mid-summarise. */
const slowSummariserModel = (): LanguageModel => {
  let n = 0;
  return new MockLanguageModelV2({
    doStream: async () => {
      n += 1;
      const chunks = n === 1 ? textStep("did a thing") : textStep("A SUMMARY of the work so far");
      return {
        stream: simulateReadableStream({
          chunks,
          initialDelayInMs: 0,
          ...(n === 1 ? {} : { chunkDelayInMs: 80 }),
        }),
      };
    },
  }) as unknown as LanguageModel;
};

test("interrupt() during a compaction abandons it and leaves the transcript intact (A2)", async () => {
  const { store, cleanup } = env();
  try {
    const s = await provider(slowSummariserModel, store).createSession({
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "do a long thing",
      mode: "default",
      mcpServers: [],
    });
    await pump(s.events(), {});
    const before = store.load("s1");

    const seen: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const ev of s.events()) seen.push(ev);
    })();

    const compacting = s.compact();
    await new Promise((r) => setTimeout(r, 60)); // let the summariser start streaming
    await s.interrupt();
    await compacting;

    assert.ok(!seen.some((e) => e.type === "compact"), "no compact boundary landed");
    const err = seen.find((e) => e.type === "error") as
      | Extract<HarnessEvent, { type: "error" }>
      | undefined;
    assert.ok(err && err.fatal === false, "a non-fatal cancellation error was emitted");
    assert.match(err.message, /cancel|left as-is|failed/i);
    assert.deepEqual(store.load("s1"), before, "transcript untouched");

    await s.close();
    await reader;
  } finally {
    cleanup();
  }
});

test("close() during a compaction returns promptly and commits nothing (A2)", async () => {
  const { store, cleanup } = env();
  try {
    const s = await provider(slowSummariserModel, store).createSession({
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "x",
      mode: "default",
      mcpServers: [],
    });
    await pump(s.events(), {});
    const before = store.load("s1");

    const seen: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const ev of s.events()) seen.push(ev);
    })();

    const compacting = s.compact();
    await new Promise((r) => setTimeout(r, 60));
    const t0 = Date.now();
    await s.close();
    assert.ok(Date.now() - t0 < 2000, "close() did not wait out the summariser");
    await compacting;
    await reader;

    assert.ok(!seen.some((e) => e.type === "compact"), "no compact boundary delivered");
    assert.deepEqual(store.load("s1"), before, "transcript untouched after close");
  } finally {
    cleanup();
  }
});

test("a bloated history auto-compacts before the next turn", async () => {
  const { store, cleanup } = env();
  try {
    const model = stepModel([textStep("compacted summary"), textStep("answer after compaction")]);
    const p = provider(() => model, store);
    // Seed a resume with a huge transcript (> 0.85 * 128k tokens ≈ 435k chars).
    const huge = "x".repeat(500_000);
    store.append("s1", [{ role: "user", content: huge }]);

    const s = await p.resumeSession({
      sessionId: "s1",
      providerRef: "s1",
      cwd: "/tmp",
      model: "m",
    });
    const seen: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const ev of s.events()) {
        seen.push(ev);
        if (ev.type === "result") break;
      }
    })();
    await s.send("continue");
    await reader;
    await s.close();

    const compact = seen.find((e) => e.type === "compact");
    assert.ok(compact, "expected an auto compact event");
    assert.equal((compact as { trigger: string }).trigger, "auto");
    // the compact happened before the turn's result
    assert.ok(seen.indexOf(compact!) < seen.findIndex((e) => e.type === "result"));
  } finally {
    cleanup();
  }
});

// --- sub-agents --------------------------------------------------------------

test("the task tool runs a sub-agent and reports start/stop with an agentId", async () => {
  const { dir, store, cleanup } = env();
  try {
    const model = stepModel([
      callStep(
        "t1",
        "task",
        JSON.stringify({ description: "survey the code", prompt: "list the modules" }),
      ),
      textStep("The sub-agent surveyed the code."),
    ]);
    // sub-agent's own streamText call gets the 2nd step; make it plain text.
    const s = await provider(() => model, store).createSession({
      sessionId: "s1",
      cwd: dir,
      prompt: "delegate a survey",
      mode: "default",
      mcpServers: [],
      loomServer: true,
    });

    const evs = await pump(s.events(), {
      onPerm: async (ev) => {
        await s.respondToPermission(ev.id, { behavior: "allow" });
      },
    });
    await s.close();

    const started = evs.find((e) => e.type === "subagent_started");
    const stopped = evs.find((e) => e.type === "subagent_stopped");
    assert.ok(started && stopped);
    assert.equal(
      (started as { subagentId: string }).subagentId,
      (stopped as { subagentId: string }).subagentId,
    );
    assert.equal((started as { name: string }).name, "survey the code");
    // the sub-agent's text was tagged with its agent id
    const tagged = evs.find((e) => e.type === "assistant_text" && e.agentId);
    assert.ok(tagged);
    assert.equal(
      (tagged as { agentId?: string }).agentId,
      (started as { subagentId: string }).subagentId,
    );
    assert.equal(evs.at(-1)?.type, "result");
  } finally {
    cleanup();
  }
});
