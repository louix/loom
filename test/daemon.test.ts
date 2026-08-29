import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "../src/client/client.ts";
import type { HelloResult, PushFrame, SessionSnapshot } from "../src/protocol/wire.ts";
import type { FakeProvider } from "../src/provider/fake/fake.ts";
import { makeHarness, type Harness } from "./helpers.ts";

let h: Harness;

before(async () => {
  h = await makeHarness();
});
after(async () => {
  await h.cleanup();
});

async function client(reconnect = false): Promise<LoomClient> {
  return LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
    reconnect,
  });
}

test("hello handshake returns daemon info and an empty session list", async () => {
  const c = await client();
  assert.equal(c.daemonInfo?.repoRoot, h.repoRoot);
  assert.deepEqual(c.sessions, []);
  await c.close();
});

test("ping round-trips", async () => {
  const c = await client();
  const r = await c.request<{ nonce: unknown; uptimeMs: number }>("ping", { nonce: 42 });
  assert.equal(r.nonce, 42);
  assert.ok(r.uptimeMs >= 0);
  await c.close();
});

test("createStub inserts a session and it shows up in the sorted list", async () => {
  const c = await client();
  const stub = await c.request<SessionSnapshot>("session.createStub", {
    prompt: "do the thing",
    status: "running",
  });
  assert.equal(stub.status, "running");
  assert.equal(stub.title, "do the thing");

  const list = await c.request<SessionSnapshot[]>("session.list");
  assert.ok(list.some((s) => s.id === stub.id));
  await c.close();
});

test("session.list is ordered by status group then recency", async () => {
  const c = await client();
  await c.request("session.createStub", { prompt: "idle one", status: "idle" });
  await delay(2);
  await c.request("session.createStub", { prompt: "running one", status: "running" });
  await delay(2);
  const awaiting = await c.request<SessionSnapshot>("session.createStub", {
    prompt: "blocked one",
    status: "awaiting_input",
    reason: "permission",
  });

  const list = await c.request<SessionSnapshot[]>("session.list");
  // awaiting_input group sorts ahead of running, which sorts ahead of idle
  assert.equal(list[0]?.id, awaiting.id);
  const groups = list.map((s) => s.status);
  const rank = (s: string) => ["awaiting_input", "running", "interrupted", "idle", "error", "done"].indexOf(s);
  for (let i = 1; i < groups.length; i++) {
    assert.ok(rank(groups[i]!) >= rank(groups[i - 1]!), `group order violated at ${i}: ${groups}`);
  }
  await c.close();
});

test("dev.emit is broadcast to a subscribed client with a monotonic seq", async () => {
  const c = await client();
  const stub = await c.request<SessionSnapshot>("session.createStub", { prompt: "x" });

  const got: PushFrame[] = [];
  c.onPush((f) => got.push(f));

  const r1 = await c.request<{ seq: number }>("dev.emit", {
    event: { sessionId: stub.id, type: "assistant_text", text: "one" },
  });
  const r2 = await c.request<{ seq: number }>("dev.emit", {
    event: { sessionId: stub.id, type: "thinking", text: "two" },
  });
  assert.ok(r2.seq > r1.seq);

  await delay(20);
  const events = got.filter((f) => f.type === "event");
  assert.ok(events.length >= 2);
  const texts = events.map((f) => (f.type === "event" ? (f.event as { text?: string }).text : undefined));
  assert.ok(texts.includes("one") && texts.includes("two"));
  await c.close();
});

test("setStatus broadcasts a session_updated with a bumped version and attribution", async () => {
  const c = await client();
  const stub = await c.request<SessionSnapshot>("session.createStub", { prompt: "x", status: "running" });

  const updates: Array<{ version: number; by?: string; status: string }> = [];
  c.onPush((f) => {
    if (f.type === "session_updated" && f.session.id === stub.id) {
      updates.push({ version: f.version, status: f.session.status, ...(f.by ? { by: f.by } : {}) });
    }
  });

  await c.request("session.setStatus", { id: stub.id, status: "idle", by: "tester" });
  await delay(20);

  assert.ok(updates.length >= 1);
  const last = updates.at(-1)!;
  assert.equal(last.status, "idle");
  assert.equal(last.by, "tester");
  assert.ok(last.version >= 2);
  await c.close();
});

test("a fresh client (no sinceSeq) is told replaying:false and gets the snapshot", async () => {
  const c = await client();
  const raw = await c.request<HelloResult>("hello", { protocolVersion: 1, clientId: "probe" });
  assert.equal(raw.replaying, false);
  assert.equal(typeof raw.seq, "number");
  assert.ok(Array.isArray(raw.sessions));
  await c.close();
});

test("reconnecting within the buffer replays the gap (no resync)", async () => {
  const observer = await client(true);
  const driver = await client();
  const stub = await driver.request<SessionSnapshot>("session.createStub", { prompt: "gap" });

  const texts: string[] = [];
  observer.onPush((f) => {
    if (f.type === "event") {
      const t = (f.event as { text?: string }).text;
      if (t) texts.push(t);
    }
  });
  let reconnected = false;
  let resynced = false;
  observer.on("reconnect", () => {
    reconnected = true;
  });
  observer.on("resync", () => {
    resynced = true;
  });

  await driver.request("dev.emit", { event: { sessionId: stub.id, type: "thinking", text: "A-live" } });
  await delay(20);
  assert.ok(texts.includes("A-live"));

  // Transport drop, then an event lands while the observer is away.
  observer.dropForTest();
  await driver.request("dev.emit", { event: { sessionId: stub.id, type: "thinking", text: "B-gap" } });

  // Wait for the observer to come back and drain the replay.
  for (let i = 0; i < 100 && !reconnected; i++) await delay(10);
  await delay(30);

  assert.equal(reconnected, true);
  assert.equal(resynced, false, "gap was within the buffer — no resync expected");
  assert.ok(texts.includes("B-gap"), `missed the gap event; saw ${JSON.stringify(texts)}`);

  await observer.close();
  await driver.close();
});

