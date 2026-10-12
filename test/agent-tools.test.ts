/**
 * The `loom-agents` tools as each provider mounts them (docs/loom-agents.md):
 * which sessions get them, how a call reaches the daemon as an `agent_call`
 * and comes back, and how an agent profile's prompt and tool lists apply.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModel } from "ai";
import { setLogLevel } from "@loom/core/logger";
import type { HarnessEvent } from "@loom/core/events";
import { openDb } from "@loom/daemon/store/db";
import { ProviderMessageStore } from "@loom/daemon/store/provider-messages";
import { AisdkProvider } from "@loom/aisdk/provider";
import { ClaudeProvider, __setClaudeSdk } from "@loom/connector-claude/adapter";
import { localToolDispatcher } from "@loom/connector-chatgpt/tool-dispatch";
import {
  AGENT_TOOL_NAMES,
  AgentCalls,
  agentToolJsonSchema,
  isAgentTool,
} from "@loom/runtime/agent-tools";
import { decodeWorkerRequest } from "@loom/core/worker";
import { streamUsage } from "./usage-fixtures.ts";

setLogLevel("error");

type Chunk = LanguageModelV3StreamPart;

const toolCallStep = (id: string, name: string, input: string): Chunk[] => [
  { type: "stream-start", warnings: [] },
  { type: "response-metadata", id: `resp-${id}`, modelId: "mock", timestamp: new Date(0) },
  { type: "tool-input-start", id, toolName: name },
  { type: "tool-input-delta", id, delta: input },
  { type: "tool-input-end", id },
  { type: "tool-call", toolCallId: id, toolName: name, input },
  {
    type: "finish",
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: streamUsage({ noCache: 5, output: 3 }),
  },
];

const textStep = (text: string): Chunk[] => [
  { type: "stream-start", warnings: [] },
  { type: "response-metadata", id: "resp-t", modelId: "mock", timestamp: new Date(0) },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: undefined },
    usage: streamUsage({ noCache: 6, output: 4 }),
  },
];

const aisdkEnv = () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-agent-tools-"));
  const db = openDb(join(dir, "t.db"));
  db.prepare(
    "INSERT INTO sessions (id, provider, mode, created_at, updated_at) VALUES ('s1','openai','default',0,0)",
  ).run();
  const store = new ProviderMessageStore(db);
  return {
    dir,
    provider: (model: LanguageModel) =>
      new AisdkProvider({ id: "openai", model: "m", models: ["m"], makeModel: () => model }, store),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

test("agent calls park until answered, and an interrupt drains them", async () => {
  const calls = new AgentCalls();
  const emitted: string[] = [];
  const first = calls.call((id) => emitted.push(id));
  const second = calls.call((id) => emitted.push(id));
  assert.equal(emitted.length, 2);
  assert.ok(calls.resolve(emitted[0]!, { ok: true, text: "done" }));
  assert.ok(!calls.resolve(emitted[0]!, { ok: true, text: "again" }), "first answer wins");
  calls.failAll("(interrupted)");
  assert.deepEqual(await first, { ok: true, text: "done" });
  assert.deepEqual(await second, { ok: false, text: "(interrupted)" });
  // The names are what every provider mounts; each has an input schema.
  for (const name of AGENT_TOOL_NAMES) {
    assert.ok(isAgentTool(name));
    assert.equal(agentToolJsonSchema(name)["type"], "object");
  }
  assert.deepEqual(agentToolJsonSchema("agent_start")["required"], ["profile", "task", "title"]);
  // The worker protocol carries the answer back to a worker-hosted session.
  const answer = decodeWorkerRequest({
    kind: "request",
    id: 1,
    method: "respondToAgentCall",
    args: ["call-1", { ok: true, text: "started" }],
  });
  assert.equal(answer.method, "respondToAgentCall");
});

test("aisdk: an agent tool call reaches the daemon as agent_call and returns its answer", async () => {
  const env = aisdkEnv();
  try {
    let system = "";
    let n = 0;
    const steps = [toolCallStep("c1", "agent_status", "{}"), textStep("Two are working.")];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        const first = options.prompt[0];
        if (first?.role === "system") system = first.content;
        const chunks = steps[Math.min(n++, steps.length - 1)] ?? [];
        return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0 }) };
      },
    }) as unknown as LanguageModel;
    const s = await env.provider(model).createSession({
      sessionId: "s1",
      cwd: env.dir,
      prompt: "how are they doing?",
      mode: "default",
      mcpServers: [],
      loomServer: true,
      agentTools: true,
      systemPromptAppend: "steer",
      agentPrompt: "You coordinate.",
    });
    const evs: HarnessEvent[] = [];
    for await (const ev of s.events()) {
      evs.push(ev);
      if (ev.type === "agent_call") {
        assert.equal(ev.tool, "agent_status");
        void s.respondToAgentCall?.(ev.id, { ok: true, text: "2 working" });
      }
      if (ev.type === "result") break;
    }
    await s.close();
    assert.equal(system, "steer\n\nYou coordinate.");
    const result = evs.find((e) => e.type === "tool_result");
    assert.ok(result?.type === "tool_result" && result.ok);
    assert.match(JSON.stringify(result.output), /2 working/);
  } finally {
    env.cleanup();
  }
});

test("aisdk: the agent tools are mounted only when asked, and a profile's lists narrow the rest", async () => {
  const env = aisdkEnv();
  try {
    const offeredFor = async (opts: Record<string, unknown>): Promise<string[]> => {
      let offered: string[] = [];
      const model = new MockLanguageModelV3({
        doStream: async (options) => {
          offered = (options.tools ?? []).map((t) => t.name);
          return {
            stream: simulateReadableStream({ chunks: textStep("ok"), initialDelayInMs: 0 }),
          };
        },
      }) as unknown as LanguageModel;
      const s = await env.provider(model).createSession({
        sessionId: "s1",
        cwd: env.dir,
        prompt: "hi",
        mode: "default",
        mcpServers: [],
        loomServer: true,
        ...opts,
      });
      for await (const ev of s.events()) if (ev.type === "result") break;
      await s.close();
      return offered;
    };
    const plain = await offeredFor({});
    assert.ok(!plain.some((name) => isAgentTool(name)), "no agent tools unless asked");
    const narrowed = await offeredFor({
      agentTools: true,
      allowTools: ["bash"],
      denyTools: ["commit"],
    });
    assert.ok(narrowed.includes("bash"));
    assert.ok(!narrowed.includes("edit"), "builtins outside the allow list are withheld");
    assert.ok(!narrowed.includes("commit"), "denied by name");
    assert.ok(narrowed.includes("ask_user"), "Loom's own tools stay");
    for (const name of AGENT_TOOL_NAMES) assert.ok(narrowed.includes(name), `missing ${name}`);
  } finally {
    env.cleanup();
  }
});

const fakeQuery = () => {
  let stop = false;
  const iter = {
    [Symbol.asyncIterator]() {
      return iter;
    },
    async next(): Promise<IteratorResult<unknown, void>> {
      while (!stop) await delay(10);
      return { done: true, value: undefined };
    },
    async return(): Promise<IteratorResult<unknown, void>> {
      stop = true;
      return { done: true, value: undefined };
    },
  };
  return Object.assign(iter, {
    interrupt: async () => ({ still_queued: [] as string[] }),
    close: () => {
      stop = true;
    },
    setPermissionMode: async () => {},
    setModel: async () => {},
    applyFlagSettings: async () => {},
    initializationResult: () => new Promise(() => {}),
  });
};

/** A Claude config dir holding `pdf` (with a reference file) and `docx`. */
const mkSkillsProfile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "loom-skills-profile-"));
  for (const name of ["pdf", "docx"]) {
    mkdirSync(join(dir, "skills", name, "references"), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    writeFileSync(join(dir, "skills", name, "references", "notes.md"), name);
  }
  return dir;
};

