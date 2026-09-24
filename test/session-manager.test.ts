import { signalOf } from "../backend/daemon/src/daemon/startup.ts";
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
import { FakeProvider as FakeProviderClass } from "@loom/connector-mock";
import { SessionManager } from "@loom/daemon/daemon/session-manager";
import { makeLogger } from "@loom/core/logger";

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
    fs.emit({
      type: "usage",
      tokens: { input: 0, output: 20, cacheRead: 0, cacheWrite: 0 },
      contextUsed: 50,
      contextLimit: 100,
    });
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).contextUsed === 50,
    );
    assert.equal(
      (await c.request<SessionSnapshot>("session.get", { id })).cache.lastTurnAt,
      snap.cache.lastTurnAt,
    );
    await c.close();
  });

  test("a context beat moves the meter and nothing else", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.finishTurn({
      usage: { input: 1200, cacheRead: 9000, cacheWrite: 250 },
      contextUsed: 40_000,
    });
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).turns === 1,
    );
    const settled = await c.request<SessionSnapshot>("session.get", { id });

    fs.emit({ type: "context", contextUsed: 150_000 });
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).contextUsed === 150_000,
    );

    // Only the numerator moved. No tokens were billed, no turn closed, and the
    // cache countdown is still armed by the turn that actually ended — a beat
    // that re-armed it would restart the clock on every model request.
    const snap = await c.request<SessionSnapshot>("session.get", { id });
    assert.deepEqual(snap.usage, settled.usage);
    assert.equal(snap.turns, settled.turns);
    assert.equal(snap.costUsd, settled.costUsd);
    assert.equal(snap.contextLimit, settled.contextLimit);
    assert.deepEqual(snap.cache, settled.cache);

    fs.emit({ type: "context", contextUsed: 150_000, contextLimit: 200_000 });
    fs.emit({
      type: "usage",
      tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextUsed: 150_001,
      contextLimit: 0,
    });
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id })).contextUsed === 150_001,
    );
    assert.equal(
      (await c.request<SessionSnapshot>("session.get", { id })).contextLimit,
      200_000,
      "a usage report without capacity must preserve the previously discovered limit",
    );
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

  for (const stop of ["interrupt", "stream_end"] as const) {
    test(`${stop} retires active subagents without losing their history`, async () => {
      const c = await client();
      const { id, fs } = await createFake(c);
      fs.emit({ type: "subagent_started", subagentId: "t1", name: "reviewer" });
      await waitFor(
        async () =>
          (await c.request<SessionSnapshot>("session.get", { id })).subagents.length === 1,
      );
      if (stop === "interrupt") await c.request("session.interrupt", { id });
      else await fs.close();
      await waitFor(
        async () =>
          (await c.request<SessionSnapshot>("session.get", { id })).subagents[0]?.active === false,
      );
      const snap = await c.request<SessionSnapshot>("session.get", { id });
      assert.deepEqual(snap.subagents, [{ id: "t1", name: "reviewer", active: false }]);
      if (stop === "interrupt") {
        await c.request("session.send", { id, text: "continue" });
        fs.finishTurn();
        await waitFor(async () => (await statusOf(c, id)) === "idle");
        assert.equal(
          (await c.request<SessionSnapshot>("session.get", { id })).subagents[0]?.active,
          false,
        );
      }
      await c.close();
    });
  }

  test("interrupt retains unresolved children, exposes failures and supports retry", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.emit({ type: "subagent_started", subagentId: "child", name: "reviewer" });
    fs.emit({
      type: "background_tasks",
      tasks: [{ id: "bg", kind: "subagent", title: "detached" }],
    });
    await waitFor(
      async () =>
        (await c.request<SessionSnapshot>("session.get", { id })).backgroundTasks.length === 1,
    );
    let reject!: (err: Error) => void;
    fs.interrupt = () =>
      new Promise<void>((_resolve, r) => {
        reject = r;
      });
    const failure = assert.rejects(
      c.request("session.interrupt", { id }),
      /Could not stop all session work/,
    );
    await waitFor(async () => !!(await c.request<SessionSnapshot>("session.get", { id })).stopping);
    let snap = await c.request<SessionSnapshot>("session.get", { id });
    assert.equal(snap.subagents[0]?.active, true);
    assert.equal(snap.backgroundTasks.length, 1);
    assert.notEqual(snap.status.kind, "interrupted");
    await assert.rejects(c.request("session.send", { id, text: "racing send" }), /stopping/);
    reject(new Error("child stop rejected"));
    await failure;
    snap = await c.request<SessionSnapshot>("session.get", { id });
    assert.equal(snap.status.kind, "error");
    assert.equal(snap.stopFailed, true);
    assert.equal(snap.stopping, undefined);
    assert.equal(snap.subagents[0]?.active, true);
    assert.equal(snap.backgroundTasks.length, 1);
    let finishStop!: () => void;
    fs.interrupt = () =>
      new Promise<void>((resolve) => {
        finishStop = resolve;
      });
    const retry = c.request("session.interrupt", { id });
    await waitFor(async () => !!(await c.request<SessionSnapshot>("session.get", { id })).stopping);
    snap = await c.request<SessionSnapshot>("session.get", { id });
    assert.equal(snap.stopFailed, undefined, "retrying is stopping, not also failed");
    await assert.rejects(c.request("session.send", { id, text: "retry racing send" }), /stopping/);
    finishStop();
    await retry;
    snap = await c.request<SessionSnapshot>("session.get", { id });
    assert.equal(snap.status.kind, "interrupted");
    assert.equal(snap.stopFailed, undefined);
    assert.equal(snap.subagents[0]?.active, false);
    assert.deepEqual(snap.backgroundTasks, []);
    fs.emit({ type: "subagent_started", subagentId: "late", name: "stale" });
    fs.emit({
      type: "background_tasks",
      tasks: [{ id: "late", kind: "subagent", title: "stale" }],
    });
    await delay(20);
    snap = await c.request<SessionSnapshot>("session.get", { id });
    assert.ok(!snap.subagents.some((s) => s.active));
    assert.deepEqual(snap.backgroundTasks, []);
    await c.request("session.send", { id, text: "continue after retry" });
    assert.equal(await statusOf(c, id), "running");
    assert.equal(fs.sends.at(-1), "continue after retry");
    await c.close();
  });

  test("a permission reply cannot hide a concurrent cancellation failure", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.emit({ type: "permission_request", id: "p1", tool: "Bash", input: {} });
    await waitFor(async () => (await statusOf(c, id)) === "awaiting_input");
    let release: (() => void) | undefined;
    fs.respondToPermission = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const reply = c.request("session.respondPermission", {
      id,
      requestId: "p1",
      decision: "allow",
    });
    await waitFor(() => release !== undefined);
    fs.interrupt = async () => {
      throw new Error("stop failed");
    };
    await assert.rejects(c.request("session.interrupt", { id }), /stop failed/);
    release!();
    await reply;
    assert.equal(await statusOf(c, id), "error");
    assert.equal((await c.request<SessionSnapshot>("session.get", { id })).stopFailed, true);
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
      observedAt: snap.rateLimits.five_hour?.observedAt,
      status: "allowed",
      utilization: 42,
      resetsAt: fiveReset,
    });
    assert.deepEqual(snap.rateLimits.seven_day, {
      observedAt: snap.rateLimits.seven_day?.observedAt,
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

  test("reported cost wins over a legacy local price table", async () => {
    writeFileSync(
      join(harness().repoRoot, ".loom", "models.toml"),
      `["fake-1"]\ninput = 3.0\noutput = 15.0\n`,
    );
    const c = await client();
    const reloaded = await c.request<{ models: string[] }>("pricing.reload");
    assert.ok(!reloaded.models.includes("fake-1"));

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
    // Reported cost is authoritative.
    assert.ok(Math.abs(got.costUsd - 0.99) < 1e-9);
    assert.equal(got.costSource, "provider");
    await c.close();
  });

  test("missing reported or endpoint prices remain unknown despite a legacy table", async () => {
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

    fs.emit({
      type: "usage",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 },
      contextUsed: 1_000_000,
      contextLimit: 2_000_000,
      cacheTtlMinutes: 60,
    });
    fs.emit({ type: "result", kind: "ok" });
    await waitFor(
      async () => (await c.request<SessionSnapshot>("session.get", { id: snap.id })).turns === 1,
    );

    const got = await c.request<SessionSnapshot>("session.get", { id: snap.id });
    // A provider-reported zero is known, but no report must remain unknown.
    assert.equal(got.costUsd, 0);
    assert.equal(got.costSource, "none");
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

    // A late request cannot resurrect the interrupted turn.
    fs.emit({ type: "permission_request", id: "stale", tool: "Bash", input: {} });
    await delay(20);
    assert.equal(await statusOf(c, id), "interrupted");
    // …but an explicitly started subsequent turn is not frozen out.
    await c.request("session.send", { id, text: "continue" });
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

  // --- §6: one publication per complete event transition -------------------

  /** Every snapshot of `id` a client is handed, in delivery order. */
  const snapshotsOf = (c: LoomClient, id: string): SessionSnapshot[] => {
    const seen: SessionSnapshot[] = [];
    c.subscribe((st) => {
      if (st.tag !== "data") return;
      const s = st.value.sessions.find((x) => x.id === id);
      if (s) seen.push(s);
    });
    return seen;
  };

  test("a completed turn publishes one consistent state, never half of it", async () => {
    const c = await client();
    const { id, fs } = await createFake(c);
    fs.emit({ type: "assistant_text", text: "working" });
    await waitFor(async () => (await statusOf(c, id)) === "running");

    const seen = snapshotsOf(c, id);
    const turnsBefore = (await c.request<SessionSnapshot>("session.get", { id })).turns;

    // The turn ends: its usage lands, its turn count goes up, and the status
    // settles to idle. Those are one transition, and no subscriber may be shown
    // a snapshot from the middle of it.
    fs.emit({
      type: "usage",
      tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
      contextUsed: 120,
      contextLimit: 200_000,
    });
    fs.emit({ type: "result", kind: "ok", summary: "done" });
    await waitFor(async () => (await statusOf(c, id)) === "idle");

    const firstWithTurn = seen.find((s) => s.turns > turnsBefore);
    assert.ok(firstWithTurn, "the completed turn was published");
    assert.equal(
      firstWithTurn.status.kind,
      "idle",
      "the first snapshot carrying the new turn count already carries the settled status",
    );
    await c.close();
  });

  test("a rate-limit-only event reaches every attached client", async () => {
    const a = await client();
    const b = await client();
    const { id, fs } = await createFake(a);
    fs.emit({ type: "result", kind: "ok", summary: "done" });
    await waitFor(async () => (await statusOf(a, id)) === "idle");
    // Let everything that turn set off (the auto-titler) settle, so the only
    // thing that can publish from here is the event under test.
    await delay(400);
    const seenA = snapshotsOf(a, id);
    const seenB = snapshotsOf(b, id);

    // Nothing about this event moves the status or the usage totals. It still
    // changes the snapshot, so it still has to be published — a client that
    // never calls `session.get` would otherwise never learn about it.
    fs.emit({
      type: "rate_limit",
      window: "five_hour",
      status: "allowed_warning",
      utilization: 0.82,
    });

    const utilOf = (seen: SessionSnapshot[]): number | undefined =>
      seen.at(-1)?.rateLimits["five_hour"]?.utilization;
    await waitFor(() => utilOf(seenA) === 0.82 && utilOf(seenB) === 0.82, 3000);
    assert.ok(seenA.length > 0 && seenB.length > 0, "the event published to both clients");
    await a.close();
    await b.close();
  });

  test("resolving one parallel request publishes the rest, with no status change", async () => {
    const a = await client();
    const b = await client();
    const { id, fs } = await createFake(a);
    fs.emit({ type: "permission_request", id: "p1", tool: "Bash", input: {} });
    fs.emit({ type: "permission_request", id: "p2", tool: "Write", input: {} });
    const requestsSeenBy = (c: LoomClient): string[] => {
      const st = c.getState();
      if (st.tag !== "data") return [];
      return (st.value.sessions.find((x) => x.id === id)?.requests ?? []).map((r) => r.id);
    };
    await waitFor(() => requestsSeenBy(b).length === 2, 3000);

    await a.request("session.respondPermission", {
      id,
      requestId: "p1",
      decision: "allow",
      by: "a",
    });

    // The session is still blocked on p2, so nothing about its *status*
    // changed — and the remaining set still has to reach both clients.
    await waitFor(() => requestsSeenBy(a).join() === "p2" && requestsSeenBy(b).join() === "p2");
    assert.equal(await statusOf(a, id), "awaiting_input");
    await a.close();
    await b.close();
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

// A failure in the persist/broadcast hook is not the session's problem: the
// agent keeps running either way, so its in-memory state has to keep up with
// it. Driven against a bare `SessionManager` — a real daemon's store does not
// fail on demand.
nodeTest("a failing emitEvent does not stop the session's state advancing", async () => {
  const provider = new FakeProviderClass();
  const emitFailures: string[] = [];
  const logged: string[] = [];
  const states: string[] = [];
  const mgr = new SessionManager({
    emitEvent: (ev) => {
      emitFailures.push(ev.type);
      throw new Error("transcript store is down");
    },
    onStatus: (_id, state) => {
      states.push(state.kind);
    },
    onUsage: () => {},
    onResult: () => {},
    onOverlay: () => {},
    onProviderRef: () => {},
    onMode: () => {},
    log: {
      ...makeLogger("test"),
      error: (msg: string) => {
        logged.push(msg);
      },
    },
  });

  await mgr.create(provider, {
    sessionId: "s1",
    cwd: "/tmp",
    prompt: "keep going",
    mode: "default",
    mcpServers: [],
    loomServer: false,
  });
  const fs = provider.session("s1");
  assert.ok(fs);

  fs.emit({ type: "permission_request", id: "p1", tool: "Bash", input: {} });
  await waitFor(() => mgr.requestsOf("s1").length === 1, 2000);

  assert.deepEqual(
    mgr.requestsOf("s1").map((r) => r.id),
    ["p1"],
    "the request set advanced even though nothing could be persisted",
  );
  assert.ok(states.includes("awaiting_input"), "and so did the turn state");
  assert.ok(emitFailures.length > 0, "the hook really did throw");
  assert.ok(
    logged.some((m) => /persist|broadcast/i.test(m)),
    `the failure is logged, not swallowed: ${logged.join(" | ")}`,
  );

  await mgr.shutdown();
});

test("account usage is shared with sibling and new sessions and survives daemon restart", async () => {
  let c = await client();
  const a = await createFake(c);
  const b = await createFake(c);
  const resetsAt = Date.now() + 60_000;
  a.fs.emit({
    type: "rate_limit",
    window: "five_hour",
    status: "allowed",
    utilization: 37,
    resetsAt,
  });
  await waitFor(
    async () =>
      (await c.request<SessionSnapshot>("session.get", { id: b.id })).rateLimits.five_hour
        ?.utilization === 37,
  );
  const d = await createFake(c);
  assert.equal(
    (await c.request<SessionSnapshot>("session.get", { id: d.id })).rateLimits.five_hour
      ?.utilization,
    37,
  );
  await c.close();
  await harness().restart();
  c = await client();
  assert.equal(
    (await c.request<SessionSnapshot>("session.get", { id: b.id })).rateLimits.five_hour
      ?.utilization,
    37,
  );
  await c.close();
});

test("reported zero cost remains authoritative", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);
  fs.emit({
    type: "usage",
    tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    contextUsed: 100,
    contextLimit: 1000,
    costDeltaUsd: 0,
  });
  await waitFor(
    async () => (await c.request<SessionSnapshot>("session.get", { id })).usage.input === 100,
  );
  const s = await c.request<SessionSnapshot>("session.get", { id });
  assert.equal(s.costSource, "provider");
  assert.equal(s.costUsd, 0);
  await c.close();
});

test("interrupt cancels a session before its provider is ready", async () => {
  const c = await client();
  const entered = Promise.withResolvers<string>();
  fake().createSession = async (opts) => {
    entered.resolve(opts.sessionId);
    const signal = signalOf(opts)!;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    signal.throwIfAborted();
    throw new Error("unreachable");
  };
  try {
    const creating = c.request<SessionSnapshot>("session.create", {
      provider: "fake",
      prompt: "accidental new chat",
    });
    const id = await entered.promise;
    const stopped = await c.request<SessionSnapshot>("session.interrupt", { id });
    assert.equal(stopped.status.kind, "interrupted");
    const created = await creating;
    assert.equal(created.status.kind, "interrupted");
    assert.equal(fake().session(id), undefined);
    assert.equal(await statusOf(c, id), "interrupted");
  } finally {
    await c.close();
  }
});

for (const failure of [false, true]) {
  for (const command of ["session.resume", "session.send"] as const) {
    test(`${command} recovers ${failure ? "a failed" : "an ended"} stream without restarting the daemon`, async () => {
      const c = await client();
      try {
        const { id, fs } = await createFake(c);
        fs.emit({ type: "assistant_text", text: "saved work" });
        await waitFor(async () => (await statusOf(c, id)) === "running");
        if (failure) fs.fail("OAuth access token has been revoked");
        fs.endStream();
        await waitFor(async () => (await statusOf(c, id)) === (failure ? "error" : "interrupted"));

        const before = await c.request<SessionSnapshot>("session.get", { id });
        const result = await c.request<SessionSnapshot & { injected?: boolean }>(
          command,
          command === "session.send" ? { id, text: "continue after login" } : { id },
        );
        const fresh = fake().session(id)!;
        assert.notEqual(fresh, fs);
        assert.equal(fs.closed, true);
        assert.equal(fresh.resumed, true);
        assert.equal(fresh.providerRef, fs.providerRef);
        assert.equal(result.worktree, before.worktree);
        assert.equal(result.branch, before.branch);
        assert.deepEqual(fs.sends, []);
        assert.deepEqual(fresh.sends, command === "session.send" ? ["continue after login"] : []);
        assert.equal(result.status.kind, command === "session.send" ? "running" : "idle");
        if (command === "session.send") assert.equal(result.injected, false);
      } finally {
        await c.close();
      }
    });
  }
}

test("concurrent resume and send wait for ended-worker cleanup and share one replacement", async () => {
  const c = await client();
  const other = await client();
  const sender = await client();
  const release = Promise.withResolvers<void>();
  const resume = FakeProviderClass.prototype.resumeSession;
  try {
    const { id, fs } = await createFake(c);
    fs.emit({ type: "assistant_text", text: "saved work" });
    await waitFor(async () => (await statusOf(c, id)) === "running");
    fs.endStream();
    await waitFor(async () => (await statusOf(c, id)) === "interrupted");
    const entered = Promise.withResolvers<void>();
    const close = fs.close.bind(fs);
    fs.close = async () => {
      entered.resolve();
      await release.promise;
      await close();
    };
    let resumes = 0;
    FakeProviderClass.prototype.resumeSession = async function (ref) {
      resumes++;
      assert.equal(fs.closed, true);
      return await resume.call(this, ref);
    };
    const first = c.request("session.resume", { id });
    await entered.promise;
    const second = other.request("session.resume", { id });
    const send = sender.request("session.send", { id, text: "continue" });
    await delay(20);
    assert.equal(resumes, 0);
    release.resolve();
    await Promise.all([first, second, send]);
    assert.equal(resumes, 1);
    assert.deepEqual(fake().session(id)!.sends, ["continue"]);
  } finally {
    FakeProviderClass.prototype.resumeSession = resume;
    release.resolve();
    await c.close();
    await other.close();
    await sender.close();
  }
});

test("resume still rejects a live session after a recoverable provider error", async () => {
  const c = await client();
  try {
    const { id, fs } = await createFake(c);
    fs.fail("authentication failed");
    await waitFor(async () => (await statusOf(c, id)) === "error");
    await assert.rejects(c.request("session.resume", { id }), /session is already running/);
    await c.request("session.send", { id, text: "retry" });
    assert.equal(fake().session(id), fs);
    assert.equal(fs.closed, false);
    assert.deepEqual(fs.sends, ["retry"]);
  } finally {
    await c.close();
  }
});

test("a crashed stream remains resumable after a failed authentication retry", async () => {
  const c = await client();
  const create = FakeProviderClass.prototype.createSession;
  const resume = FakeProviderClass.prototype.resumeSession;
  try {
    FakeProviderClass.prototype.createSession = async function (opts) {
      const session = await create.call(this, opts);
      const events = session.events.bind(session);
      session.events = async function* () {
        yield* events();
        throw new Error("Session VM connection ended");
      };
      return session;
    };
    const { id, fs } = await createFake(c);
    FakeProviderClass.prototype.createSession = create;
    fs.emit({ type: "assistant_text", text: "saved work" });
    await waitFor(async () => (await statusOf(c, id)) === "running");
    fs.endStream();
    await waitFor(async () => (await statusOf(c, id)) === "error");
    FakeProviderClass.prototype.resumeSession = async () => {
      throw new Error("Provider authentication: needs login");
    };
    await assert.rejects(c.request("session.resume", { id }), /needs login/);
    assert.equal(fs.closed, true);
    assert.equal(await statusOf(c, id), "error");
    FakeProviderClass.prototype.resumeSession = resume;
    const restored = await c.request<SessionSnapshot>("session.resume", { id });
    assert.equal(restored.status.kind, "idle");
    assert.equal(fake().session(id)!.resumed, true);
    assert.deepEqual(fake().session(id)!.sends, []);
  } finally {
    FakeProviderClass.prototype.createSession = create;
    FakeProviderClass.prototype.resumeSession = resume;
    await c.close();
  }
});
