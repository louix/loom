import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import type { PushFrame, SessionSnapshot } from "@loom/core/wire";
import type { FakeProvider, FakeSession } from "@loom/connector-mock";
import { makeHarness, type Harness } from "@loom/harness";

let h: Harness;
let fakeProvider: FakeProvider;

before(async () => {
  h = await makeHarness();
  fakeProvider = (await h.daemon.providers.get("fake")) as FakeProvider;
});
after(async () => {
  await h.cleanup();
});

function client(reconnect = false): Promise<LoomClient> {
  return LoomClient.connect({ repoRoot: h.repoRoot, sockPath: h.sockPath, autospawn: false, reconnect });
}

function fake(): FakeProvider {
  return fakeProvider;
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 1000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start >= ms) throw new Error("condition not met in time");
    await delay(5);
  }
}

async function statusOf(c: LoomClient, id: string): Promise<string> {
  return (await c.request<SessionSnapshot>("session.get", { id })).status;
}

async function createFake(c: LoomClient, prompt = "do work"): Promise<{ id: string; fs: FakeSession }> {
  const snap = await c.request<SessionSnapshot>("session.create", { prompt, provider: "fake" });
  await waitFor(() => fake().session(snap.id) !== undefined);
  return { id: snap.id, fs: fake().session(snap.id) as FakeSession };
}

test("session.create requires a prompt", async () => {
  const c = await client();
  await assert.rejects(c.request("session.create", { provider: "fake" }), /prompt is required/);
  await c.close();
});

test("create registers a session, streams its events, and derives running → idle", async () => {
  const c = await client();
  const frames: PushFrame[] = [];
  c.onPush((f) => frames.push(f));

  const { id, fs } = await createFake(c, "stream me");
  const created = await c.request<SessionSnapshot>("session.get", { id });
  assert.equal(created.provider, "fake");
  assert.equal(created.title, "stream me");

  fs.emit({ type: "assistant_text", text: "working" });
  await waitFor(() => (c.sessions ?? []).length >= 0 && frames.some((f) => f.type === "event" && f.event.type === "assistant_text"));
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).status === "running");

  fs.finishTurn({ summary: "all done", usage: { input: 500, output: 40 }, costUsd: 0.03 });
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).status === "idle");

  const done = await c.request<SessionSnapshot>("session.get", { id });
  assert.equal(done.usage.input, 500);
  assert.equal(done.usage.output, 40);
  assert.equal(done.turns, 1);
  assert.ok(Math.abs(done.costUsd - 0.03) < 1e-9);
  assert.equal(done.contextUsed, 500);

  // the opening prompt lands on the stream as a user_message; the pump's own
  // events then carry a per-session ordinal starting at 0
  const evs = frames.filter((f) => f.type === "event" && f.event.sessionId === id);
  assert.ok(evs.length >= 3);
  assert.equal((evs[0] as { event: { type: string } }).event.type, "user_message");
  const firstOrdinal = evs.find(
    (f) => (f as { event: { ordinal?: number } }).event.ordinal !== undefined,
  );
  assert.equal((firstOrdinal as { event: { ordinal?: number } }).event.ordinal, 0);

  await c.close();
});

test("permission_request blocks the session; first responder wins", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);
  fs.emit({ type: "permission_request", id: "p1", tool: "Bash", input: { command: "ls" } });

  await waitFor(async () => {
    const s = await c.request<SessionSnapshot>("session.get", { id });
    return s.status === "awaiting_input" && s.awaitReason === "permission";
  });

  const first = await c.request<{ ok: boolean; alreadyResolved: boolean }>("session.respondPermission", {
    id,
    requestId: "p1",
    decision: "allow",
  });
  assert.deepEqual(first, { ok: true, alreadyResolved: false });

  const second = await c.request<{ ok: boolean; alreadyResolved: boolean }>("session.respondPermission", {
    id,
    requestId: "p1",
    decision: "deny",
  });
  assert.equal(second.alreadyResolved, true);

  assert.equal(fs.permissionResponses.length, 1);
  assert.equal(fs.permissionResponses[0]?.decision.behavior, "allow");

  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).status === "running");
  await c.close();
});

