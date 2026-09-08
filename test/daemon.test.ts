import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import { PROTOCOL_VERSION } from "@loom/core/wire";
import type {
  DoctorReport,
  HelloResult,
  HistoryPage,
  SearchResult,
  PushFrame,
  SessionSnapshot,
} from "@loom/core/wire";
import { loomPaths } from "@loom/core/paths";
import { stateIdle, stateRunning } from "@loom/core/session-state";
import type { FakeProvider } from "@loom/connector-mock";
import { Daemon } from "@loom/daemon/daemon/daemon";
import { makeHarness, type Harness } from "@loom/harness";

/** Minimal OpenAI-style `/v1/models` endpoint; returns its base URL + a close fn.
 *  Rows may be bare ids or full objects (endpoints like OpenRouter extend rows
 *  with `context_length`-style metadata). */
const modelsStub = (
  rows: Array<string | Record<string, unknown>>,
): Promise<{ base: string; close: () => void }> => {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if ((req.url ?? "").endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: rows.map((r) => (typeof r === "string" ? { id: r } : r)) }));
      } else {
        res.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    });
  });
};

let h: Harness;

before(async () => {
  h = await makeHarness();
});
after(async () => {
  await h.cleanup();
});

const client = async (reconnect = false): Promise<LoomClient> => {
  return LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
    reconnect,
  });
};

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 1000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start >= ms) throw new Error("condition not met in time");
    await delay(5);
  }
};

test("hello handshake returns daemon info and an empty fleet snapshot", async () => {
  const c = await client();
  assert.equal(c.daemonInfo?.repoRoot, h.repoRoot);
  // the TUI's version-mismatch auto-respawn keys off this field — any
  // non-empty build string (git-describe, a stamp, "unknown-version") is fine
  assert.ok((c.daemonInfo?.version ?? "").length > 0);
  const state = c.getState();
  assert.equal(state.tag, "data", "the handshake installs a snapshot");
  assert.deepEqual(state.tag === "data" ? state.value.sessions : null, []);
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
  assert.equal(stub.status.kind, "running");
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
  const groups = list.map((s) => s.status.kind);
  const rank = (s: string) =>
    ["awaiting_input", "running", "interrupted", "idle", "error", "done"].indexOf(s);
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
  const texts = events.map((f) =>
    f.type === "event" ? (f.event as { text?: string }).text : undefined,
  );
  assert.ok(texts.includes("one") && texts.includes("two"));
  await c.close();
});

test("session.events returns a session's durable history, oldest first, excluding status/compact/context heartbeats", async () => {
  const c = await client();
  const stub = await c.request<SessionSnapshot>("session.createStub", { prompt: "x" });

  await c.request("dev.emit", {
    event: { sessionId: stub.id, type: "assistant_text", text: "one" },
  });
  await c.request("dev.emit", { event: { sessionId: stub.id, type: "thinking", text: "two" } });
  // none of these should end up in the durable history — the TUI never
  // renders them either (see `applyPush` in the frontend model)
  await c.request("dev.emit", {
    event: { sessionId: stub.id, type: "status_changed", status: { kind: "running" } },
  });
  await c.request("dev.emit", {
    event: {
      sessionId: stub.id,
      type: "compact_progress",
      elapsedMs: 100,
      generated: 10,
      before: 1000,
    },
  });
  await c.request("dev.emit", {
    event: { sessionId: stub.id, type: "context", contextUsed: 40_000, contextLimit: 200_000 },
  });

  const page = await c.request<HistoryPage>("session.events", { id: stub.id });
  assert.deepEqual(
    page.items.map((e) => (e.event as { text?: string }).text),
    ["one", "two"],
  );
  assert.equal(page.olderCursor, null, "two rows is the whole history");
  assert.ok(page.items[0]!.id < page.items[1]!.id, "durable ids ascend with the transcript");

  // a capped fetch keeps the most recent N, still oldest-first
  const capped = await c.request<HistoryPage>("session.events", { id: stub.id, limit: 1 });
  assert.deepEqual(
    capped.items.map((e) => (e.event as { text?: string }).text),
    ["two"],
  );
  assert.deepEqual(capped.olderCursor, { olderThan: page.items[1]!.id });

  await assert.rejects(c.request("session.events", { id: "no-such-session" }));
  await c.close();
});

test("session.events: the cursor pages older rows; limit is clamped; a malformed cursor is rejected", async () => {
  const c = await client();
  const stub = await c.request<SessionSnapshot>("session.createStub", { prompt: "x" });
  for (let i = 1; i <= 5; i++) {
    await c.request("dev.emit", {
      event: { sessionId: stub.id, type: "assistant_text", text: `line ${i}` },
    });
  }
  const texts = (p: HistoryPage): Array<string | undefined> =>
    p.items.map((e) => (e.event as { text?: string }).text);

  const newest = await c.request<HistoryPage>("session.events", { id: stub.id, limit: 2 });
  assert.deepEqual(texts(newest), ["line 4", "line 5"]);

  const older = await c.request<HistoryPage>("session.events", {
    id: stub.id,
    limit: 2,
    cursor: newest.olderCursor,
  });
  assert.deepEqual(texts(older), ["line 2", "line 3"]);

  // The last page is exactly one row, and the daemon says so rather than
  // leaving the client to infer it from the length.
  const last = await c.request<HistoryPage>("session.events", {
    id: stub.id,
    limit: 2,
    cursor: older.olderCursor,
  });
  assert.deepEqual(texts(last), ["line 1"]);
  assert.equal(last.olderCursor, null);

  // negative / fractional limit must not reach `LIMIT ?` — clamped to ≥ 1, not
  // thrown, not "return everything".
  const clamped = await c.request<HistoryPage>("session.events", { id: stub.id, limit: -1 });
  assert.equal(clamped.items.length, 1); // clamped to 1, not all 5, no datatype throw
  assert.deepEqual(clamped.olderCursor, { olderThan: newest.items[1]!.id });
  await assert.doesNotReject(c.request("session.events", { id: stub.id, limit: 2.5 }));

  // A malformed cursor is a client bug and must read differently from
  // exhaustion — otherwise a paging loop stalls with no way to tell why.
  for (const bad of [{ olderThan: "2" }, { olderThan: 0 }, { olderThan: 1.5 }, { seq: 2 }, 7]) {
    await assert.rejects(
      c.request("session.events", { id: stub.id, cursor: bad }),
      /cursor must be/,
      `cursor ${JSON.stringify(bad)} should be rejected`,
    );
  }
  // An explicit null cursor is "the newest page", the same as omitting it.
  const nulled = await c.request<HistoryPage>("session.events", {
    id: stub.id,
    limit: 2,
    cursor: null,
  });
  assert.deepEqual(texts(nulled), ["line 4", "line 5"]);
  await c.close();
});

test("session.search returns every matching ID, including durable text in an unopened session", async () => {
  const c = await client();
  const ids: string[] = [];
  for (let i = 0; i < 55; i++) {
    const s = await c.request<SessionSnapshot>("session.createStub", { prompt: "zebra " + i });
    ids.push(s.id);
  }
  const buried = await c.request<SessionSnapshot>("session.createStub", { prompt: "unrelated" });
  await c.request("dev.emit", {
    event: { sessionId: buried.id, type: "assistant_text", text: "a zebra in the body" },
  });
  const result = await c.request<SearchResult>("session.search", { query: "'zebra" });
  assert.deepEqual(new Set(result.ids), new Set([...ids, buried.id]));
  assert.equal(result.ids.at(-1), buried.id);
  await c.close();
});

test("setStatus publishes a snapshot carrying the new status", async () => {
  const c = await client();
  const stub = await c.request<SessionSnapshot>("session.createStub", {
    prompt: "x",
    status: "running",
  });

  const statuses: string[] = [];
  c.subscribe((s) => {
    if (s.tag !== "data") return;
    const found = s.value.sessions.find((x) => x.id === stub.id);
    if (found) statuses.push(found.status.kind);
  });

  await c.request("session.setStatus", { id: stub.id, status: "idle", by: "tester" });
  await delay(20);

  assert.equal(statuses.at(-1), "idle");
  await c.close();
});

test("a fresh client (no sinceSeq) is told replaying:false", async () => {
  const c = await client();
  const raw = await c.request<HelloResult>("hello", {
    protocolVersion: PROTOCOL_VERSION,
    clientId: "probe",
  });
  assert.equal(raw.replaying, false);
  assert.equal(typeof raw.seq, "number");
  // The fleet rides the `state` push the handler enqueues, not this result.
  assert.equal("sessions" in raw, false);
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

  await driver.request("dev.emit", {
    event: { sessionId: stub.id, type: "thinking", text: "A-live" },
  });
  await delay(20);
  assert.ok(texts.includes("A-live"));

  // Transport drop, then an event lands while the observer is away.
  observer.dropForTest();
  await driver.request("dev.emit", {
    event: { sessionId: stub.id, type: "thinking", text: "B-gap" },
  });

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
  await c.request("hello", {
    protocolVersion: PROTOCOL_VERSION,
    clientId: "stale",
    sinceSeq: 999_999,
  });
  await delay(30);
  assert.equal(resynced, true);
  await c.close();
});

