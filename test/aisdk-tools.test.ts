import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { tool, type LanguageModel } from "ai";
import { z } from "zod";
import { setLogLevel, makeLogger } from "@loom/core/logger";
import { openDb } from "../src/store/db.ts";
import { ProviderMessageStore } from "../src/provider/aisdk/store.ts";
import { AisdkProvider } from "../src/provider/aisdk/adapter.ts";
import { McpHub } from "../src/provider/aisdk/mcp.ts";
import { isReadonly, isEdit, policy, wrapToolSet, PermissionDenied } from "../src/provider/aisdk/gate.ts";
import type { HarnessEvent } from "@loom/core/events";

setLogLevel("error");
const log = makeLogger("test");
const FAKE_MCP = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

// --- helpers -------------------------------------------------------------

type Chunk = LanguageModelV2StreamPart;

/** A model whose Nth call returns the Nth chunk list. */
function stepModel(steps: Chunk[][]): LanguageModel {
  let n = 0;
  return new MockLanguageModelV2({
    doStream: async () => {
      const chunks = steps[Math.min(n, steps.length - 1)] ?? [];
      n += 1;
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0 }) };
    },
  }) as unknown as LanguageModel;
}

function toolCallStep(id: string, name: string, input: string): Chunk[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: `resp-${id}`, modelId: "mock", timestamp: new Date(0) },
    { type: "tool-input-start", id, toolName: name },
    { type: "tool-input-delta", id, delta: input },
    { type: "tool-input-end", id },
    { type: "tool-call", toolCallId: id, toolName: name, input },
    { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
  ];
}

function textStep(text: string): Chunk[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "resp-t", modelId: "mock", timestamp: new Date(0) },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } },
  ];
}

