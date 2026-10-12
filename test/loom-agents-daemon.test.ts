/**
 * Loom agents end to end through the daemon (docs/loom-agents.md, stage 1),
 * against the fake provider: a supervisor's `loom-agents` calls start, steer,
 * read and stop children; children report back through the supervisor's
 * queue; and the supervision tree survives interrupts, archiving and restarts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test as nodeTest } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import type { SessionSnapshot } from "@loom/core/wire";
import { FakeProvider, type FakeSession } from "@loom/connector-mock";
import type { ConnectorContext } from "@loom/core/connector";
import { makeHarness, type Harness } from "@loom/harness";
import { WorktreeManager } from "@loom/daemon/daemon/worktrees";
import { shownStatusIn } from "@loom/tui/fleet-status";

const CONFIG = JSON.stringify({
  agents: {
    profiles: {
      implementer: {
        description: "Cheap; give it a specific, verifiable task",
        model: "fake-2",
        mode: "auto",
        prompt: "IMPLEMENT exactly the task.",
      },
      solo: { description: "Works alone", mcp_servers: { allow: [] } },
    },
  },
});

interface Env {
  h: Harness;
  c: LoomClient;
  provider: FakeProvider;
}

const withEnv = async (fn: (env: Env) => Promise<void>, config = CONFIG): Promise<void> => {
  const h = await makeHarness({ config });
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  try {
    const provider = (await h.daemon.providers.get("fake")) as FakeProvider;
    await fn({ h, c, provider });
  } finally {
    await c.close();
    await h.cleanup();
  }
};

const test = (name: string, fn: (env: Env) => Promise<void>) => nodeTest(name, () => withEnv(fn));

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 3000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start >= ms) throw new Error("condition not met in time");
    await delay(5);
  }
};

const get = (c: LoomClient, id: string) => c.request<SessionSnapshot>("session.get", { id });
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** A root session that has finished its opening turn. */
const idleSession = async (
  { c, provider }: Env,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; fs: FakeSession }> => {
  const snap = await c.request<SessionSnapshot>("session.create", {
    prompt: "lead the work",
    provider: "fake",
    ...extra,
  });
  await waitFor(() => provider.session(snap.id) !== undefined);
  const fs = provider.session(snap.id)!;
  fs.finishTurn();
  await waitFor(async () => (await get(c, snap.id)).status.kind === "idle");
  return { id: snap.id, fs };
};

const idOf = (text: string): string => {
  const m = /Started sub-agent ([0-9a-f-]{36})/.exec(text);
  assert.ok(m, `no id in: ${text}`);
  return m[1]!;
};

/** Start a child from `lead` and wait until its adapter exists. */
const startChild = async (
  env: Env,
  lead: FakeSession,
  input: Record<string, unknown> = {},
): Promise<{ id: string; fs: FakeSession; text: string }> => {
  const res = await lead.callAgentTool("agent_start", {
    profile: "implementer",
    task: "add the widget",
    title: "Widget",
    ...input,
  });
  assert.equal(res.ok, true, res.text);
  const id = idOf(res.text);
  await waitFor(() => env.provider.session(id) !== undefined);
  return { id, fs: env.provider.session(id)!, text: res.text };
};

/** Bring a child's opening turn to an end with `message` as its final text. */
const finish = async (env: Env, child: { id: string; fs: FakeSession }, message: string) => {
  child.fs.emit({ type: "assistant_text", text: message });
  child.fs.finishTurn();
  await waitFor(async () => (await get(env.c, child.id)).status.kind === "idle");
};