test("a stray assistant_text / tool_call after permission_request doesn't unblock the session", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);
  fs.emit({ type: "permission_request", id: "p1", tool: "bash", input: { command: "ls" } });
  await waitFor(async () => (await statusOf(c, id)) === "awaiting_input");

  // Some OpenAI-compatible providers flush buffered assistant text / a parallel
  // tool call *after* the permission_request — the session must stay blocked.
  fs.emit({ type: "assistant_text", text: "I'll look around." });
  fs.emit({ type: "tool_call", id: "t2", name: "bash", input: { command: "pwd" } });
  await delay(60);
  const s = await c.request<SessionSnapshot>("session.get", { id });
  assert.equal(s.status, "awaiting_input");
  assert.equal(s.awaitReason, "permission");

  await c.request("session.respondPermission", { id, requestId: "p1", decision: "allow" });
  await waitFor(async () => (await statusOf(c, id)) === "running");
  await c.close();
});

test("an ask_user question blocks the session until session.answer resolves it", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);
  fs.emit({ type: "question", id: "q1", question: "which database?", context: "postgres or sqlite" });

  await waitFor(async () => {
    const s = await c.request<SessionSnapshot>("session.get", { id });
    return s.status === "awaiting_input" && s.awaitReason === "question";
  });

  const first = await c.request<{ ok: boolean; alreadyResolved: boolean }>("session.answer", {
    id,
    requestId: "q1",
    text: "sqlite",
  });
  assert.deepEqual(first, { ok: true, alreadyResolved: false });
  assert.deepEqual(fs.questionAnswers, [{ id: "q1", text: "sqlite" }]);

  const second = await c.request<{ ok: boolean; alreadyResolved: boolean }>("session.answer", {
    id,
    requestId: "q1",
    text: "changed my mind",
  });
  assert.equal(second.alreadyResolved, true);
  assert.equal(fs.questionAnswers.length, 1);

  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).status === "running");
  await c.close();
});

test("a plan_review blocks the session; session.respondPlan resolves it", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);
  fs.emit({ type: "plan_review", id: "pr1", plan: "1. wire the seam\n2. add the RPC" });

  await waitFor(async () => {
    const s = await c.request<SessionSnapshot>("session.get", { id });
    return s.status === "awaiting_input" && s.awaitReason === "plan_review";
  });

  const first = await c.request<{ ok: boolean; alreadyResolved: boolean }>("session.respondPlan", {
    id,
    requestId: "pr1",
    action: "implement",
  });
  assert.deepEqual(first, { ok: true, alreadyResolved: false });
  assert.equal(fs.planResponses.length, 1);
  assert.deepEqual(fs.planResponses[0]?.decision, { action: "implement" });

  const second = await c.request<{ ok: boolean; alreadyResolved: boolean }>("session.respondPlan", {
    id,
    requestId: "pr1",
    action: "discuss",
    message: "hmm",
  });
  assert.equal(second.alreadyResolved, true);

  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).status === "running");
  await c.close();
});

test("session.respondPlan carries the revise plan / discuss message and validates them", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);
  fs.emit({ type: "plan_review", id: "pr2", plan: "draft" });
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).awaitReason === "plan_review");

  await assert.rejects(
    c.request("session.respondPlan", { id, requestId: "pr2", action: "revise", plan: "  " }),
    /revise needs/,
  );
  await assert.rejects(
    c.request("session.respondPlan", { id, requestId: "pr2", action: "bogus" }),
    /implement \| implement_fresh \| revise \| discuss/,
  );

  await c.request("session.respondPlan", { id, requestId: "pr2", action: "revise", plan: "final plan" });
  assert.deepEqual(fs.planResponses.at(-1)?.decision, { action: "revise", plan: "final plan" });
  await c.close();
});

