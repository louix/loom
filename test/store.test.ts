import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpoint, migrate, openDb } from "@loom/daemon/store/db";
import {
  ChildStore,
  CheckpointStore,
  ProviderDefaultStore,
  SessionStore,
} from "@loom/daemon/store/sessions";
import { setLogLevel } from "@loom/core/logger";

setLogLevel("error");

function tmpDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-store-"));
  return { path: join(dir, "loom.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("migrations bring an empty db to head and are idempotent", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const version = () =>
      (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string })
        .value;
    const v1 = version();
    migrate(db); // second call is a no-op
    assert.equal(version(), v1);
    // core tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ["sessions", "status_history", "usage", "runtime_children"]) {
      assert.ok(tables.includes(t), `missing table ${t}`);
    }
    db.close();
  } finally {
    cleanup();
  }
});

test("session create seeds usage + a starting history row", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const store = new SessionStore(db);
    store.create({ id: "s1", provider: "stub", model: "m", title: "do a thing" });

    const snap = store.get("s1");
    assert.ok(snap);
    assert.equal(snap.status, "starting");
    assert.equal(snap.provider, "stub");
    assert.equal(snap.title, "do a thing");
    assert.deepEqual(snap.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

    const hist = store.statusHistory("s1");
    assert.equal(hist.length, 1);
    assert.equal(hist[0]?.status, "starting");
    db.close();
  } finally {
    cleanup();
  }
});

test("setStatus records history and only keeps await_reason while awaiting", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const store = new SessionStore(db);
    store.create({ id: "s1", provider: "stub" });

    store.setStatus("s1", "awaiting_input", "permission");
    assert.equal(store.get("s1")?.status, "awaiting_input");
    assert.equal(store.get("s1")?.awaitReason, "permission");

    store.setStatus("s1", "running");
    assert.equal(store.get("s1")?.awaitReason, null);

    store.setStatus("s1", "idle", "clean");
    assert.equal(store.get("s1")?.awaitReason, null);

    const statuses = store.statusHistory("s1").map((h) => h.status);
    assert.deepEqual(statuses, ["starting", "awaiting_input", "running", "idle"]);
    // reason is still recorded in history even for non-awaiting transitions
    assert.equal(store.statusHistory("s1").at(-1)?.reason, "clean");
    db.close();
  } finally {
    cleanup();
  }
});

test("addUsage accumulates deltas but sets context as absolute", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const store = new SessionStore(db);
    store.create({ id: "s1", provider: "stub" });

    store.addUsage("s1", { input: 100, output: 20, costUsd: 0.01, turns: 1, contextUsed: 100, contextLimit: 200_000 });
    store.addUsage("s1", { input: 50, output: 10, costUsd: 0.005, turns: 1, contextUsed: 150, contextLimit: 200_000 });

    const s = store.get("s1");
    assert.equal(s?.usage.input, 150);
    assert.equal(s?.usage.output, 30);
    assert.equal(s?.turns, 2);
    assert.ok(Math.abs((s?.costUsd ?? 0) - 0.015) < 1e-9);
    assert.equal(s?.contextUsed, 150); // latest, not summed
    db.close();
  } finally {
    cleanup();
  }
});

test("markMidRunInterrupted flips starting/running/awaiting to interrupted", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const store = new SessionStore(db);
    store.create({ id: "a", provider: "stub" }); // starting
    store.create({ id: "b", provider: "stub" });
    store.setStatus("b", "running");
    store.create({ id: "c", provider: "stub" });
    store.setStatus("c", "awaiting_input", "permission");
    store.create({ id: "d", provider: "stub" });
    store.setStatus("d", "idle");

    const flipped = store.markMidRunInterrupted().sort();
    assert.deepEqual(flipped, ["a", "b", "c"]);
    assert.equal(store.get("a")?.status, "interrupted");
    assert.equal(store.get("d")?.status, "idle"); // untouched
    assert.equal(store.statusHistory("b").at(-1)?.reason, "daemon_restart");
    db.close();
  } finally {
    cleanup();
  }
});

