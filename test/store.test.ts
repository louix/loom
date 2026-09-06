import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpoint, migrate, openDb, withTransaction } from "@loom/daemon/store/db";
import { MIGRATIONS } from "@loom/daemon/store/migrations";
import {
  stateAwaitingInput,
  stateIdle,
  stateInterrupted,
  stateRunning,
} from "@loom/core/session-state";
import {
  ChildStore,
  CheckpointStore,
  ProviderDefaultStore,
  SessionStore,
} from "@loom/daemon/store/sessions";
import { SessionEventStore } from "@loom/daemon/store/session-events";
import { cacheHitRate } from "@loom/core/cache";
import { setLogLevel } from "@loom/core/logger";

setLogLevel("error");

const tmpDb = (): { path: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "loom-store-"));
  return {
    path: join(dir, "loom.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

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

test("a corrective migration reclassifies history_backend for a db that already ran the original (provider-name-based) migration 21, without touching explicit 'codex' rows", () => {
  // Migrations are append-only: a database that already advanced to schema
  // version 21 keeps whatever migration 21's SQL happened to be *when it
  // ran*, forever — the runner only ever executes steps at or past the
  // database's current version, so a later edit to migration 21's own text
  // (which is what an earlier draft of this fix did, before review caught
  // it) never reaches such a database. Simulate exactly that: hand-apply the
  // *original*, naming-based migration 21 SQL (reproduced here verbatim,
  // since the current migrations.ts no longer contains it — rewriting it in
  // place doesn't help a database that already ran it), then open normally
  // and confirm migration 22 alone — not a re-run of 21 — fixes it.
  // (Migration 21, not 20: this branch rebased onto `main`'s own unrelated
  // migration 20, shifting everything from here on by one.)
  const { path, cleanup } = tmpDb();
  try {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON");
    for (let v = 0; v < 20; v++) db.exec(MIGRATIONS[v]!); // migrations 1-20, verbatim
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const setVersion = (v: number): void => {
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(v));
    };
    setVersion(20);
    db.exec(`
      ALTER TABLE sessions ADD COLUMN history_backend TEXT NOT NULL DEFAULT '';
      UPDATE sessions SET history_backend = 'aisdk' WHERE provider = 'chatgpt';
    `);
    setVersion(21);

    const now = Date.now();
    const insertSession = (id: string, provider: string): void => {
      db.prepare(
        "INSERT INTO sessions (id, provider, mode, status, in_place, created_at, updated_at) " +
          "VALUES (?, ?, 'default', 'starting', 1, ?, ?)",
      ).run(id, provider, now, now);
    };
    const withTranscript = (id: string): void => {
      db.prepare(
        "INSERT INTO provider_messages (session_id, seq, role, content, created_at) VALUES (?, 1, 'user', '{}', ?)",
      ).run(id, now);
    };
    // A real Codex thread (no transcript) — the naming-based migration
    // wrongly marked this 'aisdk' just because provider = 'chatgpt'.
    insertSession("s-false-positive", "chatgpt");
    // A genuinely legacy row — the naming-based migration got this right
    // already; the corrective migration must leave it alone.
    insertSession("s-true-positive", "chatgpt");
    withTranscript("s-true-positive");
    // A custom sdk="chatgpt" profile's legacy row — the naming-based
    // migration's `provider = 'chatgpt'` filter never matched it at all.
    insertSession("s-missed-custom", "work");
    withTranscript("s-missed-custom");
    // Explicitly recorded by `Daemon#startSession` after the Phase 4 cutover
    // — must never be overwritten by a heuristic migration.
    insertSession("s-explicit-codex", "chatgpt");
    db.prepare("UPDATE sessions SET history_backend = 'codex' WHERE id = ?").run(
      "s-explicit-codex",
    );
    db.close();

    const reopened = openDb(path); // runs every migration from 21 onward for real
    const backendOf = (id: string): string =>
      (
        reopened.prepare("SELECT history_backend FROM sessions WHERE id = ?").get(id) as {
          history_backend: string;
        }
      ).history_backend;
    assert.equal(
      backendOf("s-false-positive"),
      "",
      "a real Codex thread wrongly marked 'aisdk' is corrected back to native",
    );
    assert.equal(backendOf("s-true-positive"), "aisdk", "a genuinely legacy row stays 'aisdk'");
    assert.equal(
      backendOf("s-missed-custom"),
      "aisdk",
      "a custom sdk=chatgpt profile's legacy row, missed by the naming-based migration, is now caught",
    );
    assert.equal(
      backendOf("s-explicit-codex"),
      "codex",
      "an explicitly-recorded codex row is never overwritten by the corrective migration",
    );
    reopened.close();
  } finally {
    cleanup();
  }
});

test("withTransaction rolls back every write when the body throws, and rejects nesting", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const store = new SessionStore(db);
    const ins = db.prepare(
      "INSERT INTO sessions (id, provider, mode, status, created_at, updated_at) VALUES (?, 'stub', 'default', 'starting', 0, 0)",
    );

    assert.throws(() => {
      withTransaction(db, () => {
        ins.run("rollback-me");
        throw new Error("boom");
      });
    }, /boom/);
    assert.equal(store.get("rollback-me"), null, "the write was rolled back");

    assert.throws(() => withTransaction(db, () => withTransaction(db, () => 1)), /not re-entrant/);

    // Still usable after a rolled-back transaction / a rejected nested call.
    store.create({ id: "after", provider: "stub" });
    assert.ok(store.get("after"));
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
    assert.equal(snap.status.kind, "starting");
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

test("setStatus round-trips the state union and records history with the note", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const store = new SessionStore(db);
    store.create({ id: "s1", provider: "stub" });

    store.setStatus("s1", stateAwaitingInput("permission"));
    assert.deepEqual(store.get("s1")?.status, { kind: "awaiting_input", on: "permission" });

    store.setStatus("s1", stateRunning);
    assert.deepEqual(store.get("s1")?.status, { kind: "running" });

    store.setStatus("s1", stateIdle, "clean");
    assert.deepEqual(store.get("s1")?.status, { kind: "idle" });

    const statuses = store.statusHistory("s1").map((h) => h.status);
    assert.deepEqual(statuses, ["starting", "awaiting_input", "running", "idle"]);
    // the transition note is recorded in history
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

    store.addUsage("s1", {
      input: 100,
      output: 20,
      costUsd: 0.01,
      turns: 1,
      contextUsed: 100,
      contextLimit: 200_000,
    });
    store.addUsage("s1", {
      input: 50,
      output: 10,
      costUsd: 0.005,
      turns: 1,
      contextUsed: 150,
      contextLimit: 200_000,
    });

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

test("the observed cache TTL is absolute and survives deltas that omit it", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const store = new SessionStore(db);
    store.create({ id: "s1", provider: "stub" });

    assert.equal(store.get("s1")?.cache.ttlMinutes, 0);
    assert.equal(store.get("s1")?.cache.ttlSource, "none");

    store.addUsage("s1", { cacheWrite: 4000, lastCacheTtlMinutes: 60 });
    assert.equal(store.get("s1")?.cache.ttlMinutes, 60);
    assert.equal(store.get("s1")?.cache.ttlSource, "observed");

    // A bare turn tick carries no TTL — it must not clear the observation.
    store.addUsage("s1", { turns: 1 });
    assert.equal(store.get("s1")?.cache.ttlMinutes, 60);

    // A provider that changes its mind is followed, not averaged.
    store.addUsage("s1", { cacheWrite: 4000, lastCacheTtlMinutes: 5 });
    assert.equal(store.get("s1")?.cache.ttlMinutes, 5);
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
    store.setStatus("b", stateRunning);
    store.create({ id: "c", provider: "stub" });
    store.setStatus("c", stateAwaitingInput("permission"));
    store.create({ id: "d", provider: "stub" });
    store.setStatus("d", stateIdle);

    const flipped = store.markMidRunInterrupted().sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(flipped, [
      { id: "a", was: "starting" },
      { id: "b", was: "running" },
      { id: "c", was: "awaiting_input" },
    ]);
    assert.deepEqual(store.get("a")?.status, stateInterrupted("user"));
    assert.equal(store.get("d")?.status.kind, "idle"); // untouched
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
    const stale = children
      .fromOtherEpochs("epoch-B")
      .map((r) => r.pid)
      .sort();
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
    const cp = (turn: number, forkPoint: string, userText: string) => ({
      turn,
      providerRef: "",
      forkPoint,
      userText,
      headSha: "",
      headDirty: false,
    });
    cps.record("s1", cp(1, "2", "first task"));
    cps.record("s1", { ...cp(2, "6", "follow up"), headSha: "a".repeat(40), headDirty: true });
    cps.record("s1", cp(3, "10", "and again"));

    assert.deepEqual(
      cps.list("s1").map((c) => c.turn),
      [1, 2, 3],
    );
    assert.equal(cps.at("s1", 2)?.forkPoint, "6");
    assert.equal(cps.at("s1", 2)?.headSha, "a".repeat(40));
    assert.equal(cps.at("s1", 2)?.headDirty, true, "dirty flag round-trips as a boolean");
    assert.equal(cps.at("s1", 1)?.headDirty, false);
    assert.equal(cps.at("s1", 9), null);

    // re-record turn 2 upserts
    cps.record("s1", { ...cp(2, "7", "edited"), providerRef: "x" });
    assert.equal(cps.at("s1", 2)?.forkPoint, "7");
    assert.equal(cps.at("s1", 2)?.userText, "edited");
    assert.equal(cps.at("s1", 2)?.headSha, "", "upsert cleared the SHA");

    cps.truncate("s1", 1);
    assert.deepEqual(
      cps.list("s1").map((c) => c.turn),
      [1],
    );

    sessions.setTurns("s1", 1);
    assert.equal(sessions.get("s1")?.turns, 1);

    db.close();
  } finally {
    cleanup();
  }
});

test("SessionEventStore: append/list preserves order, respects limit, cascades on session delete", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const sessions = new SessionStore(db);
    sessions.create({ id: "s1", provider: "claude" });

    const events = new SessionEventStore(db);
    events.append("s1", 10, "epoch-a", {
      type: "assistant_text",
      sessionId: "s1",
      ts: 1,
      text: "one",
    });
    events.append("s1", 11, "epoch-a", {
      type: "assistant_text",
      sessionId: "s1",
      ts: 2,
      text: "two",
    });
    // The seq counter restarts with the daemon; the row's epoch is what makes
    // (seq 10, pre-restart) and (seq 10, post-restart) distinct on replay.
    events.append("s1", 10, "epoch-b", {
      type: "user_message",
      sessionId: "s1",
      ts: 3,
      text: "after restart",
      injected: false,
    });

    const all = events.list("s1");
    assert.deepEqual(
      all.map((f) => [f.seq, f.epoch, (f.event as { text: string }).text]),
      [
        [10, "epoch-a", "one"],
        [11, "epoch-a", "two"],
        [10, "epoch-b", "after restart"],
      ],
    );
    assert.ok(all.every((f) => f.kind === "push" && f.type === "event"));

    // limit keeps the most recent N, still oldest-first
    const capped = events.list("s1", { limit: 2 });
    assert.deepEqual(
      capped.map((f) => (f.event as { text: string }).text),
      ["two", "after restart"],
    );

    sessions.delete("s1");
    assert.deepEqual(events.list("s1"), []);

    db.close();
  } finally {
    cleanup();
  }
});

