import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpoint, migrate, openDb } from "../src/store/db.ts";
import { ChildStore, SessionStore } from "../src/store/sessions.ts";
import { setLogLevel } from "../src/util/logger.ts";

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