describe("loom agents", { concurrency: 4 }, () => {
  test("a supervisor starts a child on a profile, in a worktree off its own branch", async (env) => {
    const lead = await idleSession(env);
    const creates = env.provider.creates;
    assert.equal(creates[0]?.agentTools, true, "a root session gets loom-agents");
    assert.equal(creates[0]?.promptByHuman, true, "a user's opening prompt is a person's");
    const leadRow = await get(env.c, lead.id);
    // Committed work carries over; uncommitted work does not, and is warned of.
    writeFileSync(join(leadRow.worktree!, "done.txt"), "committed\n");
    git(leadRow.worktree!, "add", "done.txt");
    git(leadRow.worktree!, "commit", "-q", "-m", "lead work");
    writeFileSync(join(leadRow.worktree!, "wip.txt"), "uncommitted\n");

    const child = await startChild(env, lead.fs, { task_id: "T-1" });
    assert.match(child.text, /profile implementer/);
    assert.match(child.text, /uncommitted changes, and they do not carry over/);
    const row = await get(env.c, child.id);
    assert.equal(row.supervisorId, lead.id);
    assert.equal(row.parentId, null);
    assert.equal(row.agentProfile, "implementer");
    assert.equal(row.taskId, "T-1");
    assert.equal(row.title, "Widget");
    assert.equal(row.model, "fake-2");
    assert.equal(row.mode, "auto");
    assert.equal(row.baseBranch, leadRow.branch);
    assert.equal(row.isolation, leadRow.isolation);
    assert.notEqual(row.worktree, leadRow.worktree);
    assert.equal(
      git(row.worktree!, "rev-parse", "HEAD"),
      git(leadRow.worktree!, "rev-parse", "HEAD"),
    );
    assert.equal(git(row.worktree!, "status", "--porcelain"), "", "no uncommitted work came along");

    const opts = creates.find((o) => o.sessionId === child.id)!;
    assert.equal(opts.agentTools, undefined, "a child at agents.max_depth gets no loom-agents");
    assert.match(opts.agentPrompt ?? "", /You are a Loom sub-agent/);
    assert.match(opts.agentPrompt ?? "", /IMPLEMENT exactly the task\./);
    assert.equal(opts.prompt, "add the widget");
    assert.equal(opts.promptByHuman, undefined, "a task is the supervisor's, not a person's");

    // At the limit, a child cannot start agents of its own.
    const deeper = await child.fs.callAgentTool("agent_start", {
      profile: "self",
      task: "x",
      title: "x",
    });
    assert.equal(deeper.ok, false);
    assert.match(deeper.text, /agents\.max_depth is 2/);
    const unknown = await lead.fs.callAgentTool("agent_start", {
      profile: "nope",
      task: "x",
      title: "x",
    });
    assert.match(unknown.text, /no agent profile "nope"; available: self, implementer, solo/);
  });

  nodeTest("a profile on a provider the repository does not allow is offered nowhere", () =>
    withEnv(
      async (env) => {
        const state = env.c.getState();
        assert.equal(state.tag, "data");
        assert.deepEqual(
          (state.tag === "data" ? (state.value.agentProfiles ?? []) : []).map((p) => p.name),
          ["implementer"],
          "the new-session toggle is not offered it",
        );
        await assert.rejects(
          env.c.request("session.create", { prompt: "x", provider: "fake", profile: "mocked" }),
          /agent profile "mocked" is not available in this repository/,
        );
        const lead = await idleSession(env);
        const listed = await lead.fs.callAgentTool("agents_profiles");
        assert.match(listed.text, /^self — /);
        assert.match(listed.text, /\nimplementer — /);
        assert.doesNotMatch(listed.text, /mocked|mock\b/);
        const refused = await lead.fs.callAgentTool("agent_start", {
          profile: "mocked",
          task: "x",
          title: "x",
        });
        assert.equal(refused.ok, false);
        assert.match(refused.text, /not available in this repository/);
        const self = await startChild(env, lead.fs, { profile: "self" });
        assert.equal((await get(env.c, self.id)).provider, "fake");
      },
      JSON.stringify({
        session: { provider_access: { allow: ["fake"] } },
        agents: {
          profiles: {
            implementer: { description: "Follows its spawner" },
            mocked: { description: "On mock", provider: "mock", skills: ["pdf"] },
          },
        },
      }),
    ),
  );

  test("an in-place supervisor's children branch from the checked-out HEAD", async (env) => {
    const lead = await idleSession(env, { workspace: "in-place" });
    const child = await startChild(env, lead.fs, { profile: "self" });
    const row = await get(env.c, child.id);
    assert.equal(row.inPlace, false);
    assert.equal(row.baseBranch, "main");
    assert.equal(git(row.worktree!, "rev-parse", "HEAD"), git(env.h.repoRoot, "rev-parse", "HEAD"));
    assert.equal(row.agentProfile, "self");
    assert.equal(row.provider, "fake");
  });

  test("a profile without loom-agents starts no agents, and the profiles are listed", async (env) => {
    const solo = await idleSession(env, { profile: "solo" });
    const opts = env.provider.creates.find((o) => o.sessionId === solo.id)!;
    assert.equal(opts.agentTools, undefined);
    assert.equal((await get(env.c, solo.id)).agentProfile, "solo");
    const lead = await idleSession(env);
    const listed = await lead.fs.callAgentTool("agents_profiles");
    assert.match(
      listed.text,
      /^self — your own settings \(fake, mode default\), no extra prompt\./,
    );
    assert.match(
      listed.text,
      /implementer — Cheap; give it a specific, verifiable task \(fake-2, mode auto; the rest as yours\)/,
    );
    assert.match(listed.text, /cannot start sub-agents of their own \(agents\.max_depth 2\)/);
  });

  test("an archived session whose profile is gone is refused before its worktree comes back", async (env) => {
    // given: archived as "solo", which the config then drops
    const solo = await idleSession(env, { profile: "solo" });
    await env.c.request("session.markDone", { id: solo.id });
    const archived = await get(env.c, solo.id);
    assert.equal(archived.worktree, null);
    writeFileSync(
      env.h.configPath,
      JSON.stringify({ agents: { profiles: { implementer: { description: "Implements" } } } }),
    );
    await env.h.restart();
    const c = await LoomClient.connect({
      repoRoot: env.h.repoRoot,
      sockPath: env.h.sockPath,
      autospawn: false,
    });
    try {
      // when
      await assert.rejects(
        c.request("session.resume", { id: solo.id }),
        /agent profile "solo", which is no longer in the config/,
      );
      // then
      const after = await get(c, solo.id);
      assert.equal(after.worktree, null, "its worktree was not restored");
      assert.equal(after.status.kind, archived.status.kind);
    } finally {
      await c.close();
    }
  });

  test("a resume waiting for the session's lock is refused for a profile removed meanwhile", async (env) => {
    // given: a cold "solo" session whose lock a parked mode change holds
    const solo = await idleSession(env, { profile: "solo" });
    const release = solo.fs.blockMode();
    const setMode = solo.fs.setMode.bind(solo.fs);
    let parked = false;
    solo.fs.setMode = (mode) => {
      parked = true;
      return setMode(mode);
    };
    const moded = env.c.request("session.setMode", { id: solo.id, mode: "plan" });
    await waitFor(() => parked);
    solo.fs.endStream();
    await waitFor(() => env.h.daemon.sessions.isEnded(solo.id));
    const before = (await get(env.c, solo.id)).status.kind;
    const resumed = env.c.request("session.resume", { id: solo.id });
    await waitFor(async () => (await get(env.c, solo.id)).status.kind === "starting");
    // when: the config drops "solo" before the resume takes the lock
    writeFileSync(
      env.h.configPath,
      JSON.stringify({ agents: { profiles: { implementer: { description: "Implements" } } } }),
    );
    await waitFor(() => !("solo" in env.h.daemon.config.agents.profiles));
    release();
    // then
    await assert.rejects(resumed, /agent profile "solo", which is no longer in the config/);
    await moded;
    assert.equal((await get(env.c, solo.id)).status.kind, before);
    assert.ok(!env.provider.resumes.some((r) => r.sessionId === solo.id), "not resumed");
  });

  test("messages reach a child through its queue, labelled; only its supervisor may send them", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    await finish(env, child, "first pass done");
    const sent = await lead.fs.callAgentTool("agent_message", {
      id: child.id,
      text: "now add tests",
    });
    assert.equal(sent.ok, true, sent.text);
    await waitFor(() => child.fs.sends.some((s) => s.includes("now add tests")));
    const text = child.fs.sends.find((s) => s.includes("now add tests"))!;
    assert.match(text, new RegExp(`^\\[from your supervisor, session ${lead.id.slice(0, 8)}`));

    // Another session is not its supervisor, whatever it knows.
    const other = await idleSession(env);
    for (const [tool, input] of [
      ["agent_message", { id: child.id, text: "hi" }],
      ["agent_status", { id: child.id }],
      ["agent_read", { id: child.id }],
      ["agent_interrupt", { id: child.id }],
      ["agent_stop", { id: child.id }],
      ["agent_wait", { ids: [child.id], timeout: 1 }],
    ] as const) {
      const res = await other.fs.callAgentTool(tool, input);
      assert.equal(res.ok, false, tool);
      assert.match(res.text, /not one of your sub-agents/, tool);
    }
    assert.match((await other.fs.callAgentTool("agent_status")).text, /You have no sub-agents/);
  });

  test("a child's turn end wakes an idle supervisor with its final message", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    const before = lead.fs.sends.length;
    await finish(env, child, "Widget added; tests pass.");
    await waitFor(() => lead.fs.sends.length > before);
    const note = lead.fs.sends.at(-1)!;
    assert.match(note, new RegExp(`^\\[from your sub-agent ${child.id.slice(0, 8)} "Widget"`));
    assert.match(note, /It finished a turn\./);
    assert.match(note, /Its workspace: 0 commits ahead of its base, nothing uncommitted\./);
    assert.match(note, /\nSummary: Widget added; tests pass\.\n/);
    assert.match(note, new RegExp(`For full details: run \`agent_read\` with id \`${child.id}\`$`));
  });

  test("a supervisor stays idle while its agents run, so their reports still reach it", async (env) => {
    const lead = await idleSession(env);
    const first = await startChild(env, lead.fs, { title: "First" });
    const second = await startChild(env, lead.fs, { title: "Second" });
    const list = () => env.c.request<SessionSnapshot[]>("session.list");
    const busy = new Set(["starting", "running"]);
    await waitFor(async () => busy.has((await get(env.c, second.id)).status.kind));
    // The fleet shows it as background work; that is the TUI's reading alone.
    const shown = async () => {
      const all = await list();
      return shownStatusIn(all)(all.find((s) => s.id === lead.id)!);
    };
    assert.equal((await get(env.c, lead.id)).status.kind, "idle");
    assert.equal(await shown(), "working_background");
    const before = lead.fs.sends.length;
    await finish(env, first, "First part done.");
    await waitFor(() => lead.fs.sends.length > before);
    assert.match(lead.fs.sends.at(-1)!, /First part done\./);
    assert.ok(
      busy.has((await get(env.c, second.id)).status.kind),
      "delivered with one still running",
    );
    lead.fs.finishTurn();
    await waitFor(async () => (await get(env.c, lead.id)).status.kind === "idle");
    assert.equal((await get(env.c, lead.id)).queue?.entries.length ?? 0, 0);
    assert.equal(await shown(), "working_background");
  });

  test("a busy supervisor is not interrupted: the notification waits for its turn to end", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    // The supervisor is mid-turn when the child reports.
    await env.c.request("session.send", { id: lead.id, text: "keep going", by: "client" });
    await waitFor(() => lead.fs.sends.includes("keep going"));
    lead.fs.emit({ type: "assistant_text", text: "working" });
    await waitFor(async () => (await get(env.c, lead.id)).status.kind === "running");
    const long = "x".repeat(5000);
    await finish(env, child, long);
    await waitFor(async () => ((await get(env.c, lead.id)).queue?.entries.length ?? 0) > 0);
    const queued = (await get(env.c, lead.id)).queue!.entries[0]!;
    assert.equal(queued.delivery, "end_of_turn");
    assert.equal(queued.author, `agent:${child.id}`);
    assert.equal(lead.fs.interruptCount, 0);
    const sendsBefore = lead.fs.sends.length;
    lead.fs.finishTurn();
    await waitFor(() => lead.fs.sends.length > sendsBefore);
    const note = lead.fs.sends.at(-1)!;
    assert.ok(new TextEncoder().encode(note).length < 2600, "cut to about 2 KB");
    assert.match(note, /\nSummary \(truncated\): x+\n/);
    assert.match(note, new RegExp(`with id \`${child.id}\`$`));
  });

  test("a wait for input is not reported; failures are", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    const sendsBefore = lead.fs.sends.length;
    child.fs.emit({ type: "permission_request", id: "p1", tool: "Bash", input: { command: "rm" } });
    await waitFor(async () => (await get(env.c, child.id)).status.kind === "awaiting_input");
    // The user answers permissions, so the supervisor is not woken for one.
    await delay(50);
    assert.equal(lead.fs.sends.length, sendsBefore, "no notification for a wait");
    assert.equal((await get(env.c, lead.id)).status.kind, "idle");
    await env.c.request("session.respondPermission", {
      id: child.id,
      requestId: "p1",
      decision: "allow",
    });
    child.fs.emit({ type: "tool_result", id: "p1", ok: true, output: "" });
    child.fs.emit({ type: "result", kind: "error", error: "the build broke" });
    await waitFor(() => lead.fs.sends.some((s) => /It (failed|finished a turn)/.test(s)));
    lead.fs.finishTurn();
    await waitFor(async () => (await get(env.c, lead.id)).status.kind === "idle");
    child.fs.fail("the worker crashed");
    await waitFor(() => lead.fs.sends.some((s) => /It failed: the worker crashed/.test(s)));
  });

  test("status and read report a child, bounded", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs, { task_id: "T-9" });
    // Text the agent wrote along the way: more than one read returns.
    for (let i = 0; i < 12; i++) child.fs.emit({ type: "assistant_text", text: "y".repeat(2000) });
    for (let i = 0; i < 3; i++)
      child.fs.emit({ type: "tool_call", id: `t${i}`, name: "Bash", input: { command: "ls" } });
    await finish(env, child, "All done.");
    const status = await lead.fs.callAgentTool("agent_status");
    assert.match(status.text, new RegExp(`^${child.id} "Widget" · profile implementer · task T-9`));
    assert.match(status.text, /state: idle · 1 turn/);
    assert.match(status.text, /last message: All done\./);
    assert.match(status.text, /commits? ahead of its base/);

    const final = await lead.fs.callAgentTool("agent_read", { id: child.id.slice(0, 8) });
    assert.match(final.text, /^Final message of [0-9a-f]{8}:\nAll done\./);
    const fromStart = await lead.fs.callAgentTool("agent_read", { id: child.id, since: 0 });
    assert.match(fromStart.text, /› supervisor: add the widget/);
    assert.match(fromStart.text, /more follows; agent_read with since: \d+/);
    assert.ok(new TextEncoder().encode(fromStart.text).length < 17 * 1024, "bounded");
    const cursor = Number(/since: (\d+)/.exec(fromStart.text)![1]);
    const rest = await lead.fs.callAgentTool("agent_read", { id: child.id, since: cursor });
    assert.match(rest.text, /‹ All done\./);
    assert.match(rest.text, /up to date/);
  });

  test("interrupt, wait and stop act on the child", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    child.fs.emit({ type: "assistant_text", text: "busy" });
    await waitFor(async () => (await get(env.c, child.id)).status.kind === "running");
    const waited = await lead.fs.callAgentTool("agent_wait", { ids: [child.id], timeout: 1 });
    assert.match(waited.text, /^Timed out after 1s\./);
    const stopped = await lead.fs.callAgentTool("agent_interrupt", { id: child.id });
    assert.match(stopped.text, /^Interrupted/);
    assert.equal(child.fs.interruptCount, 1);
    const settled = await lead.fs.callAgentTool("agent_wait", { ids: [child.id], until: "any" });
    assert.match(settled.text, /^One settled\./);

    const row = await get(env.c, child.id);
    writeFileSync(join(row.worktree!, "wip.txt"), "uncommitted\n");
    const refused = await lead.fs.callAgentTool("agent_stop", { id: child.id });
    assert.equal(refused.ok, false);
    assert.match(
      refused.text,
      /uncommitted changes: message it to commit them, or call agent_stop with discard: true/,
    );
    const archived = await lead.fs.callAgentTool("agent_stop", { id: child.id, discard: true });
    assert.equal(archived.ok, true, archived.text);
    assert.equal((await get(env.c, child.id)).status.kind, "done");
    assert.equal(child.fs.closed, true);
  });

  test("interrupting a supervisor leaves its children running; closing it asks about them", async (env) => {
    const lead = await idleSession(env);
    const first = await startChild(env, lead.fs, { title: "One" });
    const second = await startChild(env, lead.fs, { title: "Two" });
    lead.fs.emit({ type: "assistant_text", text: "coordinating" });
    first.fs.emit({ type: "assistant_text", text: "busy" });
    await waitFor(async () => (await get(env.c, first.id)).status.kind === "running");
    await env.c.request("session.interrupt", { id: lead.id });
    assert.equal(first.fs.interruptCount, 0);
    assert.equal((await get(env.c, first.id)).status.kind, "running");

    await assert.rejects(
      env.c.request("session.markDone", { id: lead.id }),
      /supervises 2 open sub-agents: choose children "stop"/,
    );
    assert.notEqual((await get(env.c, lead.id)).status.kind, "done", "nothing happened");
    await env.c.request("session.markDone", { id: lead.id, children: "detach" });
    assert.equal((await get(env.c, lead.id)).status.kind, "done");
    for (const kid of [first, second]) {
      const row = await get(env.c, kid.id);
      assert.equal(row.supervisorId, undefined, "detached");
      assert.notEqual(row.status.kind, "done");
    }

    // Deleting a supervisor with "stop" archives its children.
    const boss = await idleSession(env);
    const third = await startChild(env, boss.fs, { title: "Three" });
    await env.c.request("session.remove", { id: boss.id, children: "stop" });
    assert.equal((await get(env.c, third.id)).status.kind, "done");
    assert.equal(third.fs.closed, true);
  });

  test("a restart keeps the tree, resumes children as agents, and keeps queued notifications", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    // The supervisor is busy, so the child's report waits in its queue.
    await env.c.request("session.send", { id: lead.id, text: "keep going", by: "client" });
    await waitFor(() => lead.fs.sends.includes("keep going"));
    lead.fs.emit({ type: "assistant_text", text: "working" });
    await waitFor(async () => (await get(env.c, lead.id)).status.kind === "running");
    await finish(env, child, "reported before the restart");
    await waitFor(async () => ((await get(env.c, lead.id)).queue?.entries.length ?? 0) > 0);

    await env.c.close();
    await env.h.restart();
    const c = await LoomClient.connect({
      repoRoot: env.h.repoRoot,
      sockPath: env.h.sockPath,
      autospawn: false,
    });
    try {
      const provider = (await env.h.daemon.providers.get("fake")) as FakeProvider;
      const row = await get(c, child.id);
      assert.equal(row.supervisorId, lead.id);
      const held = (await get(c, lead.id)).queue?.entries ?? [];
      assert.ok(
        held.some((e) => e.author === `agent:${child.id}`),
        "the notification persisted with the queue",
      );
      await c.request("session.send", { id: child.id, text: "carry on", by: "client" });
      await waitFor(() => provider.resumes.some((r) => r.sessionId === child.id));
      const resumed = provider.resumes.find((r) => r.sessionId === child.id)!;
      assert.match(resumed.agentPrompt ?? "", /You are a Loom sub-agent/);
      assert.equal(resumed.agentTools, undefined);
    } finally {
      await c.close();
      env.c = await LoomClient.connect({
        repoRoot: env.h.repoRoot,
        sockPath: env.h.sockPath,
        autospawn: false,
      });
    }
  });

  test("a supervisor is not woken by its own interrupt or stop; a user's interrupt is reported", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    const notes = () => lead.fs.sends.filter((s) => s.startsWith("[from your sub-agent"));
    child.fs.emit({ type: "assistant_text", text: "busy" });
    await waitFor(async () => (await get(env.c, child.id)).status.kind === "running");
    const interrupted = await lead.fs.callAgentTool("agent_interrupt", { id: child.id });
    assert.match(interrupted.text, /^Interrupted/);
    assert.equal((await get(env.c, child.id)).status.kind, "interrupted");

    await env.c.request("session.send", { id: child.id, text: "go on", by: "client" });
    await waitFor(() => child.fs.sends.includes("go on"));
    child.fs.emit({ type: "assistant_text", text: "busy again" });
    await waitFor(async () => (await get(env.c, child.id)).status.kind === "running");
    const stopped = await lead.fs.callAgentTool("agent_stop", { id: child.id, discard: true });
    assert.equal(stopped.ok, true, stopped.text);
    await delay(50);
    assert.deepEqual(notes(), [], "the supervisor's own stops wake nothing");

    // The user stopping one of its agents is news to the supervisor.
    const second = await startChild(env, lead.fs, { title: "Two" });
    second.fs.emit({ type: "assistant_text", text: "busy" });
    await waitFor(async () => (await get(env.c, second.id)).status.kind === "running");
    await env.c.request("session.interrupt", { id: second.id });
    await waitFor(() => notes().length > 0);
    assert.match(notes()[0]!, /"Two".*It was interrupted \(user\)\./);
  });

  test("a notification waits behind a held supervisor queue and does not release it", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    await env.c.request("session.send", { id: lead.id, text: "keep going", by: "client" });
    await waitFor(() => lead.fs.sends.includes("keep going"));
    lead.fs.emit({ type: "assistant_text", text: "working" });
    await waitFor(async () => (await get(env.c, lead.id)).status.kind === "running");
    await env.c.request("session.send", {
      id: lead.id,
      text: "then this",
      by: "client",
      delivery: "end_of_turn",
    });
    // The user stops the supervisor: what it had queued is held.
    await env.c.request("session.interrupt", { id: lead.id });
    await waitFor(async () => (await get(env.c, lead.id)).queue?.hold === "interrupt");
    const sendsBefore = lead.fs.sends.length;

    await finish(env, child, "Widget added.");
    await waitFor(async () => ((await get(env.c, lead.id)).queue?.entries.length ?? 0) === 2);
    await delay(50);
    const queue = (await get(env.c, lead.id)).queue!;
    assert.equal(queue.hold, "interrupt", "still held");
    assert.deepEqual(
      queue.entries.map((e) => e.author),
      ["client", `agent:${child.id}`],
      "behind the held message",
    );
    assert.equal(lead.fs.sends.length, sendsBefore, "no turn started");
    assert.equal((await get(env.c, lead.id)).status.kind, "interrupted");

    // The user releasing the queue lets both go, theirs first.
    await env.c.request("session.queueRelease", { id: lead.id });
    await waitFor(() => lead.fs.sends.length > sendsBefore);
    assert.equal(lead.fs.sends[sendsBefore], "then this");
  });

  test("a child is never nudged: its turn end reports its uncommitted work, once; a root is reminded", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    const notes = () => lead.fs.sends.filter((s) => s.startsWith("[from your sub-agent"));
    const reminded = (fs: FakeSession) =>
      fs.sends.some((s) => /uncommitted changes in your worktree/.test(s));
    writeFileSync(join((await get(env.c, child.id)).worktree!, "wip.txt"), "uncommitted\n");
    let waited: string | null = null;
    void lead.fs
      .callAgentTool("agent_wait", { ids: [child.id], timeout: 30 })
      .then((r) => (waited = r.text));
    await delay(20);
    await finish(env, child, "Widget added; tests pass.");
    await waitFor(() => notes().length > 0 && waited !== null);
    await delay(50);
    assert.match(waited!, /^All settled\./);
    assert.equal(reminded(child.fs), false, "no commit reminder for a child");
    assert.equal((await get(env.c, child.id)).status.kind, "idle");
    assert.equal(notes().length, 1);
    assert.match(
      notes()[0]!,
      /It finished a turn\.\nIts workspace: 0 commits ahead of its base, uncommitted changes\.\nSummary: Widget added; tests pass\.\nFor full details: /,
    );

    // The supervisor, a root session, is still reminded of its own.
    writeFileSync(join((await get(env.c, lead.id)).worktree!, "wip.txt"), "uncommitted\n");
    lead.fs.finishTurn();
    await waitFor(() => reminded(lead.fs));
  });

  test("a user's stop holds a supervisor with nothing queued: a child's report waits for release", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    await env.c.request("session.send", { id: lead.id, text: "keep going", by: "client" });
    await waitFor(() => lead.fs.sends.includes("keep going"));
    lead.fs.emit({ type: "assistant_text", text: "working" });
    await waitFor(async () => (await get(env.c, lead.id)).status.kind === "running");
    // Nothing queued: the user's stop holds the queue all the same.
    await env.c.request("session.interrupt", { id: lead.id });
    assert.deepEqual((await get(env.c, lead.id)).queue, {
      hold: "interrupt",
      holdBy: "user",
      entries: [],
    });
    const sendsBefore = lead.fs.sends.length;

    await finish(env, child, "Widget added.");
    await waitFor(async () => ((await get(env.c, lead.id)).queue?.entries.length ?? 0) === 1);
    await delay(50);
    assert.equal(lead.fs.sends.length, sendsBefore, "the stopped supervisor stays stopped");
    assert.equal((await get(env.c, lead.id)).status.kind, "interrupted");

    await env.c.request("session.queueRelease", { id: lead.id });
    await waitFor(() => lead.fs.sends.length > sendsBefore);
    assert.match(lead.fs.sends.at(-1)!, /^\[from your sub-agent [\s\S]*Widget added\./);
  });

  test("a cold, held supervisor is not revived by a report; releasing it revives it and delivers", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    lead.fs.emit({ type: "assistant_text", text: "working" });
    await waitFor(async () => (await get(env.c, lead.id)).status.kind === "running");
    await env.c.request("session.interrupt", { id: lead.id });
    // Its adapter goes away: the supervisor is cold.
    lead.fs.endStream();
    await delay(50);

    await finish(env, child, "Widget added.");
    await waitFor(async () => ((await get(env.c, lead.id)).queue?.entries.length ?? 0) === 1);
    await delay(50);
    assert.ok(!env.provider.resumes.some((r) => r.sessionId === lead.id), "not revived");

    await env.c.request("session.queueRelease", { id: lead.id });
    await waitFor(() => env.provider.resumes.some((r) => r.sessionId === lead.id));
    await waitFor(() => env.provider.session(lead.id) !== lead.fs);
    const revived = env.provider.session(lead.id)!;
    await waitFor(() => revived.sends.some((s) => s.startsWith("[from your sub-agent")));
    assert.equal((await get(env.c, lead.id)).queue, undefined);
  });

  test("a hold set while a cold supervisor comes back for a report still holds the report", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    lead.fs.endStream();
    await delay(50);
    const unblock = env.provider.blockResume();
    await finish(env, child, "Widget added.");
    await waitFor(() => env.provider.resumes.some((r) => r.sessionId === lead.id));
    // The user stops the supervisor while it is coming back.
    env.h.daemon.sessions.holdForStop(lead.id, "user");
    unblock();
    await waitFor(async () => ((await get(env.c, lead.id)).queue?.entries.length ?? 0) === 1);
    await delay(50);
    const queue = (await get(env.c, lead.id)).queue!;
    assert.equal(queue.hold, "interrupt", "the report did not release it");
    assert.deepEqual(env.provider.session(lead.id)!.sends, [], "no turn started");
  });

  test("a supervisor's message waits behind a hold the user set on its child", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    child.fs.emit({ type: "assistant_text", text: "busy" });
    await waitFor(async () => (await get(env.c, child.id)).status.kind === "running");
    await env.c.request("session.interrupt", { id: child.id });
    assert.equal((await get(env.c, child.id)).queue?.hold, "interrupt");

    const sent = await lead.fs.callAgentTool("agent_message", { id: child.id, text: "go on" });
    assert.equal(sent.ok, true, sent.text);
    assert.match(sent.text, /Its queue is held \(the user stopped it\)/);
    await delay(50);
    const queue = (await get(env.c, child.id)).queue!;
    assert.equal(queue.hold, "interrupt", "the supervisor did not lift the user's stop");
    assert.equal(queue.holdBy, "user");
    assert.deepEqual(
      queue.entries.map((e) => e.author),
      [`supervisor:${lead.id}`],
    );
    assert.ok(!child.fs.sends.some((s) => s.includes("go on")), "no turn started");

    await env.c.request("session.queueRelease", { id: child.id });
    await waitFor(() => child.fs.sends.some((s) => s.includes("go on")));
  });

  test("a supervisor's message lifts the hold its own stop set, and goes first", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    child.fs.emit({ type: "assistant_text", text: "busy" });
    await waitFor(async () => (await get(env.c, child.id)).status.kind === "running");
    await env.c.request("session.send", { id: child.id, text: "later", delivery: "end_of_turn" });
    const stopped = await lead.fs.callAgentTool("agent_interrupt", { id: child.id });
    assert.equal(stopped.ok, true, stopped.text);
    const held = (await get(env.c, child.id)).queue!;
    assert.equal(held.hold, "interrupt");
    assert.equal(held.holdBy, "supervisor", "the supervisor's stop, not the user's");

    const sent = await lead.fs.callAgentTool("agent_message", { id: child.id, text: "go on" });
    assert.equal(sent.ok, true, sent.text);
    assert.match(sent.text, /Its queue was held \(you stopped it\): the message lifted the hold/);
    await waitFor(() => child.fs.sends.some((s) => s.includes("go on")));
    assert.ok(!child.fs.sends.includes("later"), "the held message waits for the next finish");
    assert.equal((await get(env.c, child.id)).queue?.hold, null);
    child.fs.finishTurn();
    await waitFor(() => child.fs.sends.includes("later"));
  });

  test("a user's stop joining a supervisor's makes the hold the user's", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    child.fs.emit({ type: "assistant_text", text: "busy" });
    await waitFor(async () => (await get(env.c, child.id)).status.kind === "running");
    await env.c.request("session.send", { id: child.id, text: "later", delivery: "end_of_turn" });
    await lead.fs.callAgentTool("agent_interrupt", { id: child.id });
    assert.equal((await get(env.c, child.id)).queue?.holdBy, "supervisor");
    // A stop on a settled session holds all the same, and takes the hold over.
    env.h.daemon.sessions.holdForStop(child.id, "user");
    assert.equal((await get(env.c, child.id)).queue?.holdBy, "user");
    const sent = await lead.fs.callAgentTool("agent_message", { id: child.id, text: "go on" });
    assert.match(sent.text, /Its queue is held \(the user stopped it\)/);
    await delay(50);
    assert.ok(!child.fs.sends.some((s) => s.includes("go on")));
  });

  test("H7: a child's report to a busy supervisor is queued, not lost, and goes once it is not", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    const notes = () => lead.fs.sends.filter((s) => s.startsWith("[from your sub-agent"));
    // As while a clone supervisor's guest Git runs (a turn-end sync).
    env.h.daemon.sessions.setBusy(lead.id, true);
    await finish(env, child, "Widget added.");
    await waitFor(async () => ((await get(env.c, lead.id)).queue?.entries.length ?? 0) === 1);
    await delay(50);
    assert.deepEqual(notes(), [], "nothing goes while busy");
    env.h.daemon.sessions.setBusy(lead.id, false);
    await waitFor(() => notes().length === 1);
    assert.match(notes()[0]!, /Widget added\./);
  });

  test("H7: a supervisor's message to a busy child waits instead of failing", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    await finish(env, child, "Done.");
    env.h.daemon.sessions.setBusy(child.id, true);
    const sent = await lead.fs.callAgentTool("agent_message", { id: child.id, text: "go on" });
    assert.equal(sent.ok, true, sent.text);
    await delay(50);
    assert.ok(!child.fs.sends.some((s) => s.includes("go on")));
    env.h.daemon.sessions.setBusy(child.id, false);
    await waitFor(() => child.fs.sends.some((s) => s.includes("go on")));
  });

  test("a supervisor's message recovers a crashed child: it lifts the crash hold and revives it", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    child.fs.emit({ type: "assistant_text", text: "busy" });
    await waitFor(async () => (await get(env.c, child.id)).status.kind === "running");
    await env.c.request("session.send", { id: child.id, text: "later", delivery: "end_of_turn" });
    // The adapter goes away by itself, a message waiting: a crash hold.
    child.fs.endStream();
    await waitFor(async () => (await get(env.c, child.id)).queue?.hold === "crash");
    assert.equal((await get(env.c, child.id)).queue?.holdBy, undefined, "no one's stop");

    const sent = await lead.fs.callAgentTool("agent_message", { id: child.id, text: "go on" });
    assert.equal(sent.ok, true, sent.text);
    assert.match(sent.text, /Its queue was held \(it stopped unexpectedly\)/);
    await waitFor(() => env.provider.resumes.some((r) => r.sessionId === child.id));
    await waitFor(() => env.provider.session(child.id) !== child.fs);
    const revived = env.provider.session(child.id)!;
    await waitFor(() => revived.sends.some((s) => s.includes("go on")));
    assert.equal((await get(env.c, child.id)).queue?.hold ?? null, null);
  });

  test("archiving a supervisor holds its queue before the close: a report meanwhile waits", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let closing = false;
    const close = lead.fs.close.bind(lead.fs);
    lead.fs.close = async () => {
      closing = true;
      await gate;
      await close();
    };
    const archiving = env.c.request("session.markDone", { id: lead.id, children: "detach" });
    await waitFor(() => closing);
    await finish(env, child, "Widget added.");
    await waitFor(async () => ((await get(env.c, lead.id)).queue?.entries.length ?? 0) === 1);
    await delay(50);
    release();
    await archiving;
    const row = await get(env.c, lead.id);
    assert.equal(row.status.kind, "done");
    assert.equal(row.queue?.hold, "interrupt");
    assert.equal(row.queue?.holdBy, "user");
    assert.ok(!lead.fs.sends.some((s) => s.startsWith("[from your sub-agent")), "not handed over");
    assert.ok(!env.provider.resumes.some((r) => r.sessionId === lead.id), "not revived");
  });

  nodeTest("a VM stop holds a supervisor before it closes: a report meanwhile waits", async () => {
    let lifecycle: NonNullable<ConnectorContext["vmLifecycle"]> | undefined;
    const provider = new FakeProvider();
    const h = await makeHarness({
      config: CONFIG,
      connectors: {
        "@loom/connector-mock": async () => ({
          createProvider: (ctx) => {
            lifecycle = ctx.vmLifecycle;
            return provider;
          },
        }),
      },
    });
    const c = await LoomClient.connect({
      repoRoot: h.repoRoot,
      sockPath: h.sockPath,
      autospawn: false,
    });
    try {
      const env: Env = { h, c, provider };
      const lead = await idleSession(env);
      const child = await startChild(env, lead.fs);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let closing = false;
      const close = lead.fs.close.bind(lead.fs);
      lead.fs.close = async () => {
        closing = true;
        await gate;
        await close();
      };
      assert.ok(lifecycle);
      const stopping = lifecycle.stop(lead.id, () => true);
      await waitFor(() => closing);
      await finish(env, child, "Widget added.");
      await delay(50);
      release();
      await stopping;
      await waitFor(async () => ((await get(c, lead.id)).queue?.entries.length ?? 0) === 1);
      await delay(50);
      const row = await get(c, lead.id);
      assert.equal(row.status.kind, "interrupted");
      assert.equal(row.queue?.hold, "interrupt");
      assert.equal(row.queue?.entries[0]?.author, `agent:${child.id}`);
      assert.ok(
        !lead.fs.sends.some((s) => s.startsWith("[from your sub-agent")),
        "not handed over",
      );
      assert.ok(!provider.resumes.some((r) => r.sessionId === lead.id), "not revived");
    } finally {
      await c.close();
      await h.cleanup();
    }
  });

  nodeTest(
    "plan windows are judged once per account per client snapshot build, never for an agent's reads",
    async () => {
      const provider = new FakeProvider();
      const h = await makeHarness({
        config: CONFIG,
        connectors: {
          "@loom/connector-claude": async () => ({ createProvider: () => provider }),
        },
      });
      const c = await LoomClient.connect({
        repoRoot: h.repoRoot,
        sockPath: h.sockPath,
        autospawn: false,
      });
      try {
        const env: Env = { h, c, provider };
        const lead = await idleSession(env, { provider: "claude" });
        const child = await startChild(env, lead.fs);
        assert.equal((await get(c, child.id)).provider, "claude", "one account for both");
        const store = h.daemon.registry.store;
        const judged: string[] = [];
        const real = store.planUsageState.bind(store);
        store.planUsageState = (scope, now) => {
          judged.push(scope);
          return real(scope, now);
        };
        // Let the startups' own snapshot builds finish: under load they trail on.
        for (let seen = -1; seen !== judged.length;) {
          seen = judged.length;
          await delay(50);
        }
        judged.length = 0;
        // Two sessions on one account: one judgement per build.
        await c.request("session.list", {});
        assert.equal(judged.length, 1);
        await get(c, lead.id);
        assert.equal(judged.length, 2);
        // A supervisor reading its children is the daemon's own read.
        judged.length = 0;
        const status = await lead.fs.callAgentTool("agent_status");
        assert.equal(status.ok, true, status.text);
        assert.deepEqual(judged, [], "agent_status judges nothing");
        const read = await lead.fs.callAgentTool("agent_read", { id: child.id });
        assert.equal(read.ok, true, read.text);
        assert.deepEqual(judged, [], "agent reads judge nothing");
      } finally {
        await c.close();
        await h.cleanup();
      }
    },
  );

  test("a user's interrupt joining the supervisor's own is reported", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    const notes = () => lead.fs.sends.filter((s) => s.startsWith("[from your sub-agent"));
    child.fs.emit({ type: "assistant_text", text: "busy" });
    await waitFor(async () => (await get(env.c, child.id)).status.kind === "running");
    let stop!: () => void;
    child.fs.interrupt = () => new Promise<void>((resolve) => (stop = resolve));
    const bySupervisor = lead.fs.callAgentTool("agent_interrupt", { id: child.id });
    await waitFor(() => stop !== undefined);
    const byUser = env.c.request("session.interrupt", { id: child.id });
    await delay(20);
    stop();
    await Promise.all([bySupervisor, byUser]);
    const row = await get(env.c, child.id);
    assert.deepEqual(row.status, { kind: "interrupted", by: "user" });
    await waitFor(() => notes().length > 0);
    assert.match(notes()[0]!, /It was interrupted \(user\)\./);
  });

  test("what a supervisor's stop ends in is its own, however late it lands", async (env) => {
    const lead = await idleSession(env);
    const notes = () => lead.fs.sends.filter((s) => s.startsWith("[from your sub-agent"));
    // An interrupt the adapter reports a failure for after it settled.
    const first = await startChild(env, lead.fs, { title: "One" });
    first.fs.emit({ type: "assistant_text", text: "busy" });
    await waitFor(async () => (await get(env.c, first.id)).status.kind === "running");
    await lead.fs.callAgentTool("agent_interrupt", { id: first.id });
    assert.deepEqual((await get(env.c, first.id)).status, {
      kind: "interrupted",
      by: "supervisor",
    });
    first.fs.fail("turn cancelled");
    await waitFor(async () => (await get(env.c, first.id)).status.kind === "error");

    // A stop whose closing stream ends in an error.
    const second = await startChild(env, lead.fs, { title: "Two" });
    second.fs.emit({ type: "assistant_text", text: "busy" });
    await waitFor(async () => (await get(env.c, second.id)).status.kind === "running");
    const close = second.fs.close.bind(second.fs);
    second.fs.close = async () => {
      second.fs.fail("worker torn down");
      await delay(10);
      await close();
    };
    const stopped = await lead.fs.callAgentTool("agent_stop", { id: second.id, discard: true });
    assert.equal(stopped.ok, true, stopped.text);
    await delay(100);
    assert.deepEqual(notes(), [], "neither reaches the supervisor");
  });

  test("a user's interrupt of a child still starting reaches its supervisor", async (env) => {
    const lead = await idleSession(env);
    const release = env.provider.blockCreate();
    const started = lead.fs.callAgentTool("agent_start", {
      profile: "implementer",
      task: "add the widget",
      title: "Widget",
    });
    let childId = "";
    await waitFor(async () => {
      const rows = await env.c.request<SessionSnapshot[]>("session.list", {});
      childId = rows.find((r) => r.supervisorId === lead.id)?.id ?? "";
      return childId !== "";
    });
    await env.c.request("session.interrupt", { id: childId });
    const notes = () => lead.fs.sends.filter((s) => s.startsWith("[from your sub-agent"));
    await waitFor(() => notes().length > 0);
    assert.match(notes()[0]!, /It was interrupted \(user\)\./);
    release();
    await started;
    await delay(50);
    assert.equal(notes().length, 1, "told once");
  });

  test("a running child is told its supervisor's renamed branch", async (env) => {
    // The supervisor starts a child during its first turn; that turn's end
    // names the supervisor's branch.
    const snap = await env.c.request<SessionSnapshot>("session.create", {
      prompt: "lead the work",
      provider: "fake",
    });
    await waitFor(() => env.provider.session(snap.id) !== undefined);
    const lead = env.provider.session(snap.id)!;
    const before = (await get(env.c, snap.id)).branch!;
    const child = await startChild(env, lead);
    assert.equal(env.provider.creates.find((o) => o.sessionId === child.id)?.base, before);
    lead.finishTurn();
    await waitFor(async () => (await get(env.c, snap.id)).branch !== before);
    const renamed = (await get(env.c, snap.id)).branch!;
    assert.equal((await get(env.c, child.id)).baseBranch, renamed);
    await waitFor(() => child.fs.bases.includes(renamed));
  });

  test("a supervisor's wait ends with its turn", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    child.fs.emit({ type: "assistant_text", text: "busy" });
    await waitFor(async () => (await get(env.c, child.id)).status.kind === "running");
    await env.c.request("session.send", { id: lead.id, text: "wait for it", by: "client" });
    await waitFor(() => lead.fs.sends.includes("wait for it"));
    lead.fs.emit({ type: "assistant_text", text: "waiting" });
    await waitFor(async () => (await get(env.c, lead.id)).status.kind === "running");
    const waited = lead.fs.callAgentTool("agent_wait", { ids: [child.id], timeout: 60 });
    await delay(20);
    lead.fs.finishTurn();
    const res = await Promise.race([
      waited,
      delay(2000).then(() => ({ ok: false, text: "still waiting" })),
    ]);
    assert.match(res.text, /^Stopped waiting/);
  });

  test("a supervisor's turn end reminds it once of finished agents, a restart included", async (env) => {
    const lead = await idleSession(env);
    const merged = await startChild(env, lead.fs, { title: "Merged" });
    const ahead = await startChild(env, lead.fs, { title: "Ahead" });
    const tree = (await get(env.c, ahead.id)).worktree!;
    writeFileSync(join(tree, "widget.txt"), "widget\n");
    git(tree, "add", "widget.txt");
    git(tree, "commit", "-q", "-m", "widget");
    const notes = () => lead.fs.sends.filter((s) => s.startsWith("[from your sub-agent"));
    // Each report starts a supervisor turn; the second waits for the first's end.
    await finish(env, merged, "Nothing to change.");
    await waitFor(() => notes().length === 1);
    await finish(env, ahead, "Widget added.");
    await waitFor(async () => ((await get(env.c, lead.id)).queue?.entries.length ?? 0) === 1);
    lead.fs.finishTurn();
    await waitFor(() => notes().length === 2);
    await delay(50);
    assert.deepEqual(reminders(lead.fs), [], "not while a report waits in its queue");

    lead.fs.finishTurn();
    await waitFor(() => reminders(lead.fs).length === 1);
    // In the fleet's order of the children.
    const reminder = reminders(lead.fs)[0]!;
    assert.match(
      reminder,
      /^\[loom\] You have 2 sub-agents that have finished and are not archived: /,
    );
    assert.ok(reminder.includes(`${merged.id.slice(0, 8)} "Merged" (idle, branch merged)`));
    assert.ok(
      reminder.includes(`${ahead.id.slice(0, 8)} "Ahead" (idle, 1 commit not merged into yours)`),
    );
    assert.match(reminder, /\. Archive each with agent_stop once its work is merged /);
    lead.fs.finishTurn();
    await waitFor(async () => (await get(env.c, lead.id)).status.kind === "idle");
    await delay(50);
    assert.equal(reminders(lead.fs).length, 1, "once");

    await env.c.close();
    await env.h.restart();
    env.c = await LoomClient.connect({
      repoRoot: env.h.repoRoot,
      sockPath: env.h.sockPath,
      autospawn: false,
    });
    const provider = (await env.h.daemon.providers.get("fake")) as FakeProvider;
    await env.c.request("session.send", { id: lead.id, text: "anything left?", by: "client" });
    await waitFor(() => provider.session(lead.id)?.sends.includes("anything left?") ?? false);
    const revived = provider.session(lead.id)!;
    revived.finishTurn();
    await waitFor(async () => (await get(env.c, lead.id)).status.kind === "idle");
    await delay(50);
    assert.deepEqual(reminders(revived), [], "not again after a restart");
  });

  test("a held supervisor is not reminded; its next turn end after release is", async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    await finish(env, child, "Widget added.");
    await waitFor(() => lead.fs.sends.some((s) => s.startsWith("[from your sub-agent")));
    // A hold on a supervisor whose turn then ends idle.
    env.h.daemon.sessions.holdForStop(lead.id, "user");
    lead.fs.finishTurn();
    await waitFor(async () => (await get(env.c, lead.id)).status.kind === "idle");
    await delay(50);
    assert.equal((await get(env.c, lead.id)).queue?.hold, "interrupt");
    assert.deepEqual(reminders(lead.fs), [], "never past a hold");

    await env.c.request("session.queueRelease", { id: lead.id });
    await env.c.request("session.send", { id: lead.id, text: "go on", by: "client" });
    await waitFor(() => lead.fs.sends.includes("go on"));
    lead.fs.finishTurn();
    await waitFor(() => reminders(lead.fs).length === 1);
  });

  test("running children and a root without children get no reminder", async (env) => {
    const lone = await idleSession(env);
    await env.c.request("session.send", { id: lone.id, text: "more", by: "client" });
    await waitFor(() => lone.fs.sends.includes("more"));
    lone.fs.finishTurn();

    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    child.fs.emit({ type: "assistant_text", text: "busy" });
    await waitFor(async () => (await get(env.c, child.id)).status.kind === "running");
    await env.c.request("session.send", { id: lead.id, text: "check in", by: "client" });
    await waitFor(() => lead.fs.sends.includes("check in"));
    lead.fs.finishTurn();
    await waitFor(async () => (await get(env.c, lead.id)).status.kind === "idle");
    await delay(50);
    assert.deepEqual(reminders(lead.fs), []);
    assert.deepEqual(reminders(lone.fs), []);
  });
});