test("SessionEventStore: `before` cursor pages strictly older rows, across epochs", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    new SessionStore(db).create({ id: "s1", provider: "claude" });
    const events = new SessionEventStore(db);

    // Six rows: seq 1-3 under epoch-a, then seq 1-3 again under epoch-b (a
    // daemon restart resets the counter). Insertion order is the true order.
    for (const [epoch, seq, ts] of [
      ["epoch-a", 1, 1],
      ["epoch-a", 2, 2],
      ["epoch-a", 3, 3],
      ["epoch-b", 1, 4],
      ["epoch-b", 2, 5],
      ["epoch-b", 3, 6],
    ] as const) {
      events.append("s1", seq, epoch, {
        type: "assistant_text",
        sessionId: "s1",
        ts,
        text: `${epoch}#${seq}`,
      });
    }

    // Page back from the newest: last 2, then the 2 before that, then the rest.
    const p1 = events.list("s1", { limit: 2 });
    assert.deepEqual(texts(p1), ["epoch-b#2", "epoch-b#3"]);

    const p2 = events.list("s1", { limit: 2, before: { epoch: "epoch-b", seq: 2 } });
    assert.deepEqual(texts(p2), ["epoch-a#3", "epoch-b#1"]);

    // Cursor straddles the epoch boundary — `seq` alone would be ambiguous here.
    const p3 = events.list("s1", { limit: 10, before: { epoch: "epoch-a", seq: 3 } });
    assert.deepEqual(texts(p3), ["epoch-a#1", "epoch-a#2"]);

    // `before` at the very newest row → every older row, still oldest-first.
    const fromNewest = events.list("s1", { before: { epoch: "epoch-b", seq: 3 } });
    assert.deepEqual(texts(fromNewest), [
      "epoch-a#1",
      "epoch-a#2",
      "epoch-a#3",
      "epoch-b#1",
      "epoch-b#2",
    ]);

    // Exact-page-multiple boundary: a full page, then the next cursor yields [].
    const full = events.list("s1", { limit: 3 });
    assert.deepEqual(texts(full), ["epoch-b#1", "epoch-b#2", "epoch-b#3"]);
    assert.equal(full.length, 3); // == limit, so the client keeps paging
    const past = events.list("s1", { limit: 3, before: { epoch: "epoch-b", seq: 1 } });
    assert.deepEqual(texts(past), ["epoch-a#1", "epoch-a#2", "epoch-a#3"]);
    assert.deepEqual(events.list("s1", { limit: 3, before: { epoch: "epoch-a", seq: 1 } }), []);

    // Oldest row: nothing is strictly older.
    assert.deepEqual(events.list("s1", { before: { epoch: "epoch-a", seq: 1 } }), []);

    // Unknown cursor reports "nothing older" rather than the newest page again.
    assert.deepEqual(events.list("s1", { before: { epoch: "ghost", seq: 9 } }), []);

    db.close();
  } finally {
    cleanup();
  }
});