test("claude: loom-agents is an in-process MCP server, and the profile's settings reach the query", async () => {
  const captured: Array<Record<string, unknown>> = [];
  __setClaudeSdk({
    query: (args) => {
      captured.push(args.options as Record<string, unknown>);
      return fakeQuery() as never;
    },
  });
  const configDir = mkSkillsProfile();
  const provider = new ClaudeProvider({ configDir });
  const profiled = {
    agentTools: true,
    agentPrompt: "You implement exactly the task you are given.",
    skills: ["pdf"],
    allowTools: ["Bash", "Read"],
    denyTools: ["WebFetch"],
  };
  const sessions = [
    await provider.createSession({
      sessionId: "plain",
      cwd: "/tmp",
      prompt: "go",
      mode: "default",
      mcpServers: [],
      loomServer: true,
      systemPromptAppend: "steer",
    }),
    await provider.createSession({
      sessionId: "agent",
      cwd: "/tmp",
      prompt: "go",
      mode: "default",
      mcpServers: [],
      loomServer: true,
      systemPromptAppend: "steer",
      ...profiled,
    }),
    await provider.resumeSession({
      sessionId: "agent",
      providerRef: "ref",
      cwd: "/tmp",
      systemPromptAppend: "steer",
      ...profiled,
    }),
  ];
  try {
    const [plain, created, resumed] = captured;
    assert.deepEqual(Object.keys(plain!.mcpServers as object), ["loom"]);
    assert.equal(plain!.tools, undefined);
    assert.equal(plain!.skills, undefined);
    assert.equal(plain!.plugins, undefined);
    for (const opts of [created!, resumed!]) {
      const servers = opts.mcpServers as Record<string, { type: string; name: string }>;
      assert.equal(servers["loom-agents"]?.type, "sdk");
      assert.equal(servers["loom-agents"]?.name, "loom-agents");
      assert.deepEqual(opts.systemPrompt, {
        type: "preset",
        preset: "claude_code",
        append: "steer\n\nYou implement exactly the task you are given.",
      });
      assert.deepEqual(opts.skills, ["pdf"]);
      const [plugin] = opts.plugins as Array<{ type: string; path: string }>;
      assert.equal(plugin!.type, "local");
      assert.deepEqual(
        JSON.parse(readFileSync(join(plugin!.path, ".claude-plugin/plugin.json"), "utf8")),
        { name: "loom" },
      );
      assert.equal(
        readFileSync(join(plugin!.path, "skills/pdf/references/notes.md"), "utf8"),
        "pdf",
      );
      assert.equal(existsSync(join(plugin!.path, "skills/docx")), false);
      assert.deepEqual(opts.tools, ["Bash", "Read"]);
      assert.deepEqual(opts.disallowedTools, ["Agent", "Task", "WebFetch"]);
    }
  } finally {
    for (const s of sessions) await s.close();
    rmSync(configDir, { recursive: true, force: true });
  }
  for (const opts of captured.slice(1))
    assert.equal(existsSync((opts.plugins as Array<{ path: string }>)[0]!.path), false);
});