test("session.answer on a session that isn't running is not_found", async () => {
  const c = await client();
  await assert.rejects(
    c.request("session.answer", { id: "nope", requestId: "q1", text: "x" }),
    /session not running/,
  );
  await c.close();
});

test("send delivers a follow-up turn and returns the session to running", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);
  fs.finishTurn();
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).status === "idle");

  await c.request("session.send", { id, text: "one more thing" });
  assert.deepEqual(fs.sends, ["one more thing"]);
  const s = await c.request<SessionSnapshot>("session.get", { id });
  assert.equal(s.status, "running");
  await c.close();
});

test("the usage rollup records the last turn's time and cache read/write split", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);
  const before = Date.now();
  fs.finishTurn({ usage: { input: 1200, cacheRead: 9000, cacheWrite: 250 } });
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 1);

  const snap = await c.request<SessionSnapshot>("session.get", { id });
  assert.equal(snap.cache.lastRead, 9000);
  assert.equal(snap.cache.lastWrite, 250);
  assert.ok(snap.cache.lastTurnAt >= before);
  // a fake session isn't Claude, so the daemon doesn't overlay a cache TTL
  assert.equal(snap.cache.ttlMinutes, 0);
  await c.close();
});

test("session.compact forwards to the adapter and streams a compact event", async () => {
  const c = await client();
  const frames: PushFrame[] = [];
  c.onPush((f) => frames.push(f));
  const { id, fs } = await createFake(c);
  fs.finishTurn({ contextUsed: 80_000 });
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).status === "idle");

  await c.request("session.compact", { id, instructions: "keep the plan" });
  assert.deepEqual(fs.compacts, ["keep the plan"]);

  await waitFor(() =>
    frames.some((f) => f.type === "event" && f.event.type === "compact" && f.event.sessionId === id),
  );
  const compact = frames.find(
    (f): f is Extract<PushFrame, { type: "event" }> => f.type === "event" && f.event.type === "compact",
  );
  assert.equal(compact?.event.type === "compact" && compact.event.before, 80_000);
  // compacting an idle session leaves it idle
  assert.equal((await c.request<SessionSnapshot>("session.get", { id })).status, "idle");
  await c.close();
});

test("session.compact on a session that isn't running is not_found", async () => {
  const c = await client();
  await assert.rejects(c.request("session.compact", { id: "nope" }), /session not running/);
  await c.close();
});

test("interrupt is sticky — a trailing stream end does not undo it", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);
  fs.emit({ type: "assistant_text", text: "midway" });
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).status === "running");

  await c.request("session.interrupt", { id });
  assert.equal(fs.interruptCount, 1);
  assert.equal((await c.request<SessionSnapshot>("session.get", { id })).status, "interrupted");

  fs.endStream();
  await delay(30);
  assert.equal((await c.request<SessionSnapshot>("session.get", { id })).status, "interrupted");
  await c.close();
});

test("after an interrupt you can just send — no resume step", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);
  fs.emit({ type: "assistant_text", text: "midway" });
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).status === "running");

  await c.request("session.interrupt", { id });
  assert.equal((await c.request<SessionSnapshot>("session.get", { id })).status, "interrupted");

  // send() on the interrupted (still-live) session starts a fresh turn
  await c.request("session.send", { id, text: "carry on" });
  assert.deepEqual(fs.sends, ["carry on"]);
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).status === "running");
  await c.close();
});

test("a fatal error moves the session to error", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);
  fs.fail("provider exploded");
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).status === "error");
  const hist = await c.request<Array<{ status: string; reason: string | null }>>("session.history", { id });
  assert.equal(hist.at(-1)?.status, "error");
  await c.close();
});

test("an abrupt stream end (still live) becomes interrupted/stream_ended", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);
  fs.emit({ type: "assistant_text", text: "half" });
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).status === "running");
  fs.endStream();
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).status === "interrupted");
  const hist = await c.request<Array<{ status: string; reason: string | null }>>("session.history", { id });
  assert.equal(hist.at(-1)?.reason, "stream_ended");
  await c.close();
});

