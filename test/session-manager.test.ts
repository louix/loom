import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test as nodeTest } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import { cacheHitRate } from "@loom/core/cache";
import type { ModelUsage, PushFrame, SessionSnapshot } from "@loom/core/wire";
import type { FakeProvider, FakeSession } from "@loom/connector-mock";
import { makeHarness, type Harness } from "@loom/harness";

// Every test runs against its own harness (daemon + temp git repo) so tests
// can overlap; the active harness rides AsyncLocalStorage, which keeps the
// zero-argument `client()` / `fake()` / `harness()` helpers working unchanged
// inside test bodies.
const ctx = new AsyncLocalStorage<{ h: Harness; fakeProvider: FakeProvider }>();

const harness = (): Harness => ctx.getStore()!.h;

const client = (reconnect = false): Promise<LoomClient> => {
  const { h } = ctx.getStore()!;
  return LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
    reconnect,
  });
};

const fake = (): FakeProvider => ctx.getStore()!.fakeProvider;

/** Run a test body against its own harness, cleaned up even on failure. */
const withHarness = async (fn: () => Promise<void>): Promise<void> => {
  const h = await makeHarness();
  try {
    const fakeProvider = (await h.daemon.providers.get("fake")) as FakeProvider;
    await ctx.run({ h, fakeProvider }, fn);
  } finally {
    await h.cleanup();
  }
};

/** Same surface as node:test's `test`, but each body gets its own harness. */
const test = (name: string, fn: () => Promise<void>) => nodeTest(name, () => withHarness(fn));

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 1000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start >= ms) throw new Error("condition not met in time");
    await delay(5);
  }
};

const statusOf = async (c: LoomClient, id: string): Promise<string> => {
  return (await c.request<SessionSnapshot>("session.get", { id })).status.kind;
};

/** The session's `compacting` overlay, as the snapshot reports it. */
const snapshotCompacting = async (
  c: LoomClient,
  id: string,
): Promise<SessionSnapshot["compacting"]> => {
  return (await c.request<SessionSnapshot>("session.get", { id })).compacting;
};

/** The `AwaitReason` a blocked session is on, or null. */
const awaitReasonOf = async (c: LoomClient, id: string): Promise<string | null> => {
  const st = (await c.request<SessionSnapshot>("session.get", { id })).status;
  return st.kind === "awaiting_input" ? st.on : null;
};

const createFake = async (
  c: LoomClient,
  prompt = "do work",
): Promise<{ id: string; fs: FakeSession }> => {
  const snap = await c.request<SessionSnapshot>("session.create", { prompt, provider: "fake" });
  await waitFor(() => fake().session(snap.id) !== undefined);
  return { id: snap.id, fs: fake().session(snap.id) as FakeSession };
};

