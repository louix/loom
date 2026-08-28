import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "../src/client/client.ts";
import type { PushFrame, SessionSnapshot } from "../src/protocol/wire.ts";
import type { FakeProvider, FakeSession } from "../src/provider/fake/fake.ts";
import { makeHarness, type Harness } from "./helpers.ts";

let h: Harness;

before(async () => {
  h = await makeHarness();
});
after(async () => {
  await h.cleanup();
});

function client(reconnect = false): Promise<LoomClient> {
  return LoomClient.connect({ repoRoot: h.repoRoot, sockPath: h.sockPath, autospawn: false, reconnect });
}

function fake(): FakeProvider {
  return h.daemon.providers.get("fake") as FakeProvider;
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

  // events carry a per-session ordinal
  const evs = frames.filter((f) => f.type === "event" && f.event.sessionId === id);
  assert.ok(evs.length >= 3);
  assert.equal((evs[0] as { event: { ordinal?: number } }).event.ordinal, 0);

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

test("setMode updates the row and forwards to a live adapter", async () => {
  const c = await client();
  const { id, fs } = await createFake(c);
  const snap = await c.request<SessionSnapshot>("session.setMode", { id, mode: "plan", by: "tester" });
  assert.equal(snap.mode, "plan");
  assert.deepEqual(fs.modeChanges, ["plan"]);
  await assert.rejects(c.request("session.setMode", { id, mode: "bogus" }), /mode must be/);
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