test("SessionEventStore: `before` cursor is scoped to the session, and to the newest dup", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const sessions = new SessionStore(db);
    sessions.create({ id: "s1", provider: "claude" });
    sessions.create({ id: "s2", provider: "claude" });
    const events = new SessionEventStore(db);

    // Both sessions carry a row with the same (epoch, seq).
    events.append("s1", 1, "e", { type: "assistant_text", sessionId: "s1", ts: 1, text: "s1-a" });
    events.append("s2", 1, "e", { type: "assistant_text", sessionId: "s2", ts: 2, text: "s2-a" });
    events.append("s1", 2, "e", { type: "assistant_text", sessionId: "s1", ts: 3, text: "s1-b" });

    // The cursor lookup for s1 must not resolve s2's rowid.
    assert.deepEqual(texts(events.list("s1", { before: { epoch: "e", seq: 2 } })), ["s1-a"]);

    // Legacy rows all share epoch '': two rows with ('', 1), a later ('', 2).
    // The cursor picks the newest ('', 1), so paging before it never skips a
    // genuinely-older row (no gap); it may re-emit the older ('', 1) dup, which
    // the client dedupes.
    events.append("s2", 1, "", { type: "assistant_text", sessionId: "s2", ts: 4, text: "old-1a" });
    events.append("s2", 1, "", { type: "assistant_text", sessionId: "s2", ts: 5, text: "old-1b" });
    events.append("s2", 2, "", { type: "assistant_text", sessionId: "s2", ts: 6, text: "old-2" });
    const older = texts(events.list("s2", { before: { epoch: "", seq: 1 } }));
    assert.ok(older.includes("s2-a"), "keeps rows genuinely older than the cursor");
    assert.ok(!older.includes("old-1b"), "excludes the cursor row itself");
    assert.ok(!older.includes("old-2"), "excludes newer rows");

    db.close();
  } finally {
    cleanup();
  }
});