const reminders = (fs: FakeSession): string[] =>
  fs.sends.filter((s) => /^\[loom\] You have \d+ sub-agents? that ha/.test(s));

// Outside the concurrent suite: it stubs Git for the whole process.
nodeTest("a child whose report is still being made is not in its supervisor's reminder", (t) =>
  withEnv(async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    const tree = (await get(env.c, child.id)).worktree!;
    const notes = () => lead.fs.sends.filter((s) => s.startsWith("[from your sub-agent"));
    const gate = Promise.withResolvers<void>();
    const original = WorktreeManager.prototype.factsAsync;
    let probed = false;
    t.mock.method(
      WorktreeManager.prototype,
      "factsAsync",
      function (this: WorktreeManager, path: string, base: string | null) {
        // Only the report's probe waits; the reminder's own read goes through.
        if (path !== tree || probed) return original.call(this, path, base);
        probed = true;
        return gate.promise.then(() => original.call(this, path, base));
      },
    );
    await env.c.request("session.send", { id: lead.id, text: "keep going", by: "client" });
    await waitFor(() => lead.fs.sends.includes("keep going"));
    try {
      child.fs.emit({ type: "assistant_text", text: "Widget added." });
      child.fs.finishTurn();
      await waitFor(() => probed);
      // The supervisor's turn ends while the child's report is being made.
      lead.fs.finishTurn();
      await waitFor(async () => (await get(env.c, lead.id)).status.kind === "idle");
      await delay(50);
      assert.deepEqual(reminders(lead.fs), []);
    } finally {
      gate.resolve();
    }
    await waitFor(() => notes().length === 1);
    lead.fs.finishTurn();
    await waitFor(() => reminders(lead.fs).length === 1);
    assert.ok(lead.fs.sends.indexOf(notes()[0]!) < lead.fs.sends.indexOf(reminders(lead.fs)[0]!));
  }),
);