test("a reconnect onto a restarted daemon (new epoch) forces a resync", async () => {
  const hh = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
    reconnect: true,
  });
  try {
    // a couple of frames pre-restart → the old client's #lastSeq is small
    await c.request("session.createStub", { prompt: "a" });
    await c.request("session.createStub", { prompt: "b" });
    const lastSeq = c.lastSeq;
    let resyncs = 0;
    c.on("resync", () => {
      resyncs += 1;
    });

    await hh.restart();
    // Drive the NEW daemon's head *above* the old client's #lastSeq, so
    // `EventLog.since(lastSeq)` returns { rolled: false } and the only thing
    // that can trigger a resync is the epoch-mismatch branch in #handshake.
    const driver = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });
    for (let i = 0; i < lastSeq + 4; i++) {
      await driver.request("session.createStub", { prompt: `d${i}` });
    }
    await driver.close();

    await delay(500); // client's reconnect loop + handshake
    assert.equal(resyncs, 1, "the epoch change alone must force exactly one resync");
    assert.equal(c.lastSeq >= lastSeq, true, "re-baselined onto the new daemon's seq");
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("a client re-baselines its whole fleet from the snapshot after a daemon restart", async () => {
  const hh = await makeHarness();
  try {
    const c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
      reconnect: true,
    });
    const stub = await c.request<SessionSnapshot>("session.createStub", {
      prompt: "v",
      status: "running",
    });
    for (let i = 0; i < 5; i++) {
      await c.request("session.setStatus", { id: stub.id, status: i % 2 ? "idle" : "running" });
    }
    await delay(20);
    const before = c.getState();
    assert.equal(
      before.tag === "data" ? before.value.sessions.find((x) => x.id === stub.id)?.status.kind : "",
      "running",
    );

    // The restart resets the daemon's epoch and its seq counter. Nothing in the
    // snapshot is keyed on either, so the first one after reconnect is simply
    // the current truth — there is no version to regress (S6).
    const tags: string[] = [];
    c.subscribe((s) => tags.push(s.tag));
    await hh.restart();

    // Wait for the drop to be observed and a fresh snapshot to land, rather
    // than for the stale `data` we are still holding at this instant.
    for (let i = 0; i < 400; i++) {
      if (tags.includes("pending") && c.getState().tag === "data") break;
      await delay(10);
    }
    assert.ok(tags.includes("pending"), `expected a pending state; saw ${tags.join(",")}`);

    await c.request("session.setStatus", { id: stub.id, status: "idle" });
    for (let i = 0; i < 200; i++) {
      const s = c.getState();
      if (
        s.tag === "data" &&
        s.value.sessions.find((x) => x.id === stub.id)?.status.kind === "idle"
      )
        break;
      await delay(10);
    }
    const after = c.getState();
    assert.equal(after.tag, "data");
    assert.equal(
      after.tag === "data" ? after.value.sessions.find((x) => x.id === stub.id)?.status.kind : "",
      "idle",
      "post-restart changes reach the client",
    );
    await c.close();
  } finally {
    await hh.cleanup();
  }
});

test("daemon.status reflects live counts", async () => {
  const c = await client();
  const s = await c.request<{ sessions: number; clients: number; eventSeq: number }>(
    "daemon.status",
  );
  assert.ok(s.sessions >= 1);
  assert.ok(s.clients >= 1);
  assert.ok(s.eventSeq >= 1);
  await c.close();
});

test("daemon.doctor reports connectors, mcp mounts and daemon vitals", async () => {
  const c = await client();
  const rep = await c.request<DoctorReport>("daemon.doctor");

  assert.ok(rep.daemon.version.length > 0);
  assert.ok(rep.daemon.pid > 0);
  assert.ok(rep.daemon.uptimeMs >= 0);
  assert.ok(rep.daemon.clients >= 1);

  // Every configured connector package is listed; claude serves `claude`, the
  // mock connector serves `fake`. `loaded` flips only once a session uses it.
  const byPkg = new Map(rep.connectors.map((x) => [x.pkg, x]));
  assert.ok(byPkg.get("@loom/connector-claude")?.providerIds.includes("claude"));
  assert.ok(byPkg.get("@loom/connector-mock")?.providerIds.includes("fake"));
  assert.equal(byPkg.get("@loom/connector-gemini")?.loaded, false);

  // The default config mounts tilth + fff into every session.
  const mcpNames = rep.mcp.map((m) => m.name).sort();
  assert.deepEqual(mcpNames, ["fff", "tilth"]);
  for (const m of rep.mcp) {
    assert.ok(m.resolved.length > 0);
    assert.ok(["ok", "missing"].includes(m.status));
  }

  assert.deepEqual(rep.tools.loom, ["ask_user", "commit"]);
  assert.deepEqual(rep.tools.claudeDisabled, []);
  assert.equal(rep.webSearch.backend, "none");
  assert.equal(rep.webSearch.enabled, false);
  assert.ok(Array.isArray(rep.configWarnings));

  await c.close();
});

test("daemon.doctor marks a connector loaded once a session uses it", async () => {
  const c = await client();
  await c.request<SessionSnapshot>("session.create", { prompt: "doctor probe", provider: "fake" });
  const rep = await c.request<DoctorReport>("daemon.doctor");
  const mock = rep.connectors.find((x) => x.pkg === "@loom/connector-mock");
  assert.equal(mock?.loaded, true);
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
    const c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });
    const list = await c.request<
      Array<{
        id: string;
        models: string[];
        defaultModel: string;
        color: string;
        isDefault: boolean;
        modelsLoading?: boolean;
      }>
    >("providers.list");
    await c.close();

    const byId = new Map(list.map((p) => [p.id, p]));
    assert.ok(byId.has("claude"));
    assert.deepEqual(byId.get("openai")?.models, ["gpt-5", "gpt-5-mini"]);
    // no model has run yet → the config pin is the default
    assert.equal(byId.get("openai")?.defaultModel, "gpt-5");
    assert.equal(byId.get("claude")?.defaultModel, "claude-sonnet-5");
    // no fabrication: standalone/test daemons skip the CLI catalog probe, so
    // the list stays empty (the TUI shows its loading/empty state) — the
    // config `model` pin still seeds new sessions via defaultModel
    assert.deepEqual(byId.get("claude")?.models, []);
    assert.equal(byId.get("claude")?.modelsLoading, undefined); // probe skipped → not "loading"
    assert.equal(byId.get("openai")?.isDefault, true);
    assert.equal(byId.get("claude")?.isDefault, false);
    // first aisdk profile gets the first palette colour; explicit wins
    assert.equal(byId.get("openai")?.color, "cyan");
    assert.equal(byId.get("deepseek")?.color, "red");
  } finally {
    await hh.cleanup();
  }
});

test("providers.list expands [[claude_profiles]] into distinct ids, tags, colours and accounts", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "loom-claude-work-"));
  writeFileSync(
    join(workDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { subscriptionType: "enterprise" } }),
  );
  writeFileSync(
    join(workDir, ".claude.json"),
    JSON.stringify({ oauthAccount: { organizationName: "Globex" } }),
  );
  const hh = await makeHarness({
    config: `
[[claude_profiles]]
dir = "~/.claude"

[[claude_profiles]]
dir  = ${JSON.stringify(workDir)}
name = "Work"
`,
  });
  try {
    const c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });
    const list = await c.request<
      Array<{
        id: string;
        tag: string;
        color: string;
        account?: { loginMethod: string; org: string };
      }>
    >("providers.list");
    await c.close();

    const byId = new Map(list.map((p) => [p.id, p]));
    assert.ok(byId.has("claude"));
    assert.equal(byId.get("claude")?.color, ""); // base profile stays plain
    const work = byId.get("claude:work");
    assert.ok(work, "the named profile is its own provider");
    assert.equal(work?.tag, "Work");
    assert.notEqual(work?.color, ""); // auto-assigned from the palette
    assert.deepEqual(work?.account, { loginMethod: "Claude Enterprise account", org: "Globex" });
  } finally {
    await hh.cleanup();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("the last model a provider ran becomes its default for new sessions", async () => {
  const hh = await makeHarness({
    config: `
[providers.local]
adapter  = "aisdk"
base_url = "http://127.0.0.1:9/v1"
model    = "pin-a"
models   = ["pin-a", "pin-b"]
`,
  });
  try {
    const c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });

    // Nothing has run yet → providers.list falls back to the config pin.
    let list = await c.request<Array<{ id: string; defaultModel: string }>>("providers.list");
    assert.equal(list.find((p) => p.id === "local")?.defaultModel, "pin-a");

    // Switching a session's model on this provider records it as "last used".
    const s = await c.request<{ id: string }>("session.createStub", {
      prompt: "x",
      provider: "local",
      model: "pin-a",
    });
    await c.request("session.setModel", { id: s.id, model: "pin-b", by: "t" });

    list = await c.request<Array<{ id: string; defaultModel: string }>>("providers.list");
    assert.equal(list.find((p) => p.id === "local")?.defaultModel, "pin-b");

    await c.close();
  } finally {
    await hh.cleanup();
  }
});