const texts = (frames: { event: unknown }[]): string[] =>
  frames.map((f) => (f.event as { text: string }).text);

test("addModelUsage splits spend by model and reports a cache hit rate", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const store = new SessionStore(db);
    store.create({ id: "s1", provider: "claude" });
    store.create({ id: "s2", provider: "claude" });

    assert.deepEqual(store.modelUsage(), []);

    store.addModelUsage("s1", "claude", "opus", {
      input: 100,
      cacheRead: 800,
      cacheWrite: 100,
      costUsd: 0.5,
      turns: 1,
      lastCacheTtlMinutes: 60,
    });
    // Same session, after a `session.setModel` — a separate row, not a blend.
    store.addModelUsage("s1", "claude", "haiku", { input: 1000, turns: 1 });
    store.addModelUsage("s2", "claude", "opus", { input: 100, cacheRead: 900, turns: 1 });

    const all = store.modelUsage();
    assert.deepEqual(
      all.map((m) => m.model),
      ["opus", "haiku"], // busiest first
    );
    const opus = all[0]!;
    assert.equal(opus.sessions, 2);
    assert.equal(opus.input, 200);
    assert.equal(opus.cacheRead, 1700);
    assert.equal(opus.turns, 2);
    assert.equal(opus.ttlMinutes, 60);
    assert.ok(Math.abs((cacheHitRate(opus) ?? 0) - 1700 / 2000) < 1e-9);

    // haiku never cached: a real 0%, not "unknown".
    const haiku = all[1]!;
    assert.equal(cacheHitRate(haiku), 0);
    assert.equal(haiku.ttlMinutes, 0);

    // Narrowed to one session.
    const s2 = store.modelUsage("s2");
    assert.equal(s2.length, 1);
    assert.equal(s2[0]?.sessions, 1);
    assert.equal(s2[0]?.input, 100);

    // A later delta with no TTL must not clear the observation; a new one wins.
    store.addModelUsage("s1", "claude", "opus", { input: 10, turns: 1 });
    assert.equal(store.modelUsage("s1")[0]?.ttlMinutes, 60);
    store.addModelUsage("s1", "claude", "opus", { cacheWrite: 50, lastCacheTtlMinutes: 5 });
    assert.equal(store.modelUsage("s1")[0]?.ttlMinutes, 5);
    db.close();
  } finally {
    cleanup();
  }
});