// Tests are fully isolated (own daemon each), so they overlap; bounded so a
// small machine doesn't host every daemon at once.
describe("session-manager", { concurrency: 4 }, () => {
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
    await waitFor(() =>
      frames.some((f) => f.type === "event" && f.event.type === "assistant_text"),
    );
    await waitFor(
      async () =>
        (await c.request<SessionSnapshot>("session.get", { id })).status.kind === "running",
    );

    fs.finishTurn({ summary: "all done", usage: { input: 500, output: 40 }, costUsd: 0.03 });
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).status.kind === "idle",
    );

    const done = await c.request<SessionSnapshot>("session.get", { id });
    assert.equal(done.usage.input, 500);
    assert.equal(done.usage.output, 40);
    assert.equal(done.turns, 1);
    assert.ok(Math.abs(done.costUsd - 0.03) < 1e-9);
    assert.equal(done.contextUsed, 500);

    // the opening prompt lands on the stream as a user_message; the pump's own
    // events then carry a per-session ordinal that strictly increases (seeded
    // from wall-clock so a resumed session doesn't reuse persisted ordinals — S11)
    const evs = frames.filter((f) => f.type === "event" && f.event.sessionId === id);
    assert.ok(evs.length >= 3);
    assert.equal((evs[0] as { event: { type: string } }).event.type, "user_message");
    const ordinals = evs
      .map((f) => (f as { event: { ordinal?: number } }).event.ordinal)
      .filter((n): n is number => n !== undefined);
    assert.ok(ordinals.length >= 2);
    for (let i = 1; i < ordinals.length; i++) {
      assert.ok(ordinals[i]! > ordinals[i - 1]!, "ordinals strictly increase");
    }

    await c.close();
  });

  test("permission_request blocks the session; first responder wins", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.emit({ type: "permission_request", id: "p1", tool: "Bash", input: { command: "ls" } });

    await waitFor(async () => {
      const s = await c.request<SessionSnapshot>("session.get", { id });
      return s.status.kind === "awaiting_input" && s.status.on === "permission";
    });

    const first = await c.request<{ ok: boolean; alreadyResolved: boolean }>(
      "session.respondPermission",
      {
        id,
        requestId: "p1",
        decision: "allow",
      },
    );
    assert.deepEqual(first, { ok: true, alreadyResolved: false });

    const second = await c.request<{ ok: boolean; alreadyResolved: boolean }>(
      "session.respondPermission",
      {
        id,
        requestId: "p1",
        decision: "deny",
      },
    );
    assert.equal(second.alreadyResolved, true);

    assert.equal(fs.permissionResponses.length, 1);
    assert.equal(fs.permissionResponses[0]?.decision.behavior, "allow");

    await waitFor(
      async () =>
        (await c.request<SessionSnapshot>("session.get", { id })).status.kind === "running",
    );
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
    assert.deepEqual(s.status, { kind: "awaiting_input", on: "permission" });

    await c.request("session.respondPermission", { id, requestId: "p1", decision: "allow" });
    await waitFor(async () => (await statusOf(c, id)) === "running");
    await c.close();
  });

  test("an ask_user question blocks the session until session.answer resolves it", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.emit({
      type: "question",
      id: "q1",
      question: "which database?",
      context: "postgres or sqlite",
    });

    await waitFor(async () => {
      const s = await c.request<SessionSnapshot>("session.get", { id });
      return s.status.kind === "awaiting_input" && s.status.on === "question";
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

    await waitFor(
      async () =>
        (await c.request<SessionSnapshot>("session.get", { id })).status.kind === "running",
    );
    await c.close();
  });

  test("a plan_review blocks the session; session.respondPlan resolves it", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.emit({ type: "plan_review", id: "pr1", plan: "1. wire the seam\n2. add the RPC" });

    await waitFor(async () => {
      const s = await c.request<SessionSnapshot>("session.get", { id });
      return s.status.kind === "awaiting_input" && s.status.on === "plan_review";
    });

    const first = await c.request<{ ok: boolean; alreadyResolved: boolean }>(
      "session.respondPlan",
      {
        id,
        requestId: "pr1",
        action: "implement",
      },
    );
    assert.deepEqual(first, { ok: true, alreadyResolved: false });
    assert.equal(fs.planResponses.length, 1);
    assert.deepEqual(fs.planResponses[0]?.decision, { action: "implement" });

    const second = await c.request<{ ok: boolean; alreadyResolved: boolean }>(
      "session.respondPlan",
      {
        id,
        requestId: "pr1",
        action: "discuss",
        message: "hmm",
      },
    );
    assert.equal(second.alreadyResolved, true);

    await waitFor(
      async () =>
        (await c.request<SessionSnapshot>("session.get", { id })).status.kind === "running",
    );
    await c.close();
  });

  test("session.respondPlan carries the revise plan / discuss message and validates them", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.emit({ type: "plan_review", id: "pr2", plan: "draft" });
    await waitFor(async () => (await awaitReasonOf(c, id)) === "plan_review");

    await assert.rejects(
      c.request("session.respondPlan", { id, requestId: "pr2", action: "revise", plan: "  " }),
      /revise needs/,
    );
    await assert.rejects(
      c.request("session.respondPlan", { id, requestId: "pr2", action: "bogus" }),
      /implement \| implement_fresh \| revise \| discuss/,
    );
    // The implement mode is validated too — `plan` would withhold the mutators.
    await assert.rejects(
      c.request("session.respondPlan", { id, requestId: "pr2", action: "implement", mode: "plan" }),
      /mode must be/,
    );
    await assert.rejects(
      c.request("session.respondPlan", { id, requestId: "pr2", action: "implement", mode: "nope" }),
      /mode must be/,
    );

    await c.request("session.respondPlan", {
      id,
      requestId: "pr2",
      action: "revise",
      plan: "final plan",
      mode: "default",
    });
    assert.deepEqual(fs.planResponses.at(-1)?.decision, {
      action: "revise",
      plan: "final plan",
      mode: "default",
    });
    await c.close();
  });

  test("session.respondPlan forwards an implement_fresh model / effort retarget", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.emit({ type: "plan_review", id: "pr3", plan: "draft" });
    await waitFor(async () => (await awaitReasonOf(c, id)) === "plan_review");

    await assert.rejects(
      c.request("session.respondPlan", {
        id,
        requestId: "pr3",
        action: "implement_fresh",
        effort: "turbo",
      }),
      /effort must be a level this model supports/,
    );

    await c.request("session.respondPlan", {
      id,
      requestId: "pr3",
      action: "implement_fresh",
      mode: "auto",
      model: "m9",
      effort: "high",
    });
    assert.deepEqual(fs.planResponses.at(-1)?.decision, {
      action: "implement_fresh",
      mode: "auto",
      model: "m9",
      effort: "high",
    });
    await c.close();
  });

  test("session.setProvider validates; same provider is a model / effort change; a Claude cross-switch is refused", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.finishTurn();
    await waitFor(async () => (await statusOf(c, id)) === "idle");

    await assert.rejects(
      c.request("session.setProvider", { id: "nope", provider: "fake" }),
      /no such session/,
    );
    await assert.rejects(
      c.request("session.setProvider", { id, provider: "ghost" }),
      /unknown provider/,
    );
    await assert.rejects(
      c.request("session.setProvider", { id, provider: "fake", effort: "turbo" }),
      /effort must be a level this model supports/,
    );

    // Phase 1: a cross-provider switch that touches Claude is refused up front.
    await assert.rejects(
      c.request("session.setProvider", { id, provider: "claude" }),
      /isn't supported yet/,
    );

    // Same provider → delegates to the model / effort moves; the provider stays put.
    const snap = await c.request<SessionSnapshot>("session.setProvider", {
      id,
      provider: "fake",
      model: "fake-b",
      effort: "high",
    });
    assert.equal(snap.provider, "fake");
    assert.equal(snap.model, "fake-b");
    assert.equal(snap.effort, "high");

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
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).status.kind === "idle",
    );

    await c.request("session.send", { id, text: "one more thing" });
    assert.deepEqual(fs.sends, ["one more thing"]);
    const s = await c.request<SessionSnapshot>("session.get", { id });
    assert.equal(s.status.kind, "running");
    await c.close();
  });

  test("the usage rollup records the last turn's time and cache read/write split", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    const before = Date.now();
    fs.finishTurn({ usage: { input: 1200, cacheRead: 9000, cacheWrite: 250 } });
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 1,
    );

    const snap = await c.request<SessionSnapshot>("session.get", { id });
    assert.equal(snap.cache.lastRead, 9000);
    assert.equal(snap.cache.lastWrite, 250);
    assert.ok(snap.cache.lastTurnAt >= before);
    // a fake session isn't Claude, so the daemon doesn't overlay a cache TTL,
    // and nothing in the turn reported one either
    assert.equal(snap.cache.ttlMinutes, 0);
    assert.equal(snap.cache.ttlSource, "none");
    await c.close();
  });

  test("an observed cache TTL overrides the configured pin and is persisted", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    // The pin says nothing here (a fake session isn't Claude), but a reported
    // TTL is ground truth from the response and stands on its own.
    fs.finishTurn({ usage: { cacheWrite: 4000 }, cacheTtlMinutes: 5 });
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 1,
    );

    let snap = await c.request<SessionSnapshot>("session.get", { id });
    assert.equal(snap.cache.ttlMinutes, 5);
    assert.equal(snap.cache.ttlSource, "observed");

    // A later turn that reports no TTL must not walk the observation back.
    fs.finishTurn({ usage: { cacheRead: 4000 } });
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 2,
    );
    snap = await c.request<SessionSnapshot>("session.get", { id });
    assert.equal(snap.cache.ttlMinutes, 5);
    assert.equal(snap.cache.ttlSource, "observed");
    await c.close();
  });

  test("stats.models breaks a session's spend out by the model that made it", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.finishTurn({ usage: { input: 100, cacheRead: 900 }, cacheTtlMinutes: 60 });
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 1,
    );

    const r = await c.request<{ models: ModelUsage[] }>("stats.models", { id });
    assert.equal(r.models.length, 1);
    const row = r.models[0]!;
    assert.equal(row.provider, "fake");
    assert.equal(row.cacheRead, 900);
    assert.equal(row.ttlMinutes, 60);
    assert.equal(row.sessions, 1);
    assert.ok(Math.abs((cacheHitRate(row) ?? 0) - 0.9) < 1e-9);

    await assert.rejects(() => c.request("stats.models", { id: "nope" }));
    await c.close();
  });

  test("keep-warm turns on once a TTL is known, whatever the provider", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    // No turn yet ⇒ no TTL is known ⇒ nothing to race, so it's refused.
    await assert.rejects(() => c.request("session.setKeepWarm", { id, on: true }));

    // A turn that reports the TTL it wrote at arms the countdown; keep-warm is
    // gated on that being known, not on the provider or on a config pin.
    fs.finishTurn({ usage: { cacheWrite: 4000 }, cacheTtlMinutes: 5 });
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 1,
    );
    const snap = await c.request<SessionSnapshot>("session.setKeepWarm", { id, on: true });
    assert.equal(snap.keepWarm, true);
    assert.equal(snap.cache.ttlMinutes, 5);

    const off = await c.request<SessionSnapshot>("session.setKeepWarm", { id, on: false });
    assert.equal(off.keepWarm, false);
    await c.close();
  });

  test("session.compact forwards to the adapter and streams a compact event", async () => {
    const c = await client();
    const frames: PushFrame[] = [];
    c.onPush((f) => frames.push(f));
    const { id, fs } = await createFake(c);
    fs.finishTurn({ contextUsed: 80_000 });
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).status.kind === "idle",
    );

    await c.request("session.compact", { id, instructions: "keep the plan" });
    assert.deepEqual(fs.compacts, ["keep the plan"]);

    await waitFor(() =>
      frames.some(
        (f) => f.type === "event" && f.event.type === "compact" && f.event.sessionId === id,
      ),
    );
    const compact = frames.find(
      (f): f is Extract<PushFrame, { type: "event" }> =>
        f.type === "event" && f.event.type === "compact",
    );
    assert.equal(compact?.event.type === "compact" && compact.event.before, 80_000);
    // compacting an idle session leaves it idle
    assert.equal((await c.request<SessionSnapshot>("session.get", { id })).status.kind, "idle");
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
    await waitFor(
      async () =>
        (await c.request<SessionSnapshot>("session.get", { id })).status.kind === "running",
    );

    await c.request("session.interrupt", { id });
    assert.equal(fs.interruptCount, 1);
    assert.equal(
      (await c.request<SessionSnapshot>("session.get", { id })).status.kind,
      "interrupted",
    );

    fs.endStream();
    await delay(30);
    assert.equal(
      (await c.request<SessionSnapshot>("session.get", { id })).status.kind,
      "interrupted",
    );
    await c.close();
  });

  test("after an interrupt you can just send — no resume step", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.emit({ type: "assistant_text", text: "midway" });
    await waitFor(
      async () =>
        (await c.request<SessionSnapshot>("session.get", { id })).status.kind === "running",
    );

    await c.request("session.interrupt", { id });
    assert.equal(
      (await c.request<SessionSnapshot>("session.get", { id })).status.kind,
      "interrupted",
    );

    // send() on the interrupted (still-live) session starts a fresh turn
    await c.request("session.send", { id, text: "carry on" });
    assert.deepEqual(fs.sends, ["carry on"]);
    await waitFor(
      async () =>
        (await c.request<SessionSnapshot>("session.get", { id })).status.kind === "running",
    );
    await c.close();
  });

  test("a fatal error moves the session to error", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.fail("provider exploded");
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).status.kind === "error",
    );
    const hist = await c.request<Array<{ status: string; reason: string | null }>>(
      "session.history",
      { id },
    );
    assert.equal(hist.at(-1)?.status, "error");
    await c.close();
  });

  test("an abrupt stream end (still live) becomes interrupted/stream_ended", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.emit({ type: "assistant_text", text: "half" });
    await waitFor(
      async () =>
        (await c.request<SessionSnapshot>("session.get", { id })).status.kind === "running",
    );
    fs.endStream();
    await waitFor(
      async () =>
        (await c.request<SessionSnapshot>("session.get", { id })).status.kind === "interrupted",
    );
    const hist = await c.request<Array<{ status: string; reason: string | null }>>(
      "session.history",
      { id },
    );
    assert.equal(hist.at(-1)?.reason, "stream_ended");
    await c.close();
  });

  test("the first successful turn auto-titles the session and rebrands its branch", async () => {
    const c = await client();
    fake().titleReply = "Add a websocket transport";
    const { id, fs } = await createFake(c, "please add websockets to the transport layer");
    const before = await c.request<SessionSnapshot>("session.get", { id });
    assert.equal(before.title, "please add websockets to the transport layer");
    assert.equal(before.branch, `loom/${id.slice(0, 8)}`);

    fs.finishTurn();
    await waitFor(
      async () =>
        (await c.request<SessionSnapshot>("session.get", { id })).title ===
        "Add a websocket transport",
    );
    // the branch rename lands in the same step as the title
    assert.equal(
      (await c.request<SessionSnapshot>("session.get", { id })).branch,
      "loom/add-a-websocket-transport",
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
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).subagents.length === 2,
    );

    let snap = await c.request<SessionSnapshot>("session.get", { id });
    assert.deepEqual(
      snap.subagents.map((s) => [s.name, s.active]),
      [
        ["reviewer", true],
        ["tester", true],
      ],
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

  test("background tasks hold a finished turn in working_background, then release it", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);

    fs.emit({ type: "assistant_text", text: "spawning a background agent" });
    fs.emit({
      type: "background_tasks",
      tasks: [{ id: "b1", kind: "subagent", title: "audit deps" }],
    });
    // a live turn is unmoved by the background set…
    await waitFor(async () => {
      const s = await c.request<SessionSnapshot>("session.get", { id });
      return s.backgroundTasks.length === 1;
    });
    assert.equal(await statusOf(c, id), "running");

    // …but a clean result now settles to working_background, not idle
    fs.emit({ type: "result", kind: "ok" });
    await waitFor(async () => (await statusOf(c, id)) === "working_background");
    let snap = await c.request<SessionSnapshot>("session.get", { id });
    assert.deepEqual(
      snap.backgroundTasks.map((t) => [t.id, t.kind, t.title]),
      [["b1", "subagent", "audit deps"]],
    );

    // the task re-drives the loop → running
    fs.emit({ type: "assistant_text", text: "background agent finished, continuing" });
    await waitFor(async () => (await statusOf(c, id)) === "running");

    // and once the set drains, the next clean result is a plain idle
    fs.emit({ type: "background_tasks", tasks: [] });
    fs.emit({ type: "result", kind: "ok" });
    await waitFor(async () => (await statusOf(c, id)) === "idle");
    snap = await c.request<SessionSnapshot>("session.get", { id });
    assert.deepEqual(snap.backgroundTasks, []);
    await c.close();
  });

  test("a background task appearing while idle moves the session to working_background", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.finishTurn();
    await waitFor(async () => (await statusOf(c, id)) === "idle");

    fs.emit({
      type: "background_tasks",
      tasks: [{ id: "b1", kind: "shell", title: "npm run build" }],
    });
    await waitFor(async () => (await statusOf(c, id)) === "working_background");

    fs.emit({ type: "background_tasks", tasks: [] });
    await waitFor(async () => (await statusOf(c, id)) === "idle");
    await c.close();
  });

  test("rate_limit events surface on the session snapshot, keyed by window", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    const fiveReset = Date.now() + 3_600_000;
    const weekReset = Date.now() + 6 * 86_400_000;

    fs.emit({
      type: "rate_limit",
      status: "allowed",
      window: "five_hour",
      utilization: 42,
      resetsAt: fiveReset,
    });
    await waitFor(
      async () =>
        Object.keys((await c.request<SessionSnapshot>("session.get", { id })).rateLimits).length ===
        1,
    );

    // A different window merges in rather than clobbering the first.
    fs.emit({
      type: "rate_limit",
      status: "allowed_warning",
      window: "seven_day",
      utilization: 88,
      resetsAt: weekReset,
    });
    await waitFor(
      async () =>
        Object.keys((await c.request<SessionSnapshot>("session.get", { id })).rateLimits).length ===
        2,
    );

    const snap = await c.request<SessionSnapshot>("session.get", { id });
    assert.deepEqual(snap.rateLimits.five_hour, {
      status: "allowed",
      utilization: 42,
      resetsAt: fiveReset,
    });
    assert.deepEqual(snap.rateLimits.seven_day, {
      status: "allowed_warning",
      utilization: 88,
      resetsAt: weekReset,
    });
    await c.close();
  });

  test("a rate_limit window drops off the snapshot once its reset time passes", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);

    fs.emit({
      type: "rate_limit",
      status: "allowed",
      window: "five_hour",
      utilization: 42,
      resetsAt: Date.now() + 40,
    });
    // No "window appeared" wait here on purpose: the 40ms reset expires faster
    // than a poll may land under load (the previous test covers appearance
    // with a future reset). This test's claim is the drop-off itself.
    await waitFor(
      async () =>
        Object.keys((await c.request<SessionSnapshot>("session.get", { id })).rateLimits).length ===
        0,
      5_000,
    );
    await c.close();
  });

  test("setMode updates the row and forwards to a live adapter", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    const snap = await c.request<SessionSnapshot>("session.setMode", {
      id,
      mode: "plan",
      by: "tester",
    });
    assert.equal(snap.mode, "plan");
    assert.deepEqual(fs.modeChanges, ["plan"]);
    await assert.rejects(c.request("session.setMode", { id, mode: "bogus" }), /mode must be/);
    await c.close();
  });

  test("without a price table the provider's cost is kept, tagged costSource=provider", async () => {
    const c = await client();
    const { id, fs } = await createFake(c, "unpriced work");
    fs.finishTurn({ usage: { input: 100, output: 20 }, costUsd: 0.02 });
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 1,
    );
    const got = await c.request<SessionSnapshot>("session.get", { id });
    assert.ok(Math.abs(got.costUsd - 0.02) < 1e-9);
    assert.equal(got.costSource, "provider");
    await c.close();
  });

  test("a price table overrides the provider's cost, tagged costSource=table", async () => {
    writeFileSync(
      join(harness().repoRoot, ".loom", "models.toml"),
      `["fake-1"]\ninput = 3.0\noutput = 15.0\n`,
    );
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
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id: snap.id })).turns === 1,
    );

    const got = await c.request<SessionSnapshot>("session.get", { id: snap.id });
    // (1000*3 + 500*15) / 1e6 = 0.0105  — not the provider's 0.99
    assert.ok(Math.abs(got.costUsd - 0.0105) < 1e-9);
    assert.equal(got.costSource, "table");
    await c.close();
  });

  test("a turn's cache writes are priced at the TTL the turn wrote at", async () => {
    // The table prices input but no cache write — the normal case, since no
    // endpoint catalogue advertises one. The turn reports the ephemeral bucket
    // it wrote into, and that is what sets the multiple.
    writeFileSync(
      join(harness().repoRoot, ".loom", "models.toml"),
      `["fake-1"]\ninput = 3.0\noutput = 15.0\n`,
    );
    const c = await client();
    await c.request("pricing.reload");

    const snap = await c.request<SessionSnapshot>("session.create", {
      prompt: "cached work",
      provider: "fake",
      model: "fake-1",
    });
    await waitFor(() => fake().session(snap.id) !== undefined);
    const fs = fake().session(snap.id) as FakeSession;

    fs.finishTurn({ usage: { input: 0, output: 0, cacheWrite: 1_000_000 }, cacheTtlMinutes: 60 });
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id: snap.id })).turns === 1,
    );

    const got = await c.request<SessionSnapshot>("session.get", { id: snap.id });
    // 1M write at a 1h TTL = 2 x the 3.00 input rate. Was 0 before.
    assert.ok(Math.abs(got.costUsd - 6.0) < 1e-9, `got ${got.costUsd}`);
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
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 1,
    );

    await c.request("session.send", { id, text: "the second ask" });
    fs.finishTurn(); // turn 2
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 2,
    );

    const cps = await c.request<Array<{ turn: number; userText: string; rewindCostUsd: number }>>(
      "session.checkpoints",
      { id },
    );
    assert.deepEqual(
      cps.map((x) => x.turn),
      [1, 2],
    );
    assert.equal(cps[0]?.userText, "do work"); // the create prompt
    assert.equal(cps[1]?.userText, "the second ask");
    assert.equal(cps[1]?.rewindCostUsd, 0); // fake isn't priced / isn't aisdk

    // The fake advertises `capabilities.rewind`, so undo runs the harness path:
    // the daemon hands the adapter the checkpoint's fork ref, not a message count.
    await c.request("session.rewind", { id, toTurn: 1 });
    const rewound = await c.request<SessionSnapshot>("session.get", { id });
    assert.equal(rewound.turns, 1, "turn counter rolled back");
    assert.deepEqual(fs.rewinds, [{ keep: 0, at: "fake-turn-1" }], "adapter got the fork ref");
    const left = await c.request<Array<{ turn: number }>>("session.checkpoints", { id });
    assert.deepEqual(
      left.map((x) => x.turn),
      [1],
      "checkpoints past turn 1 dropped",
    );
    // out-of-range is still rejected
    await assert.rejects(c.request("session.rewind", { id, toTurn: 9 }), /toTurn must be 0/);
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
    const r = await c.request<{ ok: boolean; alreadyResolved: boolean }>(
      "session.respondPermission",
      {
        id,
        requestId: "p1",
        decision: "allow",
      },
    );
    await delay(40);
    assert.equal(r.alreadyResolved, true, "the pending id was dropped by the interrupt");
    assert.equal(
      await statusOf(c, id),
      "interrupted",
      "a stale answer must not flip a dead turn back to running",
    );
    await c.close();
  });

  test("interrupted is sticky for its own turn, but a later turn's events re-engage the machine", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.emit({ type: "assistant_text", text: "working" });
    await waitFor(async () => (await statusOf(c, id)) === "running");

    await c.request("session.interrupt", { id });
    await waitFor(async () => (await statusOf(c, id)) === "interrupted");

    // The interrupted turn's own trailing result is still swallowed…
    fs.finishTurn();
    await delay(40);
    assert.equal(
      await statusOf(c, id),
      "interrupted",
      "the interrupt stays sticky for its own turn",
    );

    // …but a subsequent turn is not frozen out: its permission_request lands.
    fs.emit({ type: "permission_request", id: "p9", tool: "Bash", input: {} });
    await waitFor(async () => (await statusOf(c, id)) === "awaiting_input");
    await c.close();
  });

  test("a compaction drops the checkpoints (their offsets are no longer valid)", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.finishTurn();
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 1,
    );
    await c.request("session.send", { id, text: "more" });
    fs.finishTurn();
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 2,
    );

    let cps = await c.request<Array<{ turn: number }>>("session.checkpoints", { id });
    assert.deepEqual(
      cps.map((x) => x.turn),
      [1, 2],
    );

    fs.emit({ type: "compact", trigger: "manual", before: 100, after: 30 });
    await delay(40);

    cps = await c.request<Array<{ turn: number }>>("session.checkpoints", { id });
    assert.deepEqual(cps, [], "checkpoints cleared after a compaction");
    await c.close();
  });

  // --- Phase 1: per-session serialization + cooperative cancellation ----------

  test("session.send is refused with code=busy while a compact is in flight", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.finishTurn({ contextUsed: 50_000 });
    await waitFor(async () => (await statusOf(c, id)) === "idle");

    const latestCompacting = () => {
      const st = c.getState();
      return st.tag === "data" ? st.value.sessions.find((x) => x.id === id)?.compacting : undefined;
    };

    const release = fs.blockCompact();
    const compacting = c.request("session.compact", { id }); // held on the gate
    await waitFor(() => fs.compacts.length === 1);
    // `fs.compacts` ticks synchronously in the adapter; the snapshot that
    // carries the flag still has a socket round-trip to make — wait for it rather
    // than racing the delivery.
    await waitFor(() => latestCompacting() !== undefined);

    // The in-flight compaction rides the snapshot (beats aren't persisted), so a
    // client that attaches mid-compaction still shows "compacting…" — with the
    // context fill it started from.
    const flag = latestCompacting();
    assert.ok(flag, "the snapshot reports the in-flight compaction");
    assert.equal(typeof flag.startedAt, "number");
    assert.equal(flag.before, 50_000, "`before` is the pre-compact context fill");

    await assert.rejects(
      c.request("session.send", { id, text: "hi" }),
      (e: unknown) => (e as { code?: unknown }).code === "busy",
    );

    release();
    await compacting;
    // The overlay rides the snapshot only while the gate is held — the release
    // publishes a fresh snapshot without the flag.
    await waitFor(() => latestCompacting() === undefined);
    assert.equal(latestCompacting(), undefined, "the overlay clears when the gate releases");
    assert.equal(fs.compacts.length, 1);
    assert.deepEqual(fs.sends, [], "the send never reached the adapter");
    await c.close();
  });

  test("compact then rewind serialize; the compact event precedes the rewind's idle transition", async () => {
    const c = await client();
    const frames: PushFrame[] = [];
    c.onPush((f) => frames.push(f));
    const { id, fs } = await createFake(c);
    fs.finishTurn();
    fs.finishTurn();
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 2,
    );
    await waitFor(async () => (await statusOf(c, id)) === "idle");

    const release = fs.blockCompact();
    const compacting = c.request("session.compact", { id });
    await waitFor(() => fs.compacts.length === 1);

    const rewinding = c.request("session.rewind", { id, toTurn: 1 });
    await delay(20);
    assert.deepEqual(fs.rewinds, [], "rewind is queued behind the compact, not racing it");

    release();
    await compacting;
    await rewinding;

    const compactSeq = frames.find((f) => f.type === "event" && f.event.type === "compact")?.seq;
    const rewindIdleSeq = frames.find(
      (f) => f.type === "event" && f.event.type === "status_changed" && f.event.note === "rewind",
    )?.seq;
    assert.ok(compactSeq !== undefined, "a compact frame was emitted");
    assert.ok(rewindIdleSeq !== undefined, "a rewind idle transition was emitted");
    assert.ok(
      (compactSeq as number) < (rewindIdleSeq as number),
      `compact ${compactSeq} should precede the rewind's idle ${rewindIdleSeq}`,
    );
    await c.close();
  });

  test("interrupt during a compact cancels it without clobbering state", async () => {
    const c = await client();
    const frames: PushFrame[] = [];
    c.onPush((f) => frames.push(f));
    const { id, fs } = await createFake(c);
    fs.finishTurn({ contextUsed: 50_000 });
    await waitFor(async () => (await statusOf(c, id)) === "idle");

    const release = fs.blockCompact();
    const compacting = c.request("session.compact", { id });
    await waitFor(() => fs.compacts.length === 1);

    await c.request("session.interrupt", { id });
    assert.equal(fs.interruptCount, 1, "the adapter was told to cancel");
    assert.equal(await statusOf(c, id), "idle", "the pre-compact state is untouched");

    release();
    await compacting;
    await delay(20);

    assert.equal(await statusOf(c, id), "idle");
    assert.ok(
      !frames.some(
        (f) =>
          f.type === "event" &&
          f.event.type === "status_changed" &&
          f.event.status.kind === "interrupted",
      ),
      "no interrupted transition was emitted",
    );
    assert.ok(
      !frames.some((f) => f.type === "event" && f.event.type === "compact"),
      "the compact boundary never landed",
    );
    await c.close();
  });

  test("interrupt on an idle session does not clobber status", async () => {
    const c = await client();
    const frames: PushFrame[] = [];
    c.onPush((f) => frames.push(f));
    const { id, fs } = await createFake(c);
    fs.finishTurn();
    await waitFor(async () => (await statusOf(c, id)) === "idle");

    await c.request("session.interrupt", { id });
    assert.equal(await statusOf(c, id), "idle");
    assert.equal(fs.interruptCount, 0, "the adapter is not touched for a settled session");
    assert.ok(
      !frames.some(
        (f) =>
          f.type === "event" &&
          f.event.type === "status_changed" &&
          f.event.status.kind === "interrupted",
      ),
    );
    await c.close();
  });

  test("rewind is rejected for awaiting_input and working_background", async () => {
    const c = await client();

    const a = await createFake(c);
    a.fs.finishTurn();
    await waitFor(async () => (await statusOf(c, a.id)) === "idle");
    a.fs.emit({ type: "permission_request", id: "p1", tool: "Bash", input: {} });
    await waitFor(async () => (await statusOf(c, a.id)) === "awaiting_input");
    await assert.rejects(
      c.request("session.rewind", { id: a.id, toTurn: 0 }),
      /interrupt the session before rewinding it/,
    );

    const b = await createFake(c);
    b.fs.finishTurn();
    await waitFor(async () => (await statusOf(c, b.id)) === "idle");
    b.fs.emit({
      type: "background_tasks",
      tasks: [{ id: "b1", kind: "shell", title: "sleep 100" }],
    });
    await waitFor(async () => (await statusOf(c, b.id)) === "working_background");
    await assert.rejects(
      c.request("session.rewind", { id: b.id, toTurn: 0 }),
      /interrupt the session before rewinding it/,
    );
    await c.close();
  });

  test("respondPermission after stream end is alreadyResolved and does not forward", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.emit({ type: "permission_request", id: "p1", tool: "Bash", input: {} });
    await waitFor(async () => (await statusOf(c, id)) === "awaiting_input");
    fs.endStream();
    await waitFor(async () => (await statusOf(c, id)) === "interrupted");

    const r = await c.request<{ ok: boolean; alreadyResolved: boolean }>(
      "session.respondPermission",
      { id, requestId: "p1", decision: "allow" },
    );
    assert.equal(r.alreadyResolved, true);
    assert.deepEqual(fs.permissionResponses, [], "nothing was forwarded to the dead adapter");
    await c.close();
  });

  test("setMode after stream end throws /session has ended/", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.emit({ type: "assistant_text", text: "x" });
    await waitFor(async () => (await statusOf(c, id)) === "running");
    fs.endStream();
    await waitFor(async () => (await statusOf(c, id)) === "interrupted");

    await assert.rejects(c.request("session.setMode", { id, mode: "plan" }), /session has ended/);
    await c.close();
  });
  // --- snapshot-complete outstanding requests (state-sync §1) ------------

  test("a snapshot carries the complete permission — a second client answers it cold", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.emit({
      type: "permission_request",
      id: "p1",
      tool: "Bash",
      input: { command: "ls -la" },
      suggestions: [{ behavior: "allow" }],
    });
    await waitFor(async () => (await statusOf(c, id)) === "awaiting_input");

    // A client that attached after the request was raised, and has downloaded
    // no transcript at all, still sees everything it needs to act.
    const c2 = await client();
    const s = await c2.request<SessionSnapshot>("session.get", { id });
    assert.deepEqual(s.requests, [
      {
        kind: "permission",
        id: "p1",
        tool: "Bash",
        input: { command: "ls -la" },
        suggestions: [{ behavior: "allow" }],
        at: s.requests[0]!.at,
      },
    ]);

    const r = await c2.request<{ ok: boolean; alreadyResolved: boolean }>(
      "session.respondPermission",
      { id, requestId: "p1", decision: "allow" },
    );
    assert.deepEqual(r, { ok: true, alreadyResolved: false });
    assert.equal(fs.permissionResponses.length, 1);
    await waitFor(async () => {
      const after = await c2.request<SessionSnapshot>("session.get", { id });
      return after.requests.length === 0;
    });
    await c.close();
    await c2.close();
  });

  test("answering one of several permissions leaves the rest and reaches both clients", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    const c2 = await client();
    const seen: SessionSnapshot[] = [];
    c2.subscribe((s) => {
      if (s.tag !== "data") return;
      const found = s.value.sessions.find((x) => x.id === id);
      if (found) seen.push(found);
    });

    for (const p of ["p1", "p2", "p3"]) {
      fs.emit({ type: "permission_request", id: p, tool: "Bash", input: { command: p } });
    }
    await waitFor(async () => {
      const s = await c.request<SessionSnapshot>("session.get", { id });
      return s.requests.length === 3;
    });
    const blocked = await c.request<SessionSnapshot>("session.get", { id });
    assert.deepEqual(
      blocked.requests.map((r) => r.id),
      ["p1", "p2", "p3"],
      "oldest first",
    );

    await c.request("session.respondPermission", { id, requestId: "p2", decision: "allow" });

    // Exactly that request disappears; the turn stays blocked on the others,
    // and the change is published even though the status never changed.
    await waitFor(() =>
      seen.some(
        (s) =>
          s.status.kind === "awaiting_input" &&
          s.requests.length === 2 &&
          s.requests.every((r) => r.id !== "p2"),
      ),
    );
    const rest = await c2.request<SessionSnapshot>("session.get", { id });
    assert.equal(rest.status.kind, "awaiting_input");
    assert.deepEqual(
      rest.requests.map((r) => r.id),
      ["p1", "p3"],
    );
    await c.close();
    await c2.close();
  });

  test("questions, AskUserQuestion and plan reviews are complete in the snapshot", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);

    fs.emit({ type: "question", id: "q1", question: "which db?", context: "postgres or sqlite" });
    await waitFor(async () => (await awaitReasonOf(c, id)) === "question");
    assert.deepEqual(
      (await c.request<SessionSnapshot>("session.get", { id })).requests.map((r) =>
        r.kind === "question" ? { kind: r.kind, id: r.id, q: r.question, ctx: r.context } : r.kind,
      ),
      [{ kind: "question", id: "q1", q: "which db?", ctx: "postgres or sqlite" }],
    );

    fs.emit({ type: "plan_review", id: "pl1", plan: "1. do it\n2. done" });
    await waitFor(async () => (await awaitReasonOf(c, id)) === "plan_review");
    const withPlan = await c.request<SessionSnapshot>("session.get", { id });
    const plan = withPlan.requests.find((r) => r.kind === "plan_review");
    assert.deepEqual(plan && { id: plan.id, plan: plan.plan }, {
      id: "pl1",
      plan: "1. do it\n2. done",
    });

    // The SDK's own AskUserQuestion is a multiple-choice prompt, not a gate —
    // it keeps the tool input so a cold client can render the choices.
    const questions = [{ question: "pick", header: "opt", options: [{ label: "a" }] }];
    fs.emit({
      type: "permission_request",
      id: "aq1",
      tool: "AskUserQuestion",
      input: { questions },
    });
    await waitFor(async () => (await awaitReasonOf(c, id)) === "user_question");
    const withAq = await c.request<SessionSnapshot>("session.get", { id });
    const aq = withAq.requests.find((r) => r.id === "aq1");
    assert.equal(aq?.kind, "user_question");
    assert.deepEqual(aq?.kind === "user_question" ? aq.input : null, { questions });
    assert.deepEqual(
      withAq.requests.map((r) => r.id),
      ["q1", "pl1", "aq1"],
    );
    await c.close();
  });

  test("compaction progress rides the snapshot, from its beats to the landing compact", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    const at = Date.now();
    fs.emit({ type: "compact_progress", ts: at, elapsedMs: 4_000, generated: 120, before: 90_000 });
    await waitFor(async () => {
      const s = await c.request<SessionSnapshot>("session.get", { id });
      return s.compacting !== undefined;
    });
    assert.deepEqual(await snapshotCompacting(c, id), {
      startedAt: at - 4_000,
      before: 90_000,
      generated: 120,
    });

    fs.emit({ type: "compact_progress", ts: at, elapsedMs: 9_000, generated: 640, before: 90_000 });
    await waitFor(async () => (await snapshotCompacting(c, id))?.generated === 640);

    fs.emit({ type: "compact", trigger: "auto", before: 90_000, after: 20_000 });
    await waitFor(async () => (await snapshotCompacting(c, id)) === undefined);
    await c.close();
  });

  test("a stream that ends clears the outstanding requests off the snapshot", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.emit({ type: "permission_request", id: "p1", tool: "Bash", input: {} });
    fs.emit({ type: "question", id: "q1", question: "still there?" });
    await waitFor(async () => {
      const s = await c.request<SessionSnapshot>("session.get", { id });
      return s.requests.length === 2;
    });

    fs.endStream();
    await waitFor(async () => (await statusOf(c, id)) === "interrupted");
    assert.deepEqual((await c.request<SessionSnapshot>("session.get", { id })).requests, []);
    await c.close();
  });

  test("an interrupt clears the outstanding requests off the snapshot", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.emit({ type: "permission_request", id: "p1", tool: "Bash", input: {} });
    await waitFor(async () => (await statusOf(c, id)) === "awaiting_input");

    await c.request("session.interrupt", { id });
    await waitFor(async () => (await statusOf(c, id)) === "interrupted");
    assert.deepEqual((await c.request<SessionSnapshot>("session.get", { id })).requests, []);
    await c.close();
  });
});