test("hello with a stale high sinceSeq triggers a resync push", async () => {
  const c = await client();
  let resynced = false;
  c.on("resync", () => {
    resynced = true;
  });
  // Ask to replay from a seq far beyond head.
  await c.request("hello", { protocolVersion: 1, clientId: "stale", sinceSeq: 999_999 });
  await delay(30);
  assert.equal(resynced, true);
  await c.close();
});

test("daemon.status reflects live counts", async () => {
  const c = await client();
  const s = await c.request<{ sessions: number; clients: number; eventSeq: number }>("daemon.status");
  assert.ok(s.sessions >= 1);
  assert.ok(s.clients >= 1);
  assert.ok(s.eventSeq >= 1);
  await c.close();
});

test("providers.list reports claude plus configured aisdk profiles with palette colours", async () => {
  const hh = await makeHarness({
    config: `
default_provider = "openai"

[providers.openai]
adapter  = "aisdk"
base_url = "https://api.openai.com/v1"
model    = "gpt-5"
models   = ["gpt-5", "gpt-5-mini"]

[providers.deepseek]
adapter  = "aisdk"
base_url = "https://api.deepseek.com/v1"
model    = "deepseek-chat"
color    = "red"
`,
  });
  try {
    const c = await LoomClient.connect({ repoRoot: hh.repoRoot, sockPath: hh.sockPath, autospawn: false });
    const list = await c.request<
      Array<{ id: string; models: string[]; color: string; isDefault: boolean }>
    >("providers.list");
    await c.close();

    const byId = new Map(list.map((p) => [p.id, p]));
    assert.ok(byId.has("claude"));
    assert.deepEqual(byId.get("openai")?.models, ["gpt-5", "gpt-5-mini"]);
    assert.equal(byId.get("openai")?.isDefault, true);
    assert.equal(byId.get("claude")?.isDefault, false);
    // first aisdk profile gets the first palette colour; explicit wins
    assert.equal(byId.get("openai")?.color, "cyan");
    assert.equal(byId.get("deepseek")?.color, "red");
  } finally {
    await hh.cleanup();
  }
});

test("session.fork copies the transcript into a new session + worktree", async () => {
  const hh = await makeHarness({
    config: `
[providers.openai]
adapter  = "aisdk"
base_url = "http://127.0.0.1:9/v1"
model    = "gpt-5"
`,
  });
  try {
    const c = await LoomClient.connect({ repoRoot: hh.repoRoot, sockPath: hh.sockPath, autospawn: false });

    const parent = await c.request<SessionSnapshot>("session.createStub", {
      prompt: "the trunk task",
      status: "idle",
      provider: "openai",
    });
    // seed a 4-message transcript for the parent
    const db = hh.daemon.db;
    const ins = db.prepare(
      "INSERT INTO provider_messages (session_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, 0)",
    );
    for (let i = 0; i < 4; i++) ins.run(parent.id, i, i % 2 ? "assistant" : "user", `"m${i}"`);

    const fork = await c.request<SessionSnapshot>("session.fork", { id: parent.id });
    assert.equal(fork.parentId, parent.id);
    assert.equal(fork.forkTurn, parent.turns);
    assert.notEqual(fork.worktree, parent.worktree);
    assert.match(fork.title ?? "", /\(fork\)$/);

    const copied = db
      .prepare("SELECT COUNT(*) AS n FROM provider_messages WHERE session_id = ?")
      .get(fork.id) as { n: number };
    assert.equal(copied.n, 4);

    // fork a fake session → rejected for now
    const fk = await c.request<SessionSnapshot>("session.createStub", { prompt: "x", provider: "fake" });
    await assert.rejects(c.request("session.fork", { id: fk.id }), /aisdk-only/);

    await c.close();
  } finally {
    await hh.cleanup();
  }
});

test("session.send during a live turn broadcasts an injected user_message; an idle send does not", async () => {
  const hh = await makeHarness();
  try {
    const c = await LoomClient.connect({ repoRoot: hh.repoRoot, sockPath: hh.sockPath, autospawn: false });
    const frames: PushFrame[] = [];
    c.onPush((f) => frames.push(f));

    const snap = await c.request<SessionSnapshot>("session.create", { prompt: "busy", provider: "fake" });
    const fs = ((await hh.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
    fs?.emit({ type: "assistant_text", text: "working…" }); // → running
    await delay(80);

    await c.request("session.send", { id: snap.id, text: "also handle Y" });
    await delay(60);
    const um = frames.find(
      (f) => f.type === "event" && (f.event as { type?: string }).type === "user_message",
    );
    assert.ok(um, "a user_message frame was broadcast");
    const ev = (um as { event: { text: string; injected: boolean } }).event;
    assert.equal(ev.text, "also handle Y");
    assert.equal(ev.injected, true);

    fs?.finishTurn(); // → idle
    await delay(60);
    frames.length = 0;
    await c.request("session.send", { id: snap.id, text: "next turn please" });
    await delay(60);
    assert.equal(
      frames.some((f) => f.type === "event" && (f.event as { type?: string }).type === "user_message"),
      false,
      "an idle send is a normal turn, not an injection",
    );

    await c.close();
  } finally {
    await hh.cleanup();
  }
});