test("cacheHitRate distinguishes 'nothing spent' from 'never cached'", () => {
  assert.equal(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(cacheHitRate({ input: 100, cacheRead: 0, cacheWrite: 0 }), 0);
  assert.equal(cacheHitRate({ input: 0, cacheRead: 100, cacheWrite: 0 }), 1);
  // A cache *write* is a miss for the tokens it covers — it was not served.
  assert.equal(cacheHitRate({ input: 0, cacheRead: 50, cacheWrite: 50 }), 0.5);
});

test("a cache hit after an idle gap records a lower bound on the TTL", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const store = new SessionStore(db);
    store.create({ id: "s1", provider: "gw" });
    const row = () => store.modelUsage("s1")[0];
    const T0 = 1_700_000_000_000;
    const min = (n: number) => T0 + n * 60_000;

    // First turn: nothing to measure a gap from.
    store.addModelUsage("s1", "gw", "m", { input: 100, cacheWrite: 900, lastTurnAt: min(0) });
    assert.equal(row()?.maxHitGapSec, 0);

    // A hit 10 minutes later proves the entry survived 10 minutes.
    store.addModelUsage("s1", "gw", "m", { cacheRead: 900, lastTurnAt: min(10) });
    assert.equal(row()?.maxHitGapSec, 600);

    // A shorter hit doesn't lower the bound — it only ever grows.
    store.addModelUsage("s1", "gw", "m", { cacheRead: 900, lastTurnAt: min(11) });
    assert.equal(row()?.maxHitGapSec, 600);

    // A longer one does.
    store.addModelUsage("s1", "gw", "m", { cacheRead: 900, lastTurnAt: min(36) });
    assert.equal(row()?.maxHitGapSec, 1500);

    // A *miss* after a long gap proves nothing — it could be expiry, or the
    // prefix could have been invalidated. Not recorded.
    store.addModelUsage("s1", "gw", "m", { input: 100, cacheWrite: 900, lastTurnAt: min(200) });
    assert.equal(row()?.maxHitGapSec, 1500);
    db.close();
  } finally {
    cleanup();
  }
});