test("the first successful turn auto-titles the session", async () => {
  const c = await client();
  fake().titleReply = "Add a websocket transport";
  const { id, fs } = await createFake(c, "please add websockets to the transport layer");
  assert.equal((await c.request<SessionSnapshot>("session.get", { id })).title, "please add websockets to the transport layer");

  fs.finishTurn();
  await waitFor(
    async () => (await c.request<SessionSnapshot>("session.get", { id })).title === "Add a websocket transport",
  );
  await c.close();
});

test("a manual rename locks the title against the auto-titler", async () => {
  const c = await client();
  fake().titleReply = "Should never win";
  const { id, fs } = await createFake(c, "do a thing");
  await c.request("session.setTitle", { id, title: "my name for it" });

  fs.finishTurn();
  // give the (suppressed) one-shot a chance to have run
  await delay(60);
  assert.equal((await c.request<SessionSnapshot>("session.get", { id })).title, "my name for it");
  await c.close();
});

test("sub-agent start/stop events surface on the session snapshot", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);

  fs.emit({ type: "subagent_started", subagentId: "t1", name: "reviewer" });
  fs.emit({ type: "subagent_started", subagentId: "t2", name: "tester" });
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).subagents.length === 2);

  let snap = await c.request<SessionSnapshot>("session.get", { id });
  assert.deepEqual(
    snap.subagents.map((s) => [s.name, s.active]),
    [["reviewer", true], ["tester", true]],
  );

  fs.emit({ type: "subagent_stopped", subagentId: "t1" });
  await waitFor(async () => {
    const s = await c.request<SessionSnapshot>("session.get", { id });
    return s.subagents.find((x) => x.id === "t1")?.active === false;
  });
  snap = await c.request<SessionSnapshot>("session.get", { id });
  assert.equal(snap.subagents.find((x) => x.id === "t1")?.active, false);
  assert.equal(snap.subagents.find((x) => x.id === "t2")?.active, true);
  await c.close();
});

test("rate_limit events surface on the session snapshot, keyed by window", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);

  fs.emit({ type: "rate_limit", status: "allowed", window: "five_hour", utilization: 42, resetsAt: 1000 });
  await waitFor(async () => Object.keys((await c.request<SessionSnapshot>("session.get", { id })).rateLimits).length === 1);

  // A different window merges in rather than clobbering the first.
  fs.emit({ type: "rate_limit", status: "allowed_warning", window: "seven_day", utilization: 88, resetsAt: 2000 });
  await waitFor(
    async () => Object.keys((await c.request<SessionSnapshot>("session.get", { id })).rateLimits).length === 2,
  );

  const snap = await c.request<SessionSnapshot>("session.get", { id });
  assert.deepEqual(snap.rateLimits.five_hour, { status: "allowed", utilization: 42, resetsAt: 1000 });
  assert.deepEqual(snap.rateLimits.seven_day, { status: "allowed_warning", utilization: 88, resetsAt: 2000 });
  await c.close();
});

test("setMode updates the row and forwards to a live adapter", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);
  const snap = await c.request<SessionSnapshot>("session.setMode", { id, mode: "plan", by: "tester" });
  assert.equal(snap.mode, "plan");
  assert.deepEqual(fs.modeChanges, ["plan"]);
  await assert.rejects(c.request("session.setMode", { id, mode: "bogus" }), /mode must be/);
  await c.close();
});

test("without a price table the provider's cost is kept, tagged costSource=provider", async () => {
  const c = await client();
  const { id, fs } = await createFake(c, "unpriced work");
  fs.finishTurn({ usage: { input: 100, output: 20 }, costUsd: 0.02 });
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 1);
  const got = await c.request<SessionSnapshot>("session.get", { id });
  assert.ok(Math.abs(got.costUsd - 0.02) < 1e-9);
  assert.equal(got.costSource, "provider");
  await c.close();
});