test("claude: a profile skill missing from the config dir fails the start, naming where it looked", async () => {
  __setClaudeSdk({ query: () => fakeQuery() as never });
  const configDir = mkSkillsProfile();
  const provider = new ClaudeProvider({ configDir });
  try {
    await assert.rejects(
      provider.createSession({
        sessionId: "agent",
        cwd: "/tmp",
        prompt: "go",
        mode: "default",
        mcpServers: [],
        skills: ["pdf", "coding-style"],
      }),
      (error: Error) =>
        error.message.includes('"coding-style" not found') &&
        error.message.includes(join(configDir, "skills/coding-style/SKILL.md")),
    );
    await assert.rejects(
      provider.createSession({
        sessionId: "agent",
        cwd: "/tmp",
        prompt: "go",
        mode: "default",
        mcpServers: [],
        skills: ["../pdf"],
      }),
      /"\.\.\/pdf" is not a skill directory name/,
    );
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("codex: an agent tool is handed to the daemon, gated like commit when it changes something", async () => {
  const handed: string[] = [];
  const approvals: string[] = [];
  const ctx = (mode: "default" | "auto", allow: boolean) => ({
    mode,
    cwd: "/tmp",
    agentCall: async (tool: string) => {
      handed.push(tool);
      return { ok: true, text: `${tool} ran` };
    },
    requestApproval: async (tool: string) => {
      approvals.push(tool);
      return allow ? { behavior: "allow" as const } : { behavior: "deny" as const };
    },
  });
  assert.deepEqual(await localToolDispatcher("agent_status", {}, ctx("default", false)), {
    ok: true,
    text: "agent_status ran",
  });
  assert.deepEqual(approvals, [], "looking needs no approval");
  const denied = await localToolDispatcher("agent_start", {}, ctx("default", false));
  assert.equal(denied.ok, false);
  assert.deepEqual(approvals, ["agent_start"]);
  assert.deepEqual(handed, ["agent_status"], "a denied start never reaches the daemon");
  assert.ok((await localToolDispatcher("agent_start", {}, ctx("auto", false))).ok);
  assert.deepEqual(handed, ["agent_status", "agent_start"]);
  const unavailable = await localToolDispatcher("agent_start", {}, { mode: "auto", cwd: "/tmp" });
  assert.match(unavailable.text, /not available/);
});