test("the hit-gap bound is per provider+model, from that model's own last turn", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const store = new SessionStore(db);
    store.create({ id: "s1", provider: "gw" });
    const T0 = 1_700_000_000_000;
    const min = (n: number) => T0 + n * 60_000;
    // Caches are model-scoped, so a gap measured across a `setModel` would
    // describe the wrong cache. Each pair keeps its own last-turn clock.
    store.addModelUsage("s1", "gw", "a", { input: 10, cacheWrite: 900, lastTurnAt: min(0) });
    store.addModelUsage("s1", "gw", "b", { input: 10, cacheWrite: 900, lastTurnAt: min(30) });
    store.addModelUsage("s1", "gw", "b", { cacheRead: 900, lastTurnAt: min(35) });
    const rows = store.modelUsage("s1");
    // `b`'s gap is measured from `b`'s own last turn (5m), not from `a`'s (35m).
    assert.equal(rows.find((r) => r.model === "b")?.maxHitGapSec, 300);
    assert.equal(rows.find((r) => r.model === "a")?.maxHitGapSec, 0);
    db.close();
  } finally {
    cleanup();
  }
});

test("switching provider or model forgets the cache observation", () => {
  const { path, cleanup } = tmpDb();
  try {
    const db = openDb(path);
    const store = new SessionStore(db);
    store.create({ id: "s1", provider: "gw", model: "a" });
    const cache = () => store.get("s1")?.cache;

    store.addUsage("s1", {
      cacheRead: 9000,
      cacheWrite: 500,
      lastTurnAt: 1_700_000_000_000,
      lastCacheRead: 9000,
      lastCacheWrite: 500,
      lastCacheTtlMinutes: 60,
    });
    assert.equal(cache()?.ttlMinutes, 60);
    assert.equal(cache()?.ttlSource, "observed");

    // A no-op re-assert must not reset a live countdown.
    store.setFields("s1", { model: "a" });
    assert.equal(cache()?.ttlMinutes, 60);
    assert.equal(cache()?.lastTurnAt, 1_700_000_000_000);
    // Nor must an unrelated field.
    store.setFields("s1", { title: "hi" });
    assert.equal(cache()?.ttlMinutes, 60);

    // A real model change strands the entry: caches are model-scoped, so the
    // new model starts cold and nothing measured about the old one applies.
    store.setFields("s1", { model: "b" });
    assert.deepEqual(cache(), {
      ttlMinutes: 0,
      ttlSource: "none",
      lastTurnAt: 0,
      lastRead: 0,
      lastWrite: 0,
    });
    // Cumulative totals are untouched — only the liveness observation is.
    assert.equal(store.get("s1")?.usage.cacheRead, 9000);

    // Same for a provider switch (`session.setProvider` mid-chat).
    store.addUsage("s1", { lastTurnAt: 1_700_000_100_000, lastCacheTtlMinutes: 5 });
    assert.equal(cache()?.ttlMinutes, 5);
    store.setFields("s1", { provider: "other", model: "b" });
    assert.equal(cache()?.ttlMinutes, 0);
    assert.equal(cache()?.lastTurnAt, 0);
    db.close();
  } finally {
    cleanup();
  }
});