test("ChildStore records, lists by epoch, and forgets", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const children = new ChildStore(db);
    children.record(111, "claude-cli", "epoch-A");
    children.record(222, "mcp:tilth", "epoch-A");
    children.record(333, "claude-cli", "epoch-B");

    assert.equal(children.all().length, 3);
    const stale = children.fromOtherEpochs("epoch-B").map((r) => r.pid).sort();
    assert.deepEqual(stale, [111, 222]);

    children.forget(111);
    assert.equal(children.all().length, 2);
    db.close();
  } finally {
    cleanup();
  }
});

test("ProviderDefaultStore remembers the last model per provider, ignores empties", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const pd = new ProviderDefaultStore(db);

    assert.equal(pd.model("openai"), null);
    pd.remember("openai", "gpt-5");
    assert.equal(pd.model("openai"), "gpt-5");
    // last write wins; providers are independent
    pd.remember("openai", "gpt-5-mini");
    pd.remember("deepseek", "deepseek-chat");
    assert.equal(pd.model("openai"), "gpt-5-mini");
    assert.equal(pd.model("deepseek"), "deepseek-chat");
    // an empty model is a no-op, not a wipe
    pd.remember("openai", "");
    assert.equal(pd.model("openai"), "gpt-5-mini");

    db.close();
  } finally {
    cleanup();
  }
});

test("ProviderDefaultStore remembers the last provider and mode picked at creation", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const pd = new ProviderDefaultStore(db);

    assert.equal(pd.provider(), null);
    assert.equal(pd.mode(), null);

    pd.rememberProvider("openai");
    pd.rememberMode("acceptEdits");
    assert.equal(pd.provider(), "openai");
    assert.equal(pd.mode(), "acceptEdits");

    // last write wins
    pd.rememberProvider("deepseek");
    pd.rememberMode("plan");
    assert.equal(pd.provider(), "deepseek");
    assert.equal(pd.mode(), "plan");

    // an empty value is a no-op, not a wipe
    pd.rememberProvider("");
    pd.rememberMode("");
    assert.equal(pd.provider(), "deepseek");
    assert.equal(pd.mode(), "plan");

    db.close();
  } finally {
    cleanup();
  }
});

test("checkpoint does not throw on a live db", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    new SessionStore(db).create({ id: "s1", provider: "stub" });
    checkpoint(db);
    db.close();
  } finally {
    cleanup();
  }
});

test("CheckpointStore records / lists / truncates; setTurns resets the counter", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const sessions = new SessionStore(db);
    sessions.create({ id: "s1", provider: "openai" });

    const cps = new CheckpointStore(db);
    cps.record("s1", { turn: 1, providerRef: "", forkPoint: "2", userText: "first task" });
    cps.record("s1", { turn: 2, providerRef: "", forkPoint: "6", userText: "follow up" });
    cps.record("s1", { turn: 3, providerRef: "", forkPoint: "10", userText: "and again" });

    assert.deepEqual(cps.list("s1").map((c) => c.turn), [1, 2, 3]);
    assert.equal(cps.at("s1", 2)?.forkPoint, "6");
    assert.equal(cps.at("s1", 9), null);

    // re-record turn 2 upserts
    cps.record("s1", { turn: 2, providerRef: "x", forkPoint: "7", userText: "edited" });
    assert.equal(cps.at("s1", 2)?.forkPoint, "7");
    assert.equal(cps.at("s1", 2)?.userText, "edited");

    cps.truncate("s1", 1);
    assert.deepEqual(cps.list("s1").map((c) => c.turn), [1]);

    sessions.setTurns("s1", 1);
    assert.equal(sessions.get("s1")?.turns, 1);

    db.close();
  } finally {
    cleanup();
  }
});