test("session.setEffort records the row and becomes the default effort for the next new session", async () => {
  const hh = await makeHarness({
    config: `
[providers.local]
adapter  = "aisdk"
base_url = "http://127.0.0.1:9/v1"
model    = "pin-a"
models   = ["pin-a"]
`,
  });
  try {
    const c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });

    let list = await c.request<Array<{ id: string; defaultEffort: string }>>("providers.list");
    assert.equal(list.find((p) => p.id === "local")?.defaultEffort, "");

    const s = await c.request<{ id: string; effort: string | null }>("session.createStub", {
      prompt: "x",
      provider: "local",
    });
    assert.equal(s.effort, null);

    const updated = await c.request<{ effort: string | null }>("session.setEffort", {
      id: s.id,
      effort: "high",
      by: "t",
    });
    assert.equal(updated.effort, "high");

    list = await c.request<Array<{ id: string; defaultEffort: string }>>("providers.list");
    assert.equal(list.find((p) => p.id === "local")?.defaultEffort, "high");

    await c.close();
  } finally {
    await hh.cleanup();
  }
});

test("remembering defaults publishes a snapshot with the fresh provider list", async () => {
  const hh = await makeHarness({
    config: `
[providers.local]
adapter  = "aisdk"
base_url = "http://127.0.0.1:9/v1"
model    = "pin-a"
models   = ["pin-a", "pin-b"]
`,
  });
  try {
    const c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });
    const s = await c.request<{ id: string }>("session.createStub", {
      prompt: "x",
      provider: "local",
      model: "pin-a",
    });
    await c.request("session.setModel", { id: s.id, model: "pin-b", by: "t" });
    await c.request("session.setEffort", { id: s.id, effort: "high", by: "t" });

    await delay(20);
    // Providers ride the same snapshot as sessions, so a remembered default
    // reaches clients without its own push type.
    const state = c.getState();
    const local =
      state.tag === "data" ? state.value.providers.find((p) => p.id === "local") : undefined;
    assert.equal(local?.defaultModel, "pin-b");
    assert.equal(local?.defaultEffort, "high");

    await c.close();
  } finally {
    await hh.cleanup();
  }
});

test("the provider and mode a session was created with become the default for the next new session", async () => {
  const hh = await makeHarness({ config: `default_provider = "claude"\n` });
  try {
    const c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });

    // Nothing has run yet → the configured default provider, manual mode.
    let list =
      await c.request<Array<{ id: string; isDefault: boolean; defaultMode: string }>>(
        "providers.list",
      );
    assert.equal(list.find((p) => p.isDefault)?.id, "claude");
    assert.equal(list[0]?.defaultMode, "default");

    // Creating a session on another provider, in another mode, remembers both.
    await c.request<SessionSnapshot>("session.create", {
      prompt: "x",
      provider: "fake",
      mode: "acceptEdits",
    });

    list =
      await c.request<Array<{ id: string; isDefault: boolean; defaultMode: string }>>(
        "providers.list",
      );
    assert.equal(list[0]?.defaultMode, "acceptEdits");

    // A later session.create with nothing named picks up both remembered values.
    const s = await c.request<SessionSnapshot>("session.create", { prompt: "y" });
    assert.equal(s.provider, "fake");
    assert.equal(s.mode, "acceptEdits");

    // A deliberate session.setMode also updates the remembered default.
    await c.request("session.setMode", { id: s.id, mode: "plan", by: "t" });
    list =
      await c.request<Array<{ id: string; isDefault: boolean; defaultMode: string }>>(
        "providers.list",
      );
    assert.equal(list[0]?.defaultMode, "plan");

    await c.close();
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
    const c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });

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
    // an aisdk fork gets its provider_ref written so it survives a restart
    const ref = db.prepare("SELECT provider_ref FROM sessions WHERE id = ?").get(fork.id) as {
      provider_ref: string;
    };
    assert.equal(ref.provider_ref, fork.id);

    // forking a mid-turn parent is refused (dangling tool call)
    hh.daemon.registry.setStatus(parent.id, stateRunning, "test");
    await assert.rejects(c.request("session.fork", { id: parent.id }), /mid-turn/);
    // …and so is a rewind while it's not idle
    db.prepare("UPDATE usage SET turns = 3 WHERE session_id = ?").run(parent.id);
    await assert.rejects(
      c.request("session.rewind", { id: parent.id, toTurn: 1 }),
      /interrupt the session/,
    );
    hh.daemon.registry.setStatus(parent.id, stateIdle, "test");

    // fork a fake session → rejected for now
    const fk = await c.request<SessionSnapshot>("session.createStub", {
      prompt: "x",
      provider: "fake",
    });
    await assert.rejects(c.request("session.fork", { id: fk.id }), /aisdk-only/);

    await c.close();
  } finally {
    await hh.cleanup();
  }
});

test("session.rewind: toTurn 0 wipes the transcript; range guard covers the ends", async () => {
  const hh = await makeHarness({
    config: `
[providers.openai]
adapter  = "aisdk"
base_url = "http://127.0.0.1:9/v1"
model    = "gpt-5"
`,
  });
  try {
    const c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });
    const s = await c.request<SessionSnapshot>("session.createStub", {
      prompt: "first ask",
      status: "idle",
      provider: "openai",
    });
    const db = hh.daemon.db;
    const insMsg = db.prepare(
      "INSERT INTO provider_messages (session_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, 0)",
    );
    for (let i = 0; i < 4; i++) insMsg.run(s.id, i, i % 2 ? "assistant" : "user", `"m${i}"`);
    const insCp = db.prepare(
      "INSERT INTO checkpoints (session_id, turn, provider_ref, fork_point, user_text, created_at) VALUES (?, ?, '', ?, ?, 0)",
    );
    insCp.run(s.id, 1, "2", "first ask");
    insCp.run(s.id, 2, "4", "second ask");
    db.prepare("UPDATE usage SET turns = 2 WHERE session_id = ?").run(s.id);

    // out of range on both ends
    await assert.rejects(c.request("session.rewind", { id: s.id, toTurn: -1 }), /toTurn must be 0/);
    await assert.rejects(c.request("session.rewind", { id: s.id, toTurn: 2 }), /toTurn must be 0/);

    // toTurn 0 → whole transcript gone, turn counter reset, every checkpoint dropped
    const back = await c.request<SessionSnapshot>("session.rewind", { id: s.id, toTurn: 0 });
    assert.equal(back.turns, 0);
    assert.equal(back.status.kind, "idle");
    const left = db
      .prepare("SELECT COUNT(*) AS n FROM provider_messages WHERE session_id = ?")
      .get(s.id) as { n: number };
    assert.equal(left.n, 0);
    const cps = await c.request<Array<{ turn: number }>>("session.checkpoints", { id: s.id });
    assert.deepEqual(cps, []);

    await c.close();
  } finally {
    await hh.cleanup();
  }
});

test("session.rewind: a harness-driven (non-aisdk) provider can't wipe-to-zero or rewind cold", async () => {
  const hh = await makeHarness();
  try {
    const c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });
    // a `fake` session: capabilities.rewind is true, but it isn't aisdk, so it
    // takes the harness-restart path — which needs a loaded session and a
    // turn-1 fork point to keep.
    const s = await c.request<SessionSnapshot>("session.createStub", {
      prompt: "x",
      status: "idle",
      provider: "fake",
    });
    const db = hh.daemon.db;
    db.prepare(
      "INSERT INTO checkpoints (session_id, turn, provider_ref, fork_point, user_text, created_at) VALUES (?, 1, '', 'fake-turn-1', 'x', 0)",
    ).run(s.id);
    db.prepare("UPDATE usage SET turns = 2 WHERE session_id = ?").run(s.id);

    // cold (never `create`d live) → refused with a "load it first" message
    await assert.rejects(c.request("session.rewind", { id: s.id, toTurn: 1 }), /isn't loaded/);

    // toTurn 0 (undo the very first turn) is refused for this provider class
    await assert.rejects(
      c.request("session.rewind", { id: s.id, toTurn: 0 }),
      /can't undo the first turn/,
    );

    await c.close();
  } finally {
    await hh.cleanup();
  }
});