// Outside the concurrent suite: it stubs Git for the whole process.
nodeTest("a child's turn-end workspace facts are read off the daemon thread", (t) =>
  withEnv(async (env) => {
    const lead = await idleSession(env);
    const child = await startChild(env, lead.fs);
    const tree = (await get(env.c, child.id)).worktree!;
    writeFileSync(join(tree, "wip.txt"), "uncommitted\n");
    const notes = () => lead.fs.sends.filter((s) => s.startsWith("[from your sub-agent"));
    const gate = Promise.withResolvers<void>();
    const original = WorktreeManager.prototype.factsAsync;
    let probed = false;
    t.mock.method(
      WorktreeManager.prototype,
      "factsAsync",
      function (this: WorktreeManager, path: string, base: string | null) {
        if (path !== tree) return original.call(this, path, base);
        probed = true;
        return gate.promise.then(() => original.call(this, path, base));
      },
    );
    const sync = t.mock.method(WorktreeManager.prototype, "facts");
    try {
      child.fs.emit({ type: "assistant_text", text: "Widget added." });
      child.fs.finishTurn();
      await waitFor(() => env.h.daemon.registry.get(child.id)?.status.kind === "idle");
      await waitFor(() => probed);
      await delay(50);
      assert.deepEqual(notes(), [], "the notification waits for the probe");
      assert.ok(
        !sync.mock.calls.some((c) => c.arguments[0] === tree),
        "no synchronous Git for the child's turn end",
      );
    } finally {
      gate.resolve();
    }
    await waitFor(() => notes().length === 1);
    assert.match(notes()[0]!, /Its workspace: 0 commits ahead of its base, uncommitted changes\./);
  }),
);
