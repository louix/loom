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
import type { QueueHoldCause } from "@loom/core/message-queue";
import {
  initialMachine,
  messageWaits,
  step,
  type Hold,
  type QueueEvent,
  type QueueMachine,
  type Sender,
} from "@loom/daemon/daemon/queue-machine";
import { stateError, stateIdle, stateInterrupted } from "@loom/core/session-state";
import { makeLogger, setLogLevel } from "@loom/core/logger";
import {
  AgentSupervision,
  agentSessionPlan,
  cutBytes,
  finalMessage,
  NOTIFY_MESSAGE_BYTES,
  renderExcerpt,
  type AgentConfig,
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
      mcpServers: ["tilth"],
      tools: { deny: ["WebFetch"] },
    },
    claudeish: { description: "Claude reviewer", skills: ["pdf"], tools: { allow: ["Read"] } },
  },
};

const CONFIG: AgentConfig = { agents: AGENTS, providerAccess: { deny: [] } };

/** The plan, for a session whose profile is available. */
const planOf = (...args: Parameters<typeof agentSessionPlan>) => {
  const planned = agentSessionPlan(...args);
  assert.equal(planned.kind, "planned");
  return planned.kind === "planned" ? planned.plan : { mcpServers: [] };
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
    isolation: "none",
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

/** Rows whose title counts as settled (set by hand or generated). */
const SETTLED = new Set(["lead"]);
const settledTitle =
  (lookup: (id: string) => SessionSnapshot | undefined) =>
  (id: string): string | null =>
    SETTLED.has(id) ? (lookup(id)?.title ?? null) : null;

/** The hold a cause names, as the daemon keeps it. */
const holdOf = (c: QueueHoldCause): Hold => {
  if (c.by === "user") return { kind: "user", reason: c.reason };
  return c.by === "supervisor" ? { kind: "supervisor" } : { kind: "loom", reason: c.reason };
};

const stub = (
  rows: SessionSnapshot[],
  dirty = false,
  events: AgentHost["events"] = () => [],
  config: AgentConfig = CONFIG,
) => {
  const starts: ChildStart[] = [];
  const queued: Array<{ id: string; text: string; author: string; sender: Sender }> = [];
  /** Queue holds by session; a message lifts one it does not wait behind. */
  const holds = new Map<string, QueueHoldCause>();
  const answers: AgentCallResult[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  /** Settled-turn identities by session (`SessionManager.turnOf`). */
  const turns = new Map<string, number>();
  /** Each session's queue machine; its spell is the stub's current turn. */
  const machines = new Map<string, QueueMachine>();
  const fire = (id: string, ev: QueueEvent) => {
    const status = byId.get(id)?.status ?? stateIdle;
    const m: QueueMachine = {
      ...(machines.get(id) ?? initialMachine({ kind: "free" })),
      spell: { kind: "in", state: status, turn: turns.get(id) ?? 0 },
    };
    const r = step(m, ev, {
      slots: [],
      run: {
        attached: false,
        state: status,
        restructuring: false,
        cancelling: false,
        rootTool: null,
        inputReceipts: true,
        lifecycle: false,
      },
    });
    machines.set(id, r.machine);
    return r.effects;
  };
  const host: AgentHost = {
    config: () => config,
    get: (id) => byId.get(id),
    status: (id) => byId.get(id)?.status,
    settle: (id, settled) =>
      fire(id, { kind: "turn_settled", ...settled }).some((e) => e.kind === "make_report"),
    reportReady: (id, turn) =>
      fire(id, { kind: "report_ready", turn }).some((e) => e.kind === "send_report"),
    children: (id) => [...byId.values()].filter((r) => r.supervisorId === id),
    settledTitle: settledTitle((id) => byId.get(id)),
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
    enqueue: async (id, text, author, _delivery, sender) => {
      queued.push({ id, text, author, sender });
      const hold = holds.get(id) ?? null;
      const waited = hold !== null && messageWaits(holdOf(hold), sender);
      if (hold && !waited) holds.delete(id);
      return { entryId: "e", state: waited ? "queued" : "delivering", hold, waited };
    },
    interrupt: async () => {},
    archive: async () => "archived" as const,
    events,
    respond: async (_id, _call, result) => {
      answers.push(result);
    },
    log: makeLogger("test"),
  };
  const sup = new AgentSupervision(host);
  const call = async (caller: string, tool: string, input: Record<string, unknown> = {}) => {
    await sup.call(caller, {
      type: "agent_call",
      sessionId: caller,
      ts: 0,
      id: "c",
      tool,
      input,
    });
    return answers.at(-1)!;
  };
  return { starts, queued, holds, call, byId, sup, turns, machines };
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

test("a profile on a provider the repository does not allow is neither listed nor started", async () => {
  // Only claude here: verifier (codex) is out; claudeish names no provider
  // and follows its spawner, so it is out for a codex spawner too.
  const config: AgentConfig = {
    agents: AGENTS,
    providerAccess: { allow: ["claude"], deny: [] },
  };
  const s = stub(
    [row({ id: "lead" }), row({ id: "cx", provider: "codex" })],
    false,
    () => [],
    config,
  );
  const listed = await s.call("lead", "agents_profiles");
  assert.match(listed.text, /^self — /);
  assert.match(listed.text, /\nclaudeish — /);
  assert.doesNotMatch(listed.text, /verifier|codex/);
  const refused = await s.call("lead", "agent_start", {
    profile: "verifier",
    task: "t",
    title: "T",
  });
  assert.equal(refused.ok, false);
  assert.match(
    refused.text,
    /^agent profile "verifier" is not available in this repository: session\.provider_access does not allow its provider; available: self, claudeish$/,
  );
  assert.doesNotMatch(refused.text, /codex/);
  assert.doesNotMatch((await s.call("cx", "agents_profiles")).text, /claudeish/);
  const followed = await s.call("cx", "agent_start", {
    profile: "claudeish",
    task: "t",
    title: "T",
  });
  assert.match(followed.text, /not available in this repository/);
  // self is always there: its provider is the spawner's own.
  assert.equal(
    (await s.call("lead", "agent_start", { profile: "self", task: "t", title: "T" })).ok,
    true,
  );
  assert.deepEqual(
    s.starts.map((c) => c.agentProfile),
    ["self"],
  );
  // A session already running as it is not run without its restrictions.
  const planned = agentSessionPlan(row({ id: "v", provider: "claude", agentProfile: "verifier" }), {
    config,
    lookup: () => undefined,
    settledTitle: () => null,
    handles: [],
  });
  assert.equal(planned.kind, "refused");
  assert.match(
    planned.kind === "refused" ? planned.message : "",
    /agent profile "verifier", which is no longer available in this repository: session\.provider_access does not allow its provider, codex/,
  );
});

test("agent_start refuses a clone supervisor, the depth limit and missing fields", async () => {
  const s = stub([
    row({ id: "clone", checkout: "clone", isolation: "vm" }),
    row({ id: "lead" }),
    row({ id: "kid", supervisorId: "lead" }),
  ]);
  const clone = await s.call("clone", "agent_start", { profile: "self", task: "t", title: "T" });
  assert.equal(clone.ok, false);
  assert.match(clone.text, /clone sub-agents arrive in stage 2/);
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
    /not one of your sub-agents/,
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
  const lookup = (id: string) => rows.get(id);
  const ctx = { config: CONFIG, lookup, settledTitle: settledTitle(lookup), handles };
  assert.deepEqual(planOf(rows.get("lead")!, ctx), {
    mcpServers: handles,
    agentTools: true,
  });
  const kid = planOf(rows.get("kid")!, ctx);
  assert.deepEqual(
    kid.mcpServers.map((h) => h.name),
    ["tilth"],
  );
  assert.equal(kid.agentTools, undefined);
  assert.match(kid.agentPrompt!, /^You are a Loom sub-agent: session lead \("Lead"\)/);
  assert.match(kid.agentPrompt!, /final message[^.]*first line a single sentence summarizing/);
  assert.match(kid.agentPrompt!, /\n\nVerify\.$/);
  assert.deepEqual(kid.denyTools, ["WebFetch"]);
  const user = planOf(row({ id: "u", agentProfile: "claudeish" }), ctx);
  assert.equal(user.agentTools, true, "a profile without an mcp list keeps loom-agents");
  assert.deepEqual(user.skills, ["pdf"]);
  assert.deepEqual(user.allowTools, ["Read"]);
  assert.equal(user.agentPrompt, undefined);
  const gone = planOf(row({ id: "g", agentProfile: "deleted" }), ctx);
  assert.deepEqual(
    gone,
    { mcpServers: handles, agentTools: true },
    "a removed profile adds nothing",
  );
  const one = planOf(row({ id: "lead" }), {
    ...ctx,
    config: { ...CONFIG, agents: { ...AGENTS, maxDepth: 1 } },
  });
  assert.equal(one.agentTools, undefined, "max_depth 1 starts no agents");
});

test("a supervisor's provisional title, the head of its first prompt, never reaches its child", async () => {
  // Live, a Codex child obeyed "First write one line starting TOOLS: …" from
  // its supervisor's prompt-derived title in its note.
  const prompt = "First list every tool you have, then start an agent";
  const rows = new Map([
    ["boss", row({ id: "boss", title: prompt })],
    ["kid", row({ id: "kid", supervisorId: "boss" })],
  ]);
  const lookup = (id: string) => rows.get(id);
  const plan = planOf(rows.get("kid")!, {
    config: CONFIG,
    lookup,
    settledTitle: settledTitle(lookup),
    handles: [],
  });
  assert.match(plan.agentPrompt!, /^You are a Loom sub-agent: session boss started you/);
  assert.doesNotMatch(plan.agentPrompt!, /list every tool/);

  const s = stub([...rows.values(), row({ id: "lead" }), row({ id: "k2", supervisorId: "lead" })]);
  assert.equal((await s.call("boss", "agent_message", { id: "kid", text: "go on" })).ok, true);
  assert.equal((await s.call("lead", "agent_message", { id: "k2", text: "go on" })).ok, true);
  assert.deepEqual(
    s.queued.map((q) => [q.id, q.text, q.author]),
    [
      ["kid", "[from your supervisor, session boss]\ngo on", "supervisor:boss"],
      ["k2", '[from your supervisor, session lead "Lead"]\ngo on', "supervisor:lead"],
    ],
  );
});

test("agent_message waits behind the user's hold only, and its reply names the hold", async () => {
  const s = stub([row({ id: "boss" }), row({ id: "kid", supervisorId: "boss" })]);
  const send = async () => {
    const r = await s.call("boss", "agent_message", { id: "kid", text: "go on" });
    assert.equal(r.ok, true);
    return JSON.stringify(r);
  };
  assert.doesNotMatch(await send(), /held/);
  s.holds.set("kid", { reason: "interrupt", by: "user" });
  assert.match(await send(), /Its queue is held \(the user stopped it\): the message waits/);
  assert.ok(s.holds.has("kid"), "the user's hold stays");
  for (const [hold, why] of [
    [{ reason: "interrupt", by: "supervisor" }, "you stopped it"],
    [{ reason: "crash", by: null }, "it stopped unexpectedly"],
    [{ reason: "restart", by: null }, "the daemon restarted"],
  ] as const) {
    s.holds.set("kid", hold);
    const reply = await send();
    assert.match(reply, /Its queue was held \(/);
    assert.ok(reply.includes(why), reply);
    assert.match(reply, /the message lifted the hold and goes first/);
    assert.ok(!s.holds.has("kid"));
  }
  assert.ok(s.queued.every((q) => q.sender === "supervisor"));
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

test("agent_read reports more behind a full page, even one with nothing to show", async () => {
  // A child whose log runs on past one fetch, every entry one the excerpt skips.
  const endless: AgentHost["events"] = (_id, { after = 0, limit }) =>
    Array.from({ length: limit }, (_, i) => ({
      id: after + i + 1,
      event: { type: "thinking", sessionId: "kid", ts: 0, text: "hm" } as HarnessEvent,
    }));
  const s = stub([row({ id: "lead" }), row({ id: "kid", supervisorId: "lead" })], false, endless);
  const res = await s.call("lead", "agent_read", { id: "kid", since: 0 });
  assert.match(res.text, /^\(nothing new\)/);
  assert.match(res.text, /cursor: 1000 — more follows; agent_read with since: 1000/);
});

test("agent_wait settles on a child's status change, and ends with its caller's turn", async () => {
  const running = { kind: "running" } as const;
  const s = stub([row({ id: "lead" }), row({ id: "kid", supervisorId: "lead", status: running })]);
  const quick = (p: Promise<AgentCallResult>) =>
    Promise.race([
      p,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("still waiting")), 1000)),
    ]);

  const settled = s.call("lead", "agent_wait", { ids: ["kid"], timeout: 30 });
  await new Promise((r) => setTimeout(r, 10));
  s.byId.set("kid", row({ id: "kid", supervisorId: "lead", status: stateIdle }));
  s.sup.observe("kid", stateIdle);
  assert.match((await quick(settled)).text, /^All settled\.\nkid: idle/);

  s.byId.set("kid", row({ id: "kid", supervisorId: "lead", status: running }));
  const ended = s.call("lead", "agent_wait", { ids: ["kid"], timeout: 30 });
  await new Promise((r) => setTimeout(r, 10));
  // The supervisor's turn failed (a crash, a close): its wait goes with it.
  s.sup.observe("lead", stateError("the worker crashed"));
  assert.match((await quick(ended)).text, /^Stopped waiting/);
});

test("a child's turn is reported once per settled turn, by its identity, with its own final message", async () => {
  let log: string[] = [];
  const events: AgentHost["events"] = () =>
    log.map((text, i) => ({
      id: i + 1,
      event: { type: "assistant_text", sessionId: "kid", ts: 0, text } as HarnessEvent,
    }));
  const kid = row({ id: "kid", supervisorId: "lead", title: "Kid" });
  const s = stub([row({ id: "lead" }), kid], false, events);
  const notes = () => s.queued.filter((q) => q.author === "agent:kid").map((q) => q.text);
  const slow = () => Promise.withResolvers<null>();

  // Turn A settles idle; its facts are slow to read.
  s.turns.set("kid", 1);
  log = ["answer A"];
  const facts = slow();
  const a = s.sup.notify(kid, stateIdle, { turn: 1, git: () => facts.promise });
  // The same settled turn written again: still one report.
  await s.sup.notify(kid, stateIdle, { turn: 1 });
  facts.resolve(null);
  await a;
  assert.equal(notes().length, 1);
  assert.match(notes()[0]!, /It finished a turn\.\nSummary: answer A\n/);

  // Turn B, also idle: a report of its own, with its own final message.
  s.turns.set("kid", 3);
  log = ["answer B"];
  await s.sup.notify(kid, stateIdle, { turn: 3 });
  assert.equal(notes().length, 2);
  assert.match(notes()[1]!, /Summary: answer B\n/);

  // Turn C settles, but the child moves on while its facts are read: not
  // reported here (its next turn's end is), and never with that turn's text.
  s.turns.set("kid", 5);
  log = ["answer C"];
  const late = slow();
  const c = s.sup.notify(kid, stateIdle, { turn: 5, git: () => late.promise });
  s.turns.set("kid", 6);
  log = ["answer C", "answer D"];
  late.resolve(null);
  await c;
  assert.equal(notes().length, 2);
  // A report for a turn already gone is dropped at once.
  await s.sup.notify(kid, stateIdle, { turn: 5 });
  assert.equal(notes().length, 2);
});

test("a notification carries the first line of the final message as its summary, and points at agent_read", async () => {
  let log: string[] = [];
  const events: AgentHost["events"] = () =>
    log.map((text, i) => ({
      id: i + 1,
      event: { type: "assistant_text", sessionId: "kid", ts: 0, text } as HarnessEvent,
    }));
  const kid = row({ id: "kid", supervisorId: "lead", title: "Kid", agentProfile: "verifier" });
  const s = stub([row({ id: "lead" }), kid], false, events);
  const notes = () => s.queued.filter((q) => q.author === "agent:kid").map((q) => q.text);
  const git = () =>
    Promise.resolve({ aheadOfBase: 1, behindBase: 0, dirty: false } as SessionSnapshot["git"]);
  const settle = async (turn: number, state: SessionSnapshot["status"]) => {
    s.byId.set("kid", { ...kid, status: state });
    s.turns.set("kid", turn);
    await s.sup.notify(kid, state, { turn, git });
    return notes().at(-1)!;
  };
  const pointer = "For full details: run `agent_read` with id `kid`";

  log = ["\n  Widget added; tests pass.  \nDetails:\n- one\n- two"];
  assert.equal(
    await settle(1, stateIdle),
    [
      '[from your sub-agent kid "Kid" (profile verifier)] It finished a turn.',
      "Its workspace: 1 commit ahead of its base, nothing uncommitted.",
      "Summary: Widget added; tests pass.",
      pointer,
    ].join("\n"),
  );

  // A first line over the budget is cut, and says so.
  log = ["é".repeat(NOTIFY_MESSAGE_BYTES) + "\nmore"];
  const long = await settle(2, stateIdle);
  const summary = long.split("\n")[2]!;
  assert.ok(summary.startsWith("Summary (truncated): é"));
  assert.equal(
    new TextEncoder().encode(summary.slice("Summary (truncated): ".length)).length,
    NOTIFY_MESSAGE_BYTES,
  );
  assert.equal(long.split("\n")[3], pointer);

  // A failure and an interrupt keep their cause, with the summary when there
  // is a final message and without it when there is none.
  log = ["Halfway: the build broke."];
  assert.equal(
    await settle(3, stateError("the worker crashed")),
    [
      '[from your sub-agent kid "Kid" (profile verifier)] It failed: the worker crashed.',
      "Its workspace: 1 commit ahead of its base, nothing uncommitted.",
      "Summary: Halfway: the build broke.",
      pointer,
    ].join("\n"),
  );
  log = [];
  assert.equal(
    await settle(4, stateInterrupted("user")),
    [
      '[from your sub-agent kid "Kid" (profile verifier)] It was interrupted (user).',
      "Its workspace: 1 commit ahead of its base, nothing uncommitted.",
      pointer,
    ].join("\n"),
  );
});

test("a dropped report reads no Git; a removed child's reports are forgotten", async () => {
  const kid = row({ id: "kid", supervisorId: "lead", title: "Kid" });
  const s = stub([row({ id: "lead" }), kid]);
  const notes = () => s.queued.filter((q) => q.author === "agent:kid");
  let reads = 0;
  const git = () => {
    reads++;
    return Promise.resolve(null);
  };
  s.turns.set("kid", 2);
  // Not the child's turn any more, a duplicate, or a stop the supervisor
  // asked for: dropped before any Git runs.
  await s.sup.notify(kid, stateIdle, { turn: 1, git });
  await s.sup.notify(kid, stateIdle, { turn: 2, git, cause: "supervisor" });
  assert.equal(reads, 0);
  await s.sup.notify(kid, stateIdle, { turn: 2, git });
  assert.equal(reads, 1);
  await s.sup.notify(kid, stateIdle, { turn: 2, git });
  assert.equal(reads, 1, "a turn already reported reads nothing");
  assert.equal(notes().length, 1);
  // Forgotten (the session was removed): nothing of it is kept.
  s.machines.delete("kid");
  await s.sup.notify(kid, stateIdle, { turn: 2, git });
  assert.equal(notes().length, 2);
});