test("aisdk model auto-detection fills the picker list at start-up; config.check reports warnings", async () => {
  const srv = await modelsStub([
    "z-model",
    "a-model",
    "m-model",
    // sference-style row: display name, context window, advertised pricing
    {
      id: "zai-org/GLM-5.3-Flash",
      display_name: "GLM 5.3 Flash",
      context_tokens: 1_048_576,
      pricing: {
        input_per_million_usd: 0.2,
        output_per_million_usd: 0.5,
        cached_input_per_million_usd: 0.07,
      },
    },
    // codex-style row: advertised reasoning-effort levels + default
    {
      id: "oaic/gpt-5",
      supported_reasoning_efforts: ["minimal", "low", "medium", "high"],
      default_reasoning_effort: "medium",
    },
  ]);
  const hh = await makeHarness({
    config: `
[providers.oai]
adapter  = "aisdk"
base_url = "${srv.base}"
# a user pin for a model the endpoint says nothing about
model_context = { "m-model" = 12345 }

[providers.needkey]
adapter     = "aisdk"
base_url    = "http://127.0.0.1:9/v1"
model       = "x"
api_key_env = "LOOM_TEST_UNSET_KEY_VAR"
`,
  });
  try {
    const c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });

    // probed at start-up, sorted, and the first becomes the default model
    const provs = await c.request<
      Array<{
        id: string;
        models: string[];
        modelChoices?: Array<{
          id: string;
          label: string;
          context?: number;
          supportsEffort?: boolean;
          effortLevels?: string[];
          defaultEffort?: string;
        }>;
      }>
    >("providers.list");
    const oai = provs.find((p) => p.id === "oai");
    assert.deepEqual(oai?.models, [
      "a-model",
      "m-model",
      "oaic/gpt-5",
      "z-model",
      "zai-org/GLM-5.3-Flash",
    ]);

    // picker rows carry the context window where it's known: endpoint-reported…
    const choices = new Map((oai?.modelChoices ?? []).map((ch) => [ch.id, ch]));
    assert.equal(choices.get("zai-org/GLM-5.3-Flash")?.context, 1_048_576);
    // …with the endpoint's display name as the label…
    assert.equal(choices.get("zai-org/GLM-5.3-Flash")?.label, "GLM 5.3 Flash");
    // …user-pinned via model_context…
    assert.equal(choices.get("m-model")?.context, 12345);
    // …and unhinted (no table guess echoed) when nothing is known
    assert.equal(choices.get("a-model")?.context, undefined);
    // reasoning-effort metadata rides to the picker rows…
    assert.equal(choices.get("oaic/gpt-5")?.supportsEffort, true);
    assert.deepEqual(choices.get("oaic/gpt-5")?.effortLevels, ["minimal", "low", "medium", "high"]);
    assert.equal(choices.get("oaic/gpt-5")?.defaultEffort, "medium");
    // …models the endpoint says nothing about get no effort offer
    assert.equal(choices.get("a-model")?.supportsEffort, undefined);
    // an effort outside Loom's fixed union, but advertised for this model, is
    // accepted rather than rejected as a bad_request
    const oaiSession = await c.request<SessionSnapshot>("session.createStub", {
      prompt: "test",
      status: "idle",
      provider: "oai",
      model: "oaic/gpt-5",
    });
    const switched = await c.request<SessionSnapshot>("session.setProvider", {
      id: oaiSession.id,
      provider: "oai",
      model: "oaic/gpt-5",
      effort: "minimal",
    });
    assert.equal(switched.effort, "minimal");
    // a provider with no context knowledge emits no modelChoices at all
    const needkey = provs.find((p) => p.id === "needkey");
    assert.equal(needkey?.modelChoices, undefined);

    // advertised pricing feeds the cost table for models models.toml
    // doesn't price — visible through pricing.reload's key list
    const priced = await c.request<{ models: string[] }>("pricing.reload");
    assert.ok(priced.models.includes("zai-org/GLM-5.3-Flash"));

    // lint surfaces the unset key var; the auto profile resolved, so no note for it
    const { warnings } = await c.request<{ warnings: string[] }>("config.check");
    assert.ok(warnings.some((w) => /\$LOOM_TEST_UNSET_KEY_VAR is not set/.test(w)));
    assert.ok(!warnings.some((w) => /"oai"/.test(w)));

    await c.close();
  } finally {
    srv.close();
    await hh.cleanup();
  }
});

test("in-place sessions: no worktree, repo-root git facts, hard fork refused", async () => {
  const hh = await makeHarness({
    config: `
[worktree]
enabled = false

[providers.openai]
adapter  = "aisdk"
base_url = "http://127.0.0.1:9/v1"
model    = "gpt-5"
`,
  });
  try {
    const c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });

    const getFake = async (id: string): Promise<void> => {
      ((await hh.daemon.providers.get("fake")) as FakeProvider).session(id)?.finishTurn();
    };

    const s = await c.request<SessionSnapshot>("session.create", {
      prompt: "work in the repo",
      provider: "fake",
    });
    await getFake(s.id); // settle so shutdown is clean
    assert.equal(s.inPlace, true);
    assert.equal(s.worktree, null);
    assert.equal(s.branch, null);
    assert.equal(s.baseBranch, "main");

    // session.get enriches: an in-place session shows the repo root's git state
    const got = await c.request<SessionSnapshot>("session.get", { id: s.id });
    assert.equal(got.git?.branch, "main");

    // the per-session override beats the config default
    const iso = await c.request<SessionSnapshot>("session.create", {
      prompt: "isolate me",
      provider: "fake",
      worktree: true,
    });
    await getFake(iso.id);
    assert.equal(iso.inPlace, false);
    assert.ok(iso.worktree, "explicit worktree:true still gets a tree");

    // a hard fork needs an isolated branch — refused for an in-place aisdk parent
    const ip = await c.request<SessionSnapshot>("session.createStub", {
      prompt: "in-place aisdk",
      status: "idle",
      provider: "openai",
    });
    hh.daemon.db
      .prepare("UPDATE sessions SET in_place = 1, worktree = NULL WHERE id = ?")
      .run(ip.id);
    await assert.rejects(c.request("session.fork", { id: ip.id }), /in-place|worktree/);

    await c.close();
  } finally {
    await hh.cleanup();
  }
});

