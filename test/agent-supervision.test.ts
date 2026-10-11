/**
 * The rules in `agents.ts` against a stub daemon: what `agent_start` asks the
 * daemon for (workspace, isolation, profile settings), what it refuses, and
 * the plan a session runs with. The daemon end of it is
 * `loom-agents-daemon.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSnapshot, TranscriptEntry } from "@loom/core/wire";
import type { HarnessEvent } from "@loom/core/events";
import type { AgentCallResult, McpServerHandle } from "@loom/core/types";
import { stateIdle } from "@loom/core/session-state";
import { makeLogger, setLogLevel } from "@loom/core/logger";
import {
  AgentSupervision,
  agentSessionPlan,
  cutBytes,
  finalMessage,
  renderExcerpt,
  type AgentHost,
  type ChildStart,
} from "@loom/daemon/daemon/agents";
import type { LoomConfig } from "@loom/daemon/config/config";

setLogLevel("error");

const AGENTS: LoomConfig["agents"] = {
  maxDepth: 2,
  profiles: {
    verifier: {
      description: "Sceptical review",
      provider: "codex",
      model: "astra",
      prompt: "Verify.",
      mcp: ["tilth"],
      tools: { deny: ["WebFetch"] },
    },
    claudeish: { description: "Claude reviewer", skills: ["pdf"], tools: { allow: ["Read"] } },
  },
};

const row = (over: Partial<SessionSnapshot> & { id: string }): SessionSnapshot =>
  ({
    parentId: null,
    forkTurn: null,
    provider: "claude",
    model: "sonnet",
    effort: "high",
    mode: "auto",
    status: stateIdle,
    title: "Lead",
    comment: null,
    worktree: `/trees/${over.id}`,
    branch: `loom/${over.id}`,
    baseBranch: "main",
    inPlace: false,
    isolation: "local",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextUsed: 0,
    contextLimit: 0,
    costUsd: 0,
    costSource: "none",
    turns: 0,
    subagents: [],
    backgroundTasks: [],
    rateLimits: {},
    cache: { ttlMinutes: 0, ttlSource: "none", lastTurnAt: 0, lastRead: 0, lastWrite: 0 },
    keepWarm: false,
    canRewind: false,
    resumable: true,
    requests: [],
    git: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as SessionSnapshot;

const stub = (rows: SessionSnapshot[], dirty = false) => {
  const starts: ChildStart[] = [];
  const answers: AgentCallResult[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const host: AgentHost = {
    agents: () => AGENTS,
    get: (id) => byId.get(id),
    list: () => [...byId.values()],
    providerKnown: (id) => ["claude", "codex"].includes(id),
    defaultModel: (provider) => (provider === "codex" ? "codex-default" : null),
    defaultEffort: () => "medium",
    headBase: () => "main",
    repoRoot: "/repo",
    dirty: () => dirty,
    start: async (child) => {
      starts.push(child);
      const made = row({
        id: `child-${starts.length}`,
        provider: child.providerId,
        model: child.model,
        mode: child.mode,
        supervisorId: child.supervisorId,
        baseBranch: child.base,
      });
      byId.set(made.id, made);
      return made;
    },
    enqueue: async () => ({ entryId: "e", state: "queued" }),
    interrupt: async () => {},
    archive: async () => {},
    events: () => [],
    respond: async (_id, _call, result) => {
      answers.push(result);
    },
    log: makeLogger("test"),
  };
  const call = async (caller: string, tool: string, input: Record<string, unknown> = {}) => {
    await new AgentSupervision(host).call(caller, {
      type: "agent_call",
      sessionId: caller,
      ts: 0,
      id: "c",
      tool,
      input,
    });
    return answers.at(-1)!;
  };
  return { starts, call, byId };
};

test("a VM supervisor's child runs in a VM, in a worktree off the supervisor's branch", async () => {
  const s = stub([row({ id: "lead", isolation: "vm", mode: "plan" })]);
  const res = await s.call("lead", "agent_start", {
    profile: "verifier",
    task: "check commit abc",
    title: "Verify",
    task_id: "T",
  });
  assert.equal(res.ok, true, res.text);
  assert.deepEqual(s.starts[0], {
    prompt: "check commit abc",
    title: "Verify",
    providerId: "codex",
    model: "astra",
    effort: "medium",
    // A planning supervisor's child implements.
    mode: "default",
    base: "loom/lead",
    isolation: "vm",
    supervisorId: "lead",
    agentProfile: "verifier",
    taskId: "T",
  });
  assert.doesNotMatch(res.text, /uncommitted/);
});

test("self copies the supervisor; a clean supervisor gets no warning, a dirty one does", async () => {
  const s = stub([row({ id: "lead" })], true);
  const res = await s.call("lead", "agent_start", { profile: "self", task: "t", title: "T" });
  assert.equal(s.starts[0]?.providerId, "claude");
  assert.equal(s.starts[0]?.model, "sonnet");
  assert.equal(s.starts[0]?.effort, "high");
  assert.equal(s.starts[0]?.mode, "auto");
  assert.match(res.text, /Warning: you have uncommitted changes/);
});

test("agent_start refuses a clone supervisor, the depth limit and missing fields", async () => {
  const s = stub([
    row({ id: "clone", checkout: "clone", isolation: "vm" }),
    row({ id: "lead" }),
    row({ id: "kid", supervisorId: "lead" }),
  ]);
  const clone = await s.call("clone", "agent_start", { profile: "self", task: "t", title: "T" });
  assert.equal(clone.ok, false);
  assert.match(clone.text, /clone children arrive in stage 2/);
  const deep = await s.call("kid", "agent_start", { profile: "self", task: "t", title: "T" });
  assert.match(deep.text, /agents\.max_depth is 2 and this session is at depth 2/);
  assert.match(
    (await s.call("lead", "agent_start", { profile: "self", title: "T" })).text,
    /task is required/,
  );
  assert.match((await s.call("lead", "agent_frobnicate")).text, /unknown agent tool/);
  assert.equal(s.starts.length, 0);
});

test("a child is found by an unambiguous prefix of its id, and only among one's own", async () => {
  const s = stub([
    row({ id: "lead" }),
    row({ id: "other" }),
    row({ id: "abc111", supervisorId: "lead" }),
    row({ id: "abc222", supervisorId: "lead" }),
    row({ id: "xyz999", supervisorId: "other" }),
  ]);
  assert.match((await s.call("lead", "agent_status", { id: "abc1" })).text, /^abc111 "Lead"/);
  assert.match((await s.call("lead", "agent_status", { id: "abc" })).text, /more than one/);
  assert.match(
    (await s.call("lead", "agent_status", { id: "xyz999" })).text,
    /not one of your children/,
  );
  assert.match((await s.call("lead", "agent_status", { id: "nope" })).text, /no such session/);
  const all = await s.call("lead", "agent_status");
  assert.match(all.text, /abc111/);
  assert.match(all.text, /abc222/);
  assert.doesNotMatch(all.text, /xyz999/);
});

test("a session's plan: loom-agents below the depth limit, and its profile's servers, prompt and tools", () => {
  const handles: McpServerHandle[] = [
    { name: "tilth", spec: { transport: "stdio", command: "tilth" } },
    { name: "kagi", spec: { transport: "http", url: "https://mcp.kagi.com" } },
  ];
  const rows = new Map([
    ["lead", row({ id: "lead" })],
    ["kid", row({ id: "kid", supervisorId: "lead", agentProfile: "verifier" })],
  ]);
  const ctx = { agents: AGENTS, lookup: (id: string) => rows.get(id), handles };
  assert.deepEqual(agentSessionPlan(rows.get("lead")!, ctx), {
    mcpServers: handles,
    agentTools: true,
  });
  const kid = agentSessionPlan(rows.get("kid")!, ctx);
  assert.deepEqual(
    kid.mcpServers.map((h) => h.name),
    ["tilth"],
  );
  assert.equal(kid.agentTools, undefined);
  assert.match(kid.agentPrompt!, /^You are a Loom sub-agent: session lead \("Lead"\)/);
  assert.match(kid.agentPrompt!, /\n\nVerify\.$/);
  assert.deepEqual(kid.denyTools, ["WebFetch"]);
  const user = agentSessionPlan(row({ id: "u", agentProfile: "claudeish" }), ctx);
  assert.equal(user.agentTools, true, "a profile without an mcp list keeps loom-agents");
  assert.deepEqual(user.skills, ["pdf"]);
  assert.deepEqual(user.allowTools, ["Read"]);
  assert.equal(user.agentPrompt, undefined);
  const gone = agentSessionPlan(row({ id: "g", agentProfile: "deleted" }), ctx);
  assert.deepEqual(
    gone,
    { mcpServers: handles, agentTools: true },
    "a removed profile adds nothing",
  );
  const one = agentSessionPlan(row({ id: "lead" }), { ...ctx, agents: { ...AGENTS, maxDepth: 1 } });
  assert.equal(one.agentTools, undefined, "max_depth 1 starts no agents");
});

test("final message, excerpt bounds and byte cuts", () => {
  const ev = (e: Partial<HarnessEvent> & { type: HarnessEvent["type"] }) =>
    ({ sessionId: "s", ts: 0, ...e }) as HarnessEvent;
  const events = [
    ev({ type: "user_message", text: "go", injected: false }),
    ev({ type: "assistant_text", text: "looking" }),
    ev({ type: "tool_call", id: "t", name: "Bash", input: {} }),
    ev({ type: "tool_result", id: "t", ok: true, output: "" }),
    ev({ type: "assistant_text", text: "sub text", agentId: "sub" }),
    ev({ type: "assistant_text", text: "Done." }),
    ev({ type: "assistant_text", text: "Tests pass." }),
    ev({ type: "result", kind: "ok", summary: "ignored" }),
  ];
  assert.equal(finalMessage(events), "Done.\n\nTests pass.");
  assert.equal(finalMessage([ev({ type: "result", kind: "ok", summary: "only" })]), "only");
  const entries: TranscriptEntry[] = events.map((event, i) => ({ id: i + 1, event }));
  const all = renderExcerpt(entries);
  assert.equal(all.more, false);
  assert.equal(all.cursor, 8);
  assert.match(all.text, /^› user: go\n‹ looking\n⚙ Bash \{\}/);
  const tight = renderExcerpt(entries, 30);
  assert.equal(tight.more, true);
  assert.equal(tight.cursor, 2, "continues after the last entry shown");
  assert.deepEqual(cutBytes("héllo", 2), { text: "h", cut: true });
  assert.deepEqual(cutBytes("hello", 10), { text: "hello", cut: false });
});