function tmpEnv() {
  const dir = mkdtempSync(join(tmpdir(), "loom-tools-"));
  const db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO sessions (id, provider, mode, created_at, updated_at) VALUES ('s1','openai','default',0,0)").run();
  return {
    dir,
    db,
    store: new ProviderMessageStore(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function provider(make: () => LanguageModel, store: ProviderMessageStore): AisdkProvider {
  return new AisdkProvider(
    { id: "openai", model: "m", models: ["m"], makeModel: make },
    store,
  );
}

async function collect(
  events: AsyncIterable<HarnessEvent>,
  onPerm: ((ev: Extract<HarnessEvent, { type: "permission_request" }>) => void) | null,
  onQuestion: ((ev: Extract<HarnessEvent, { type: "question" }>) => void) | null,
): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const ev of events) {
    out.push(ev);
    if (ev.type === "permission_request" && onPerm) onPerm(ev);
    if (ev.type === "question" && onQuestion) onQuestion(ev);
    if (ev.type === "result" || (ev.type === "error" && ev.fatal)) break;
  }
  return out;
}

// --- MCP hub -----------------------------------------------------------------

test("McpHub connects to a stdio server, discovers + calls tools, and tears down", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-mcphub-"));
  try {
    const hub = await McpHub.connect(
      [{ name: "fake", spec: { transport: "stdio", command: process.execPath, args: [FAKE_MCP] } }],
      log,
    );
    assert.equal(hub.serverCount, 1);
    const names = Object.keys(hub.tools).sort();
    assert.deepEqual(names, ["echo_text", "write_note"]);

    const echo = hub.tools["echo_text"] as { execute: (i: unknown, c: unknown) => Promise<unknown> };
    const res = await echo.execute({ text: "hi there" }, { toolCallId: "x", messages: [] });
    assert.match(JSON.stringify(res), /hi there/);

    await hub.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("McpHub skips a server that fails to start instead of throwing", async () => {
  const hub = await McpHub.connect(
    [{ name: "broken", spec: { transport: "stdio", command: "this-command-does-not-exist-xyz", args: [] } }],
    log,
  );
  assert.equal(hub.serverCount, 0);
  assert.deepEqual(Object.keys(hub.tools), []);
  await hub.close();
});

// --- gate ------------------------------------------------------------------

test("gate name heuristics: readonly vs edit", () => {
  assert.equal(isReadonly("read_text_file"), true);
  assert.equal(isReadonly("list_directory"), true);
  assert.equal(isReadonly("fs__search_files"), true);
  assert.equal(isReadonly("ask_user"), true);
  assert.equal(isReadonly("write_file"), false);
  assert.equal(isEdit("write_file"), true);
  assert.equal(isEdit("edit_file"), true);
  assert.equal(isEdit("move_file"), true);
  assert.equal(isEdit("read_file"), false);
});

test("gate: `set` / `sync` as trailing nouns don't make a read tool an edit", () => {
  assert.equal(isEdit("get_result_set"), false);
  assert.equal(isEdit("get_sync_status"), false);
  assert.equal(isReadonly("get_result_set"), true);
  assert.equal(isReadonly("get_sync_status"), true);
});

test("gate: a name with both a read verb and a mutation verb is a mutator", () => {
  for (const n of [
    "search_and_replace",
    "find_and_replace",
    "get_or_create_file",
    "get_and_delete",
    "read_and_write",
    "mcp__fs__search_and_replace",
  ]) {
    assert.equal(isReadonly(n), false, `${n} must not be treated as read-only`);
    assert.equal(policy("default", n), "ask", `${n} must prompt in default mode`);
    assert.equal(policy("plan", n), "ask", `${n} must be gated in plan mode`);
  }
});

test("policy: auto allows all; default asks for non-readonly; acceptEdits allows edits", () => {
  assert.equal(policy("auto", "write_file"), "allow");
  assert.equal(policy("default", "read_file"), "allow");
  assert.equal(policy("default", "write_file"), "ask");
  assert.equal(policy("acceptEdits", "write_file"), "allow");
  assert.equal(policy("acceptEdits", "run_command"), "ask");
});

test("wrapToolSet: readonly runs unprompted; gated asks; denial throws PermissionDenied", async () => {
  const calls: string[] = [];
  const asked: string[] = [];
  const tools = {
    read_thing: tool({ description: "r", inputSchema: z.object({}), execute: async () => { calls.push("read"); return "ok"; } }),
    delete_thing: tool({ description: "d", inputSchema: z.object({}), execute: async () => { calls.push("delete"); return "gone"; } }),
  };
  let allow = true;
  const wrapped = wrapToolSet(tools, {
    mode: () => "default",
    ask: async (name) => {
      asked.push(name);
      return allow ? { allow: true } : { allow: false, message: "nope" };
    },
  }) as Record<string, { execute: (i: unknown, c: unknown) => Promise<unknown> }>;

  const ctx = { toolCallId: "c", messages: [] };
  const readThing = wrapped["read_thing"];
  const deleteThing = wrapped["delete_thing"];
  assert.ok(readThing && deleteThing);

  await readThing.execute({}, ctx);
  assert.deepEqual(asked, []); // readonly — never asked

  await deleteThing.execute({}, ctx);
  assert.deepEqual(asked, ["delete_thing"]);

  allow = false;
  await assert.rejects(() => deleteThing.execute({}, ctx), PermissionDenied);
  assert.deepEqual(calls, ["read", "delete"]); // the denied call never reached the tool
});

// --- session with tools ----------------------------------------------------

test("a gated MCP tool call emits permission_request; allow → tool runs → result", async () => {
  const { dir, db, store, cleanup } = tmpEnv();
  try {
    const notePath = join(dir, "note.txt");
    const model = stepModel([
      toolCallStep("c1", "write_note", JSON.stringify({ path: notePath, content: "from the model" })),
      textStep("Done — wrote the note."),
    ]);
    const p = provider(() => model, store);
    const s = await p.createSession({
      sessionId: "s1",
      cwd: dir,
      prompt: "write a note",
      mode: "default",
      mcpServers: [{ name: "fake", spec: { transport: "stdio", command: process.execPath, args: [FAKE_MCP] } }],
    });

    const perms: string[] = [];
    const evs = await collect(s.events(), (ev) => {
      perms.push(ev.tool);
      void s.respondToPermission(ev.id, { behavior: "allow" });
    }, null);
    await s.close();

    assert.deepEqual(perms, ["write_note"]);
    const tr = evs.find((e) => e.type === "tool_result");
    assert.equal((tr as { ok: boolean } | undefined)?.ok, true);
    assert.equal(evs.at(-1)?.type, "result");
    assert.equal(readFileSync(notePath, "utf8"), "from the model");

    // full exchange persisted
    assert.deepEqual(
      store.load("s1").map((m) => m.role),
      ["user", "assistant", "tool", "assistant"],
    );
    void db;
  } finally {
    cleanup();
  }
});

test("denying a gated tool call feeds the model a failed tool_result", async () => {
  const { dir, store, cleanup } = tmpEnv();
  try {
    const model = stepModel([
      toolCallStep("c1", "write_note", JSON.stringify({ path: join(dir, "x"), content: "y" })),
      textStep("Understood, leaving it."),
    ]);
    const p = provider(() => model, store);
    const s = await p.createSession({
      sessionId: "s1",
      cwd: dir,
      prompt: "write",
      mode: "default",
      mcpServers: [{ name: "fake", spec: { transport: "stdio", command: process.execPath, args: [FAKE_MCP] } }],
    });

    const evs = await collect(s.events(), (ev) => {
      void s.respondToPermission(ev.id, { behavior: "deny", message: "not this time" });
    }, null);
    await s.close();

    const tr = evs.find((e) => e.type === "tool_result");
    assert.equal((tr as { ok: boolean }).ok, false);
    assert.match(JSON.stringify((tr as { output: unknown }).output), /not this time/);
    assert.equal(evs.at(-1)?.type, "result");
  } finally {
    cleanup();
  }
});

test("the loom ask_user tool round-trips a question through the event stream", async () => {
  const { dir, store, cleanup } = tmpEnv();
  try {
    const model = stepModel([
      toolCallStep("c1", "ask_user", JSON.stringify({ question: "Which framework?" })),
      textStep("Great, using that."),
    ]);
    const p = provider(() => model, store);
    const s = await p.createSession({
      sessionId: "s1",
      cwd: dir,
      prompt: "help me pick",
      mode: "default",
      mcpServers: [],
      loomServer: true,
    });

    let asked = "";
    const evs = await collect(s.events(), null, (ev) => {
      asked = ev.question;
      void s.answerQuestion(ev.id, "Vercel AI SDK");
    });
    await s.close();

    assert.equal(asked, "Which framework?");
    assert.equal(evs.some((e) => e.type === "answer"), true);
    const tr = evs.find((e) => e.type === "tool_result");
    assert.match(JSON.stringify((tr as { output: unknown }).output), /Vercel AI SDK/);
    assert.equal(evs.at(-1)?.type, "result");
  } finally {
    cleanup();
  }
});

test("auto mode runs a gated tool without a permission_request", async () => {
  const { dir, store, cleanup } = tmpEnv();
  try {
    const notePath = join(dir, "n.txt");
    const model = stepModel([
      toolCallStep("c1", "write_note", JSON.stringify({ path: notePath, content: "auto" })),
      textStep("done"),
    ]);
    const p = provider(() => model, store);
    const s = await p.createSession({
      sessionId: "s1",
      cwd: dir,
      prompt: "go",
      mode: "auto",
      mcpServers: [{ name: "fake", spec: { transport: "stdio", command: process.execPath, args: [FAKE_MCP] } }],
    });
    const evs = await collect(s.events(), (ev) => {
      throw new Error(`unexpected permission_request for ${ev.tool}`);
    }, null);
    await s.close();
    assert.equal(evs.some((e) => e.type === "permission_request"), false);
    assert.equal(readFileSync(notePath, "utf8"), "auto");
  } finally {
    cleanup();
  }
});

test("a turn stuck calling tools auto-continues past the step ceiling, then stops with stopReason step_limit", async () => {
  const { dir, store, cleanup } = tmpEnv();
  try {
    // The model never stops calling a tool — every step ends on `tool-calls`.
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
              { type: "tool-call", toolCallId: `c${step}`, toolName: "echo_text", input: JSON.stringify({ text: `t${step}` }) },
              { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;
    // maxSteps 2 per segment; MAX_TURN_SEGMENTS is 5 → 10 model round-trips.
    const p = new AisdkProvider(
      { id: "openai", model: "m", models: ["m"], maxSteps: 2, makeModel: () => model },
      store,
    );
    const s = await p.createSession({
      sessionId: "s1",
      cwd: dir,
      prompt: "loop",
      mode: "auto",
      mcpServers: [{ name: "fake", spec: { transport: "stdio", command: process.execPath, args: [FAKE_MCP] } }],
    });

    const evs = await collect(s.events(), () => {}, null);
    await s.close();

    const result = evs.find((e) => e.type === "result") as Extract<HarnessEvent, { type: "result" }> | undefined;
    assert.equal(result?.ok, true);
    assert.equal(result?.stopReason, "step_limit");
    // a loud, non-fatal heads-up landed before the result
    assert.equal(evs.some((e) => e.type === "error" && !e.fatal && /loop/.test((e as { message: string }).message)), true);
    // exactly one completed turn; session stays usable
    assert.equal(s.snapshot().turns, 1);
    assert.equal(s.snapshot().status, "idle");
    // 5 segments × maxSteps 2
    assert.equal(step, 10);
  } finally {
    cleanup();
  }
});

test("resumeSession re-mounts the MCP servers from the ref", async () => {
  const { dir, store, cleanup } = tmpEnv();
  try {
    // Seed a prior transcript so resume has something to load.
    store.append("s1", [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "ok" },
    ]);

    const model = stepModel([
      toolCallStep("c1", "echo_text", JSON.stringify({ text: "still wired" })),
      textStep("done"),
    ]);
    const s = await provider(() => model, store).resumeSession({
      sessionId: "s1",
      providerRef: "s1",
      cwd: dir,
      mcpServers: [{ name: "fake", spec: { transport: "stdio", command: process.execPath, args: [FAKE_MCP] } }],
    });

    const reader = collect(s.events(), (ev) => void s.respondToPermission(ev.id, { behavior: "allow" }), null);
    await s.send("go"); // resume() doesn't auto-run; the first turn comes from send()
    const evs = await reader;
    await s.close();

    const tr = evs.find((e) => e.type === "tool_result");
    assert.ok(tr, "the resumed session could call the re-mounted MCP tool");
    assert.match(JSON.stringify((tr as { output: unknown }).output), /still wired/);
  } finally {
    cleanup();
  }
});