test("a price table overrides the provider's cost, tagged costSource=table", async () => {
  writeFileSync(join(h.repoRoot, ".loom", "models.toml"), `["fake-1"]\ninput = 3.0\noutput = 15.0\n`);
  const c = await client();
  const reloaded = await c.request<{ models: string[] }>("pricing.reload");
  assert.ok(reloaded.models.includes("fake-1"));

  const snap = await c.request<SessionSnapshot>("session.create", {
    prompt: "priced work",
    provider: "fake",
    model: "fake-1",
  });
  await waitFor(() => fake().session(snap.id) !== undefined);
  const fs = fake().session(snap.id) as FakeSession;

  fs.finishTurn({ usage: { input: 1000, output: 500 }, costUsd: 0.99 });
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id: snap.id })).turns === 1);

  const got = await c.request<SessionSnapshot>("session.get", { id: snap.id });
  // (1000*3 + 500*15) / 1e6 = 0.0105  — not the provider's 0.99
  assert.ok(Math.abs(got.costUsd - 0.0105) < 1e-9);
  assert.equal(got.costSource, "table");
  await c.close();
});

test("daemon.status reports running session and provider counts", async () => {
  const c = await client();
  await createFake(c);
  const s = await c.request<{ runningSessions: number; providers: string[] }>("daemon.status");
  assert.ok(s.runningSessions >= 1);
  assert.ok(s.providers.includes("fake"));
  await c.close();
});

test("a checkpoint is recorded per completed turn; session.checkpoints lists them", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);

  fs.finishTurn(); // turn 1
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 1);

  await c.request("session.send", { id, text: "the second ask" });
  fs.finishTurn(); // turn 2
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 2);

  const cps = await c.request<Array<{ turn: number; userText: string; rewindCostUsd: number }>>(
    "session.checkpoints",
    { id },
  );
  assert.deepEqual(cps.map((x) => x.turn), [1, 2]);
  assert.equal(cps[0]?.userText, "do work"); // the create prompt
  assert.equal(cps[1]?.userText, "the second ask");
  assert.equal(cps[1]?.rewindCostUsd, 0); // fake isn't priced / isn't aisdk

  // A non-aisdk provider is refused before any range check runs.
  await assert.rejects(c.request("session.rewind", { id, toTurn: 1 }), /aisdk-only/);
  await assert.rejects(c.request("session.rewind", { id, toTurn: 9 }), /aisdk-only/);
  await c.close();
});

test("a permission answer that lands after an interrupt does not un-interrupt the session", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);
  fs.emit({ type: "permission_request", id: "p1", tool: "Bash", input: { command: "rm -rf ." } });
  await waitFor(async () => (await statusOf(c, id)) === "awaiting_input");

  await c.request("session.interrupt", { id });
  await waitFor(async () => (await statusOf(c, id)) === "interrupted");

  // a client whose UI still showed the prompt clicks Allow
  const r = await c.request<{ ok: boolean; alreadyResolved: boolean }>("session.respondPermission", {
    id,
    requestId: "p1",
    decision: "allow",
  });
  await delay(40);
  assert.equal(r.alreadyResolved, true, "the pending id was dropped by the interrupt");
  assert.equal(await statusOf(c, id), "interrupted", "a stale answer must not flip a dead turn back to running");
  await c.close();
});

test("a compaction drops the checkpoints (their offsets are no longer valid)", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);
  fs.finishTurn();
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 1);
  await c.request("session.send", { id, text: "more" });
  fs.finishTurn();
  await waitFor(async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 2);

  let cps = await c.request<Array<{ turn: number }>>("session.checkpoints", { id });
  assert.deepEqual(cps.map((x) => x.turn), [1, 2]);

  fs.emit({ type: "compact", trigger: "manual", before: 100, after: 30 });
  await delay(40);

  cps = await c.request<Array<{ turn: number }>>("session.checkpoints", { id });
  assert.deepEqual(cps, [], "checkpoints cleared after a compaction");
  await c.close();
});