test("session.send always broadcasts a user_message; injected reflects whether a turn was live", async () => {
  const hh = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const frames: PushFrame[] = [];
    c.onPush((f) => frames.push(f));
    const umEvents = (): Array<{ text: string; injected: boolean }> =>
      frames
        .filter((f) => f.type === "event" && (f.event as { type?: string }).type === "user_message")
        .map((f) => {
          const e = (f as { event: { text: string; injected: boolean } }).event;
          return { text: e.text, injected: e.injected };
        });

    const snap = await c.request<SessionSnapshot>("session.create", {
      prompt: "busy",
      provider: "fake",
    });
    const fs = ((await hh.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
    fs?.emit({ type: "assistant_text", text: "working…" }); // → running
    await delay(80);

    const r1 = await c.request<{ injected?: boolean }>("session.send", {
      id: snap.id,
      text: "also handle Y",
    });
    await delay(60);
    assert.equal(r1.injected, true);
    assert.deepEqual(umEvents().at(-1), { text: "also handle Y", injected: true });

    fs?.finishTurn(); // → idle
    await delay(60);
    frames.length = 0;
    const r2 = await c.request<{ injected?: boolean }>("session.send", {
      id: snap.id,
      text: "next turn please",
    });
    await delay(60);
    assert.equal(r2.injected, false);
    assert.deepEqual(umEvents().at(-1), { text: "next turn please", injected: false });
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("a send that revives a cold session (daemon restart) starts a fresh turn, not a mid-turn injection", async () => {
  const hh = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const frames: PushFrame[] = [];
    c.onPush((f) => frames.push(f));
    const umEvents = (): Array<{ text: string; injected: boolean }> =>
      frames
        .filter((f) => f.type === "event" && (f.event as { type?: string }).type === "user_message")
        .map((f) => {
          const e = (f as { event: { text: string; injected: boolean } }).event;
          return { text: e.text, injected: e.injected };
        });

    const snap = await c.request<SessionSnapshot>("session.create", {
      prompt: "first",
      provider: "fake",
    });
    const p = (await hh.daemon.providers.get("fake")) as FakeProvider;
    p.session(snap.id)?.finishTurn(); // → idle, like a turn that completed
    await waitFor(
      async () =>
        (await c.request<SessionSnapshot>("session.get", { id: snap.id })).status.kind === "idle",
    );

    // Drop the live adapter the way a daemon restart does — the next send must
    // transparently revive (session-manager re-attach) and start a fresh turn.
    await hh.daemon.sessions.close(snap.id);

    frames.length = 0;
    const r = await c.request<{ injected?: boolean }>("session.send", {
      id: snap.id,
      text: "follow-up after restart",
    });
    await delay(60);
    assert.equal(r.injected, false);
    assert.deepEqual(umEvents().at(-1), { text: "follow-up after restart", injected: false });
    assert.equal(
      (await c.request<SessionSnapshot>("session.get", { id: snap.id })).status.kind,
      "running",
    );
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("[auto_resume]: a restart re-drives sessions the old daemon left mid-run", async () => {
  const hh = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const running = await c.request<SessionSnapshot>("session.create", {
      prompt: "long task",
      provider: "fake",
    });
    const blocked = await c.request<SessionSnapshot>("session.create", {
      prompt: "needs approval",
      provider: "fake",
    });
    const p1 = (await hh.daemon.providers.get("fake")) as FakeProvider;
    p1.session(running.id)?.emit({ type: "assistant_text", text: "working…" }); // → running
    p1.session(blocked.id)?.emit({
      type: "permission_request",
      id: "perm-1",
      tool: "Bash",
      input: { command: "rm -rf /" },
    }); // → awaiting_input
    await waitFor(async () => {
      const [a, b] = await Promise.all([
        c.request<SessionSnapshot>("session.get", { id: running.id }),
        c.request<SessionSnapshot>("session.get", { id: blocked.id }),
      ]);
      return a.status.kind === "running" && b.status.kind === "awaiting_input";
    });

    await hh.restart();

    // The actively-working session is revived from its persisted transcript
    // and sent a `[loom]` continue message; the blocked one stays parked —
    // a permission prompt must never be answered automatically.
    const c2 = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });
    await waitFor(async () => {
      const s = await c2.request<SessionSnapshot>("session.get", { id: running.id });
      return s.status.kind === "running";
    }, 2000);
    const p2 = (await hh.daemon.providers.get("fake")) as FakeProvider;
    const resumed = p2.session(running.id);
    assert.ok(resumed, "the session should have a fresh (resumed) adapter");
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.sends.length, 1);
    assert.match(resumed.sends[0] ?? "", /^\[loom\]/);

    const blockedAfter = await c2.request<SessionSnapshot>("session.get", { id: blocked.id });
    assert.equal(blockedAfter.status.kind, "interrupted");
    assert.equal(p2.session(blocked.id), undefined, "the blocked session must not be revived");
    await c2.close();
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("[auto_resume] off: a restart leaves mid-run sessions interrupted", async () => {
  const hh = await makeHarness({ config: "[auto_resume]\nenabled = false\n" });
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const snap = await c.request<SessionSnapshot>("session.create", {
      prompt: "long task",
      provider: "fake",
    });
    ((await hh.daemon.providers.get("fake")) as FakeProvider)
      .session(snap.id)
      ?.emit({ type: "assistant_text", text: "working…" }); // → running
    await waitFor(async () => {
      const s = await c.request<SessionSnapshot>("session.get", { id: snap.id });
      return s.status.kind === "running";
    });

    await hh.restart();

    const c2 = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });
    const after = await c2.request<SessionSnapshot>("session.get", { id: snap.id });
    assert.equal(after.status.kind, "interrupted");
    const p2 = (await hh.daemon.providers.get("fake")) as FakeProvider;
    assert.equal(p2.session(snap.id), undefined, "no adapter should be mounted");
    await c2.close();
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("[auto_resume]: a session interrupted before the restart is left alone", async () => {
  const hh = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const snap = await c.request<SessionSnapshot>("session.create", {
      prompt: "long task",
      provider: "fake",
    });
    const p1 = (await hh.daemon.providers.get("fake")) as FakeProvider;
    p1.session(snap.id)?.emit({ type: "assistant_text", text: "working…" }); // → running
    await waitFor(async () => {
      const s = await c.request<SessionSnapshot>("session.get", { id: snap.id });
      return s.status.kind === "running";
    });

    // The user stops the turn long before any daemon restart — the row is
    // already `interrupted`, so the next boot must not re-drive it. Only the
    // sessions this boot's hygiene flips (was running) are auto-resumed.
    await c.request("session.interrupt", { id: snap.id });
    await waitFor(async () => {
      const s = await c.request<SessionSnapshot>("session.get", { id: snap.id });
      return s.status.kind === "interrupted";
    });

    await hh.restart();

    const c2 = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });
    const after = await c2.request<SessionSnapshot>("session.get", { id: snap.id });
    assert.equal(after.status.kind, "interrupted");
    const p2 = (await hh.daemon.providers.get("fake")) as FakeProvider;
    assert.equal(
      p2.session(snap.id),
      undefined,
      "a pre-existing interrupted session must not be revived",
    );
    await c2.close();
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("[auto_rebase]: a clean idle replays the branch onto an advanced base, silently", async () => {
  const hh = await makeHarness({ config: `[auto_rebase]\nenabled = true\n` });
  const git = (...a: string[]) => execFileSync("git", ["-C", hh.repoRoot, ...a], { stdio: "pipe" });
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const notices: string[] = [];
    const userMsgs: string[] = [];
    c.onPush((f) => {
      if (f.type === "notice") notices.push(f.text);
      if (f.type === "event" && (f.event as { type?: string }).type === "user_message") {
        userMsgs.push((f.event as { text: string }).text);
      }
    });

    const snap = await c.request<SessionSnapshot>("session.create", {
      prompt: "keep me current",
      provider: "fake",
    });
    assert.ok(snap.worktree);

    // base branch moves on a file the branch never touched → a clean replay
    writeFileSync(join(hh.repoRoot, "upstream.txt"), "from main");
    git("add", "-A");
    git("commit", "-q", "-m", "main: upstream.txt");

    const fs = ((await hh.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
    fs?.emit({ type: "assistant_text", text: "…" }); // → running
    await delay(40);
    notices.length = 0;
    userMsgs.length = 0; // drop the opening-prompt echo
    fs?.finishTurn(); // → idle → auto-rebase
    await delay(120);

    assert.ok(
      existsSync(join(snap.worktree as string, "upstream.txt")),
      "branch picked up the base commit",
    );
    assert.ok(
      notices.some((t) => /rebased onto main/.test(t)),
      `expected a rebase notice, got ${JSON.stringify(notices)}`,
    );
    assert.deepEqual(userMsgs, [], "a clean replay must not message the agent");
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("[auto_rebase]: a conflict leaves the tree alone and asks the agent to integrate", async () => {
  const hh = await makeHarness({ config: `[auto_rebase]\nenabled = true\n` });
  const git = (...a: string[]) => execFileSync("git", ["-C", hh.repoRoot, ...a], { stdio: "pipe" });
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const userMsgs: string[] = [];
    c.onPush((f) => {
      if (f.type === "event" && (f.event as { type?: string }).type === "user_message") {
        userMsgs.push((f.event as { text: string }).text);
      }
    });

    const snap = await c.request<SessionSnapshot>("session.create", {
      prompt: "conflict me",
      provider: "fake",
    });
    const wt = snap.worktree as string;
    const wtGit = (...a: string[]) => execFileSync("git", ["-C", wt, ...a], { stdio: "pipe" });

    // both sides commit `clash.txt` with different content
    writeFileSync(join(wt, "clash.txt"), "branch side");
    wtGit("add", "-A");
    wtGit("commit", "-q", "-m", "branch: clash.txt");
    const branchHead = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" });

    writeFileSync(join(hh.repoRoot, "clash.txt"), "main side");
    git("add", "-A");
    git("commit", "-q", "-m", "main: clash.txt");

    const fs = ((await hh.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
    fs?.emit({ type: "assistant_text", text: "…" });
    await delay(40);
    userMsgs.length = 0; // drop the opening-prompt echo
    fs?.finishTurn();
    await delay(120);

    // branch HEAD is untouched, no rebase left in progress
    assert.equal(
      execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }),
      branchHead,
    );
    assert.ok(!existsSync(join(wt, ".git", "rebase-merge")));
    // the agent got exactly one nudge, and the session is running it
    assert.equal(userMsgs.length, 1);
    assert.match(userMsgs[0] ?? "", /\[loom\].*\bmain\b.*rebase/s);
    assert.equal(hh.daemon.registry.get(snap.id)?.status.kind, "running");

    // G9: the "already nudged for this base head" record is persisted on the
    // row, not a daemon-instance Map — so a restart won't re-inject the nudge.
    const row = hh.daemon.db
      .prepare("SELECT auto_rebase_nudged_sha FROM sessions WHERE id = ?")
      .get(snap.id) as { auto_rebase_nudged_sha: string };
    const baseShort = execFileSync("git", ["-C", wt, "rev-parse", "--short", "main"], {
      encoding: "utf8",
    }).trim();
    assert.equal(row.auto_rebase_nudged_sha, baseShort);

    // a second idle transition against the same base head does not nudge again
    userMsgs.length = 0;
    fs?.finishTurn();
    await delay(120);
    assert.equal(userMsgs.length, 0, "no repeat nudge for the same base commit");
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("[commit_reminder]: an uncommitted worktree nudges the agent once per commit boundary", async () => {
  const hh = await makeHarness(); // on by default

  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const userMsgs: string[] = [];
    c.onPush((f) => {
      if (f.type === "event" && (f.event as { type?: string }).type === "user_message") {
        userMsgs.push((f.event as { text: string }).text);
      }
    });

    const snap = await c.request<SessionSnapshot>("session.create", {
      prompt: "leave a mess",
      provider: "fake",
    });
    const wt = snap.worktree as string;
    const wtGit = (...a: string[]) => execFileSync("git", ["-C", wt, ...a], { stdio: "pipe" });
    const fs = ((await hh.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
    const head = () =>
      execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const nudgedSha = () =>
      (
        hh.daemon.db
          .prepare("SELECT commit_nudged_sha FROM sessions WHERE id = ?")
          .get(snap.id) as { commit_nudged_sha: string }
      ).commit_nudged_sha;

    // turn 1 ends with a clean worktree → no reminder
    fs?.emit({ type: "assistant_text", text: "…" });
    await delay(40);
    userMsgs.length = 0; // drop the opening-prompt echo
    fs?.finishTurn();
    await delay(120);
    assert.deepEqual(userMsgs, [], "a clean worktree is not nudged");

    // turn 2 ends with an untracked file present → exactly one reminder
    writeFileSync(join(wt, "scratch.txt"), "wip\n");
    fs?.emit({ type: "assistant_text", text: "…" });
    await delay(20);
    fs?.finishTurn();
    await delay(120);
    assert.equal(userMsgs.length, 1);
    assert.match(userMsgs[0] ?? "", /\[loom\].*uncommitted changes/s);
    assert.equal(hh.daemon.registry.get(snap.id)?.status.kind, "running");
    // the "already nudged" mark is persisted on the row, keyed to HEAD
    assert.equal(nudgedSha(), head());

    // turn 3: still dirty, HEAD unchanged → no repeat reminder
    userMsgs.length = 0;
    fs?.emit({ type: "assistant_text", text: "…" });
    await delay(20);
    fs?.finishTurn();
    await delay(120);
    assert.deepEqual(userMsgs, [], "no repeat reminder while HEAD is unchanged");

    // turn 4: the agent commits, then leaves a fresh change → one new reminder
    wtGit("add", "-A");
    wtGit("commit", "-q", "-m", "wip");
    writeFileSync(join(wt, "scratch2.txt"), "more\n");
    userMsgs.length = 0;
    fs?.emit({ type: "assistant_text", text: "…" });
    await delay(20);
    fs?.finishTurn();
    await delay(120);
    assert.equal(userMsgs.length, 1, "a new dirty batch after a commit nudges again");
    assert.equal(nudgedSha(), head());

    // turn 5: the agent commits everything → the record clears, no reminder
    wtGit("add", "-A");
    wtGit("commit", "-q", "-m", "rest");
    userMsgs.length = 0;
    fs?.emit({ type: "assistant_text", text: "…" });
    await delay(20);
    fs?.finishTurn();
    await delay(120);
    assert.deepEqual(userMsgs, [], "a clean worktree is not nudged");
    assert.equal(nudgedSha(), "", "the record clears once the tree is clean");
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("session.rebase: replays a behind branch on demand with [auto_rebase] off", async () => {
  const hh = await makeHarness(); // no [auto_rebase] → the auto path is disabled
  const git = (...a: string[]) => execFileSync("git", ["-C", hh.repoRoot, ...a], { stdio: "pipe" });
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const notices: string[] = [];
    const userMsgs: string[] = [];
    c.onPush((f) => {
      if (f.type === "notice") notices.push(f.text);
      if (f.type === "event" && (f.event as { type?: string }).type === "user_message") {
        userMsgs.push((f.event as { text: string }).text);
      }
    });

    const snap = await c.request<SessionSnapshot>("session.create", {
      prompt: "rebase me by hand",
      provider: "fake",
    });
    const wt = snap.worktree as string;
    assert.ok(wt);

    // base moves on a file the branch never touched → a clean replay
    writeFileSync(join(hh.repoRoot, "upstream.txt"), "from main");
    git("add", "-A");
    git("commit", "-q", "-m", "main: upstream.txt");
    userMsgs.length = 0; // drop the opening-prompt echo

    const r1 = await c.request<{ outcome: string; base: string; behind: number }>(
      "session.rebase",
      {
        id: snap.id,
      },
    );
    assert.equal(r1.outcome, "updated");
    assert.equal(r1.behind, 1);
    assert.ok(existsSync(join(wt, "upstream.txt")), "branch picked up the base commit");
    assert.ok(
      notices.some((t) => /rebased onto main/.test(t)),
      `expected a rebase notice, got ${JSON.stringify(notices)}`,
    );
    assert.deepEqual(userMsgs, [], "a manual rebase never messages the agent");

    // nothing left to do → current
    const r2 = await c.request<{ outcome: string }>("session.rebase", { id: snap.id });
    assert.equal(r2.outcome, "current");
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("session.rebase: a conflict leaves the branch untouched and does not nudge", async () => {
  const hh = await makeHarness();
  const git = (...a: string[]) => execFileSync("git", ["-C", hh.repoRoot, ...a], { stdio: "pipe" });
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const userMsgs: string[] = [];
    c.onPush((f) => {
      if (f.type === "event" && (f.event as { type?: string }).type === "user_message") {
        userMsgs.push((f.event as { text: string }).text);
      }
    });

    const snap = await c.request<SessionSnapshot>("session.create", {
      prompt: "conflict me by hand",
      provider: "fake",
    });
    const wt = snap.worktree as string;
    const wtGit = (...a: string[]) => execFileSync("git", ["-C", wt, ...a], { stdio: "pipe" });

    writeFileSync(join(wt, "clash.txt"), "branch side");
    wtGit("add", "-A");
    wtGit("commit", "-q", "-m", "branch: clash.txt");
    const branchHead = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" });

    writeFileSync(join(hh.repoRoot, "clash.txt"), "main side");
    git("add", "-A");
    git("commit", "-q", "-m", "main: clash.txt");
    userMsgs.length = 0;

    const r = await c.request<{ outcome: string }>("session.rebase", { id: snap.id });
    assert.equal(r.outcome, "conflict");
    assert.equal(
      execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }),
      branchHead,
    );
    assert.ok(!existsSync(join(wt, ".git", "rebase-merge")));
    await delay(60);
    assert.deepEqual(userMsgs, [], "manual rebase reports the conflict, it doesn't nudge");
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("editing config.toml hot-applies [worktree] enabled and pushes a notice", async () => {
  const hh = await makeHarness({ config: `[worktree]\nenabled = true\n` });
  const cfgPath = join(hh.repoRoot, ".loom", "config.toml");
  try {
    const c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });
    const notices: string[] = [];
    c.onPush((f) => {
      if (f.type === "notice") notices.push(f.text);
    });

    // a session before the edit gets a worktree
    const a = await c.request<SessionSnapshot>("session.create", {
      prompt: "before edit",
      provider: "fake",
    });
    assert.ok(a.worktree && !a.inPlace);

    writeFileSync(cfgPath, `[worktree]\nenabled = false\n`);
    await delay(500); // debounce (250ms) + reload

    assert.ok(
      notices.some((t) => /config reloaded/.test(t)),
      `got notices: ${JSON.stringify(notices)}`,
    );

    // a session after the edit runs in-place — the reload took effect with no restart
    const b = await c.request<SessionSnapshot>("session.create", {
      prompt: "after edit",
      provider: "fake",
    });
    assert.equal(b.inPlace, true);
    assert.equal(b.worktree, null);

    await c.close();
  } finally {
    await hh.cleanup();
  }
});

test("a provider-set change on disk asks for a restart rather than applying live", async () => {
  const hh = await makeHarness({ config: `base_branch = "main"\n` });
  const cfgPath = join(hh.repoRoot, ".loom", "config.toml");
  try {
    const c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });
    const notices: string[] = [];
    c.onPush((f) => {
      if (f.type === "notice") notices.push(f.text);
    });

    writeFileSync(
      cfgPath,
      `base_branch = "main"\n\n[custom-provider.local]\nbase_url = "http://localhost:1234/v1"\nmodel = "m"\n`,
    );
    await delay(500);

    assert.ok(
      notices.some((t) => /restart the daemon/.test(t)),
      `got notices: ${JSON.stringify(notices)}`,
    );
    // the running provider list is unchanged until a restart
    const list = await c.request<Array<{ id: string }>>("providers.list");
    assert.ok(!list.some((p) => p.id === "local"));
    await c.close();
  } finally {
    await hh.cleanup();
  }
});

test("model probes resolving at bring-up publish a snapshot with the detected list", async () => {
  const srv = await modelsStub([
    // one metadata-carrying row so the push's modelChoices is exercised too
    { id: "det-b", display_name: "Det B", context_tokens: 32_768 },
    "det-a",
  ]);
  const hh = await makeHarness({
    config: `
[providers.local]
adapter  = "aisdk"
base_url = "${srv.base}"
`,
  });
  try {
    // Bring-up listens before the probes run, so a client that connects
    // immediately (the TUI spawning the daemon) fetches providers.list with
    // the empty pin fallback and no modelChoices. The daemon must not leave
    // it there: the resolved list is pushed the moment the probes land.
    const c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });
    // Whether the probe settled before or after this client attached, the
    // resolved catalog reaches it — either in the opening snapshot or in the
    // one the settle publishes. An open picker's loader resolves either way.
    let local: { models?: string[]; modelChoices?: unknown } | undefined;
    for (let i = 0; i < 200; i++) {
      const st = c.getState();
      local = st.tag === "data" ? st.value.providers.find((p) => p.id === "local") : undefined;
      if (local?.models?.length) break;
      await delay(10);
    }
    assert.deepEqual(local?.models, ["det-a", "det-b"]);
    assert.ok(local?.modelChoices, "the snapshot carries the picker metadata too");
    await c.close();
  } finally {
    srv.close();
    await hh.cleanup();
  }
});

test("no extra snapshot at bring-up when the provider list is fully pinned", async () => {
  const hh = await makeHarness({
    config: `
[providers.local]
adapter  = "aisdk"
base_url = "http://127.0.0.1:9/v1"
model    = "pin-a"
models   = ["pin-a"]
`,
  });
  try {
    const c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });
    const st = c.getState();
    const local = st.tag === "data" ? st.value.providers.find((p) => p.id === "local") : undefined;
    // Nothing to resolve — the pinned list is what the opening snapshot says.
    assert.deepEqual(local?.models, ["pin-a"]);
    assert.equal(local?.modelsLoading, undefined);
    await c.close();
  } finally {
    await hh.cleanup();
  }
});

test("a live daemon reports claude's catalog as loading until the probe settles — no pin fallback", async () => {
  // Non-standalone daemon (standalone skips the probe) with a cli_path that
  // can't resolve: the probe fails fast, but the settle must still flip
  // `modelsLoading` off and push — an open picker's loader has to resolve
  // even when the catalog never arrives.
  const xdg = mkdtempSync(join(tmpdir(), "loom-probe-xdg-"));
  const realXdg = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = xdg; // keep the scaffolded starter out of the shared harness XDG
  const repoRoot = mkdtempSync(join(tmpdir(), "loom-probe-"));
  execFileSync("git", ["init", "-q", "-b", "main", repoRoot]);
  execFileSync("git", ["-C", repoRoot, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", repoRoot, "config", "user.name", "t"]);
  // Don't inherit a machine-wide commit.gpgsign — gpg has no TTY here.
  execFileSync("git", ["-C", repoRoot, "config", "commit.gpgsign", "false"]);
  execFileSync("git", ["-C", repoRoot, "config", "tag.gpgsign", "false"]);
  execFileSync("git", ["-C", repoRoot, "commit", "-q", "--allow-empty", "-m", "base"]);
  mkdirSync(join(repoRoot, ".loom"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".loom", "config.toml"),
    `[providers.claude]\ncli_path = "/nonexistent/loom-test-claude"\n`,
  );
  let daemon: Daemon | null = null;
  try {
    daemon = await Daemon.start({
      repoRoot,
      connectors: { "@loom/connector-claude": () => import("@loom/connector-claude") },
    });
    const c = await LoomClient.connect({
      repoRoot,
      sockPath: loomPaths(repoRoot).sock,
      autospawn: false,
    });
    const list =
      await c.request<Array<{ id: string; models: string[]; modelsLoading?: boolean }>>(
        "providers.list",
      );
    const claude = list.find((p) => p.id === "claude");
    assert.deepEqual(claude?.models, []); // no fabricated single-pin list
    assert.equal(claude?.modelsLoading, undefined); // the probe settled (failed fast here)

    // The settle flip reaches clients even though the list stayed empty — a
    // picker opened mid-probe has to stop showing its loader.
    const st = c.getState();
    const pushed =
      st.tag === "data" ? st.value.providers.find((p) => p.id === "claude") : undefined;
    assert.deepEqual(pushed?.models, []);
    assert.equal(pushed?.modelsLoading, undefined);
    await c.close();
  } finally {
    await daemon?.stop("test").catch(() => {});
    process.env["XDG_CONFIG_HOME"] = realXdg;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  }
});

test("a mode clicked while the adapter is still mounting reaches the session", async () => {
  const hh = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const provider = (await hh.daemon.providers.get("fake")) as FakeProvider;
    const release = provider.blockCreate();
    const creating = c.request<SessionSnapshot>("session.create", {
      prompt: "race-the-attach",
      provider: "fake",
      mode: "plan",
    });
    // The registry row exists (status `starting`) from the moment the daemon
    // begins the create — before the adapter attaches — so the row id is
    // discoverable and a `session.setMode` can land in the mount window.
    let id = "";
    await waitFor(async () => {
      const rows = await c.request<Array<SessionSnapshot>>("session.list", {});
      id = rows.find((r) => r.title === "race-the-attach")?.id ?? "";
      return id !== "";
    }, 5000);
    // Not awaited before the release: the click queues behind the create on the
    // session queue, so awaiting it here would wait on a create this test has
    // deliberately parked.
    const clicked = c.request<SessionSnapshot>("session.setMode", { id, mode: "auto", by: "t" });
    // Past the daemon's dispatch point before the mount is released, so the
    // click really does have to survive the window rather than arrive after it.
    await barrier(c);
    release();
    const s = await creating;
    // The create returns the row as it stood when the adapter attached — the
    // click is ordered after it, not merged into it.
    assert.equal(s.mode, "plan");
    assert.equal((await clicked).mode, "auto");
    // The click must reach the adapter, not just the row — while the run was
    // un-attached the RPC would otherwise have skipped it silently and the
    // session would have run on in its create-time mode.
    const fake = provider.session(s.id);
    assert.ok(fake, "the fake session should be attached once create resolves");
    assert.deepEqual(fake.modeChanges, ["auto"]);
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

// --- §3: serialized configuration commands ---------------------------------

/**
 * Wait until every request already issued on `c` has been dispatched by the
 * daemon. Frames are read and dispatched in arrival order, and a handler runs
 * synchronously up to its first `await`, so a round-tripped `ping` behind an
 * earlier request proves that request got at least as far as its first suspend
 * — a barrier for ordering races that a sleep could only approximate.
 */
const barrier = async (c: LoomClient): Promise<void> => {
  await c.request("ping", {});
};

/** A session snapshot as the push stream currently reports it — what every
 *  attached client is actually showing, as opposed to an RPC return value. */
const pushed = (c: LoomClient, id: string): SessionSnapshot | undefined => {
  const st = c.getState();
  return st.tag === "data" ? st.value.sessions.find((s) => s.id === id) : undefined;
};

test("overlapping mode changes apply in issue order and leave the adapter and the registry agreeing", async () => {
  const hh = await makeHarness();
  const a = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  const b = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    // given — a live session whose adapter `setMode` can be parked
    const provider = (await hh.daemon.providers.get("fake")) as FakeProvider;
    const s = await a.request<SessionSnapshot>("session.create", {
      prompt: "overlap",
      provider: "fake",
      mode: "default",
    });
    const fake = provider.session(s.id);
    assert.ok(fake);
    const release = fake.blockMode();

    // when — two clients change the same session's mode, the first one parked
    // inside the adapter while the second is issued
    const first = a.request<SessionSnapshot>("session.setMode", {
      id: s.id,
      mode: "plan",
      by: "a",
    });
    const second = b.request<SessionSnapshot>("session.setMode", {
      id: s.id,
      mode: "acceptEdits",
      by: "b",
    });
    // The second command must not have reached the adapter — it is queued
    // behind the first, not racing it. (Unserialized, it sails past the parked
    // call and the adapter records `acceptEdits` first.)
    await barrier(b);
    assert.deepEqual(fake.modeChanges, []);
    release();
    await Promise.all([first, second]);

    // then — one order, and the adapter and the registry are on the same value
    assert.deepEqual(fake.modeChanges, ["plan", "acceptEdits"]);
    assert.equal(fake.snapshot().mode, "acceptEdits");
    const rows = await a.request<SessionSnapshot[]>("session.list", {});
    assert.equal(rows.find((r) => r.id === s.id)?.mode, "acceptEdits");
    // ...and both clients settle showing that same final value.
    await waitFor(() => pushed(a, s.id)?.mode === "acceptEdits");
    await waitFor(() => pushed(b, s.id)?.mode === "acceptEdits");
  } finally {
    await a.close();
    await b.close();
    await hh.cleanup();
  }
});

test("a mode change racing a revive reaches the rebuilt adapter", async () => {
  const hh = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    // given — a session that has been closed, so the next send revives it
    const provider = (await hh.daemon.providers.get("fake")) as FakeProvider;
    const s = await c.request<SessionSnapshot>("session.create", {
      prompt: "revive-race",
      provider: "fake",
      mode: "default",
    });
    // A revive resumes from the persisted provider ref, which the manager only
    // learns from the adapter's event stream — let one turn land first.
    const live = provider.session(s.id);
    assert.ok(live);
    live.emit({ type: "result", kind: "ok", summary: "done" });
    await waitFor(() => pushed(c, s.id)?.status.kind === "idle");
    await hh.daemon.sessions.close(s.id);
    assert.equal(hh.daemon.sessions.has(s.id), false);

    // when — a send parks inside `resumeSession` (the adapter is built from the
    // row's mode) and a mode change is issued while it is parked
    const releaseResume = provider.blockResume();
    const sending = c.request("session.send", { id: s.id, text: "go" });
    await barrier(c);
    const setting = c.request<SessionSnapshot>("session.setMode", {
      id: s.id,
      mode: "acceptEdits",
      by: "t",
    });
    // Both requests are now past the daemon's dispatch point, so releasing the
    // resume genuinely resolves a race rather than winning it by arriving first.
    await barrier(c);
    releaseResume();
    await sending;
    const snap = await setting;

    // then — the change lands on the rebuilt adapter rather than in the gap
    // where the session looks inactive and only the row gets written
    assert.equal(snap.mode, "acceptEdits");
    const fake = provider.session(s.id);
    assert.ok(fake);
    assert.equal(fake.snapshot().mode, "acceptEdits");
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("a mode change queued behind a removal fails rather than writing a gone session", async () => {
  const hh = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    // given
    const provider = (await hh.daemon.providers.get("fake")) as FakeProvider;
    const s = await c.request<SessionSnapshot>("session.create", {
      prompt: "remove-race",
      provider: "fake",
      mode: "default",
    });
    const fake = provider.session(s.id);
    assert.ok(fake);
    const release = fake.blockMode();

    // when — the mode change parks in the adapter, a removal is queued behind
    // it, and a second mode change lands behind the removal
    const first = c.request("session.setMode", { id: s.id, mode: "plan", by: "t" });
    const removing = c.request("session.remove", { id: s.id, force: true });
    // Settled into a value up front — left bare it would spend the awaits below
    // as an unhandled rejection.
    const afterRemoval = c.request("session.setMode", { id: s.id, mode: "auto", by: "t" }).then(
      () => null,
      (e: unknown) => e,
    );
    release();
    await first;
    await removing;

    // then — the existence recheck runs when the command executes, not when it
    // was issued, so it is conclusive rather than a narrower race
    assert.match(String(await afterRemoval), /no such session/);
    const rows = await c.request<SessionSnapshot[]>("session.list", {});
    assert.equal(
      rows.find((r) => r.id === s.id),
      undefined,
    );
    assert.deepEqual(fake.modeChanges, ["plan"]);
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("a rejected mode change leaves the existing mode and the plan review intact", async () => {
  const hh = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    // given — a session parked on an `ExitPlanMode` review
    const provider = (await hh.daemon.providers.get("fake")) as FakeProvider;
    const s = await c.request<SessionSnapshot>("session.create", {
      prompt: "plan-guard",
      provider: "fake",
      mode: "plan",
    });
    const fake = provider.session(s.id);
    assert.ok(fake);
    fake.emit({ type: "plan_review", id: "p1", plan: "the plan" });
    await waitFor(() => (pushed(c, s.id)?.requests ?? []).some((r) => r.kind === "plan_review"));

    // when
    const rejected = c.request("session.setMode", { id: s.id, mode: "auto", by: "t" });

    // then — the mode never moved, in the adapter or in the row, and the
    // review is still there to be answered deliberately
    await assert.rejects(() => rejected, /plan review is pending/);
    assert.deepEqual(fake.modeChanges, []);
    const rows = await c.request<SessionSnapshot[]>("session.list", {});
    assert.equal(rows.find((r) => r.id === s.id)?.mode, "plan");
    assert.equal(pushed(c, s.id)?.mode, "plan");
    assert.deepEqual(
      (pushed(c, s.id)?.requests ?? []).map((r) => r.id),
      ["p1"],
    );
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("transcript pagination is stable across a daemon restart", async () => {
  const hh = await makeHarness();
  let c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    // given — three entries, all stamped with the *same* timestamp, so nothing
    // but the durable id can order them
    const s = await c.request<SessionSnapshot>("session.createStub", { prompt: "pager" });
    for (const n of [1, 2, 3]) {
      await c.request("dev.emit", {
        event: { sessionId: s.id, type: "assistant_text", text: `before ${n}` },
      });
    }
    const first = await c.request<HistoryPage>("session.events", { id: s.id, limit: 2 });
    const cursor = first.olderCursor;
    assert.ok(cursor, "there is a page behind the newest two");

    // when — the daemon restarts (a new epoch, a seq counter back at 1) and the
    // session picks up more entries, then the *pre-restart* cursor is used
    await c.close();
    await hh.restart();
    c = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });
    for (const n of [4, 5]) {
      await c.request("dev.emit", {
        event: { sessionId: s.id, type: "assistant_text", text: `after ${n}` },
      });
    }

    // then — the cursor still means what it meant, because it is a row id and
    // not a position in a per-process sequence
    const older = await c.request<HistoryPage>("session.events", { id: s.id, limit: 10, cursor });
    assert.deepEqual(
      older.items.map((e) => (e.event as { text?: string }).text),
      ["before 1"],
    );
    assert.equal(older.olderCursor, null, "and the end of the history is explicit");

    // ...and the whole transcript reads in one order across the restart
    const all = await c.request<HistoryPage>("session.events", { id: s.id, limit: 50 });
    assert.deepEqual(
      all.items.map((e) => (e.event as { text?: string }).text),
      ["before 1", "before 2", "before 3", "after 4", "after 5"],
    );
    assert.deepEqual(
      all.items.map((e) => e.id),
      [...all.items].sort((x, y) => x.id - y.id).map((e) => e.id),
      "ids ascend with the transcript, restart or no restart",
    );
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

// --- §2: mode application vs. publication ordering -------------------------

test("a mode command still at the adapter outlives a plan decision that overtook it", async () => {
  const hh = await makeHarness();
  const a = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  const b = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    // given — a live planning session whose adapter `setMode` can be parked
    const provider = (await hh.daemon.providers.get("fake")) as FakeProvider;
    const s = await a.request<SessionSnapshot>("session.create", {
      prompt: "plan-overlap",
      provider: "fake",
      mode: "plan",
    });
    const fake = provider.session(s.id);
    assert.ok(fake);

    // when — (1) a mode change validates (no review is pending yet) and parks
    // inside the adapter
    const release = fake.blockMode();
    const setting = a.request<SessionSnapshot>("session.setMode", {
      id: s.id,
      mode: "default",
      by: "a",
    });
    await barrier(a);
    assert.deepEqual(fake.modeChanges, [], "the command is at the adapter, not through it");

    // (2, 3) a plan review is raised and approved to run in `acceptEdits`,
    // which the adapter applies at once — an approval deliberately does not
    // queue behind a configuration command, or it could never resolve one.
    fake.emit({ type: "plan_review", id: "p1", plan: "the plan" });
    await waitFor(() => (pushed(b, s.id)?.requests ?? []).some((r) => r.kind === "plan_review"));
    await b.request("session.respondPlan", {
      id: s.id,
      requestId: "p1",
      action: "implement",
      mode: "acceptEdits",
      by: "b",
    });
    assert.equal(fake.snapshot().mode, "acceptEdits", "the decision reached the adapter first");

    // (4) release: the parked call applies `default`, so that is where the
    // adapter actually is when everything has settled.
    release();
    await setting;
    assert.equal(fake.snapshot().mode, "default");

    // (5) drain the queue through a later queued configuration command — the
    // plan decision's own queued notification is ahead of it in the chain.
    await a.request("session.setModel", { id: s.id, model: "fake-model" });

    // then — nothing installs the mode the plan decision happened to observe.
    // The notification says "this session's mode changed", and by the time it
    // runs the answer to "to what?" is `default`.
    assert.deepEqual(fake.modeChanges, ["default"]);
    assert.equal(fake.snapshot().mode, "default", "the adapter never moved again");
    const rows = await a.request<SessionSnapshot[]>("session.list", {});
    assert.equal(rows.find((r) => r.id === s.id)?.mode, "default");
    assert.equal(pushed(a, s.id)?.mode, "default");
    await waitFor(() => pushed(b, s.id)?.mode === "default");
  } finally {
    await a.close();
    await b.close();
    await hh.cleanup();
  }
});

test("a mode notification for a session with no live adapter writes nothing", async () => {
  const hh = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const provider = (await hh.daemon.providers.get("fake")) as FakeProvider;
    const s = await c.request<SessionSnapshot>("session.create", {
      prompt: "plan-teardown",
      provider: "fake",
      mode: "plan",
    });
    const fake = provider.session(s.id);
    assert.ok(fake);

    // given — the queue chain is [setMode (parked at the adapter), markDone],
    // and the plan decision then adds its notification behind both
    const release = fake.blockMode();
    const setting = c.request<SessionSnapshot>("session.setMode", {
      id: s.id,
      mode: "default",
      by: "t",
    });
    await barrier(c);
    fake.emit({ type: "plan_review", id: "p1", plan: "the plan" });
    await waitFor(() => (pushed(c, s.id)?.requests ?? []).some((r) => r.kind === "plan_review"));
    const archiving = c.request<SessionSnapshot>("session.markDone", { id: s.id });
    await barrier(c);

    // when — the plan is approved into `acceptEdits` while both are queued
    await c.request("session.respondPlan", {
      id: s.id,
      requestId: "p1",
      action: "implement",
      mode: "acceptEdits",
      by: "t",
    });
    release();
    await setting;
    await archiving;
    await barrier(c);

    // then — `markDone` closed the adapter, so by the time the notification
    // runs there is no live session to read a mode off. It writes nothing
    // rather than installing what the adapter reported before it was torn down.
    assert.equal(hh.daemon.sessions.has(s.id), false);
    const rows = await c.request<SessionSnapshot[]>("session.list", {});
    const row = rows.find((r) => r.id === s.id);
    assert.equal(row?.mode, "default", "the archived row keeps the last applied mode");
    assert.equal(row?.status.kind, "done");
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("doctor reflects configured HTTP mounts, preferences and disabled native tools", async () => {
  const hh = await makeHarness({
    config: `
command-mcp = []
[[http-mcp]]
name = "research"
url = "https://example.invalid/mcp?private=do-not-display"
default_for = ["web_search"]
[providers.claude]
disable_builtin = ["Read"]
`,
  });
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
    reconnect: false,
  });
  try {
    const report = await c.request<DoctorReport>("daemon.doctor");
    assert.deepEqual(report.tools.claudeDisabled, ["Read"]);
    assert.deepEqual(
      report.mcp.map((m) => m.name),
      ["research"],
    );
    assert.match(report.mcp[0]!.note, /Isolated HTTP relay.*web_search/);
    assert.doesNotMatch(JSON.stringify(report.mcp), /do-not-display/);
  } finally {
    c.close();
    await hh.cleanup();
  }
});

test("archive and delete retain the worktree and session when adapter cleanup fails", async () => {
  const hh = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const provider = (await hh.daemon.providers.get("fake")) as FakeProvider;
    const s = await c.request<SessionSnapshot>("session.create", {
      prompt: "cleanup failure",
      provider: "fake",
    });
    const live = provider.session(s.id)!;
    const close = live.close.bind(live);
    live.close = async () => {
      throw new Error("reaper failed");
    };
    for (const method of ["session.markDone", "session.remove"]) {
      await assert.rejects(c.request(method, { id: s.id, force: true }), /reaper failed/);
      assert(hh.daemon.sessions.has(s.id));
      assert(hh.daemon.registry.get(s.id));
      assert(s.worktree && existsSync(s.worktree));
    }
    live.close = close;
    await c.request("session.markDone", { id: s.id, force: true });
    assert(!existsSync(s.worktree!));
    await c.request("session.remove", { id: s.id });
    assert.equal(hh.daemon.registry.get(s.id), null);
  } finally {
    await c.close();
    await hh.cleanup();
  }
});
