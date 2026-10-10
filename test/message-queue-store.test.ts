import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "@loom/daemon/store/db";
import { MIGRATIONS } from "@loom/daemon/store/migrations";
import { MessageQueueStore, type QueueResult } from "@loom/daemon/store/message-queue";
import { QUEUE_LIMITS, type QueueEntry } from "@loom/core/message-queue";
import { setLogLevel } from "@loom/core/logger";

setLogLevel("error");

const withStore = (fn: (q: MessageQueueStore, db: Db) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "loom-queue-"));
  const db = openDb(join(dir, "loom.db"));
  try {
    for (const id of ["s", "other"])
      db.prepare(
        "INSERT INTO sessions (id, provider, mode, status, created_at, updated_at) VALUES (?, 'fake', 'default', 'idle', 1, 1)",
      ).run(id);
    fn(new MessageQueueStore(db), db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

const value = <T>(r: QueueResult<T>): T => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
};

const add = (
  q: MessageQueueStore,
  id: string,
  delivery: QueueEntry["delivery"] = "next_boundary",
  text = `text ${id}`,
): QueueEntry => value(q.enqueue("s", { id, text, author: "c1", delivery })).entry;

const order = (q: MessageQueueStore) => q.live("s").map((e) => e.id);

test("live entries come back every next_boundary one first, each group in arrival order", () => {
  withStore((q) => {
    add(q, "e1", "end_of_turn");
    add(q, "b1");
    add(q, "e2", "end_of_turn");
    add(q, "b2");
    assert.deepEqual(order(q), ["b1", "b2", "e1", "e2"]);
    assert.deepEqual(q.live("other"), []);
  });
});

test("re-enqueueing a known id answers with it; different text is a conflict", () => {
  withStore((q) => {
    add(q, "a");
    const again = value(
      q.enqueue("s", { id: "a", text: "text a", author: "c2", delivery: "end_of_turn" }),
    );
    assert.equal(again.created, false);
    assert.equal(again.entry.author, "c1");
    const clash = q.enqueue("s", {
      id: "a",
      text: "other",
      author: "c1",
      delivery: "next_boundary",
    });
    assert.equal(clash.ok, false);
    assert.equal(!clash.ok && clash.code, "conflict");
    // Still answered once it has been consumed: a retried send is not re-queued.
    q.markDelivering("s", ["a"]);
    q.markConsumed("s", "a");
    const settled = value(
      q.enqueue("s", { id: "a", text: "text a", author: "c1", delivery: "next_boundary" }),
    );
    assert.equal(settled.created, false);
    assert.equal(settled.entry.state, "consumed");
    assert.deepEqual(order(q), []);
  });
});

test("enqueue refuses past the entry, size and session limits", () => {
  withStore((q) => {
    const big = q.enqueue("s", {
      id: "big",
      text: "x".repeat(QUEUE_LIMITS.entryBytes + 1),
      author: "c1",
      delivery: "next_boundary",
    });
    assert.equal(!big.ok && big.code, "queue_full");
    for (let i = 0; i < QUEUE_LIMITS.entries; i++) add(q, `e${i}`);
    const full = q.enqueue("s", {
      id: "one-more",
      text: "x",
      author: "c1",
      delivery: "next_boundary",
    });
    assert.equal(!full.ok && full.code, "queue_full");
  });
  withStore((q) => {
    const chunk = "y".repeat(QUEUE_LIMITS.entryBytes - 16);
    for (let i = 0; i < 8; i++) add(q, `c${i}`, "next_boundary", chunk + i);
    const over = q.enqueue("s", {
      id: "over",
      text: chunk,
      author: "c1",
      delivery: "next_boundary",
    });
    assert.equal(!over.ok && over.code, "queue_full");
  });
});

test("every client mutation refuses a stale revision and changes nothing", () => {
  withStore((q) => {
    const a = add(q, "a");
    add(q, "b");
    const stale = { entryId: "a", revision: a.revision + 1 };
    const results = [
      q.edit("s", stale, "new"),
      q.move("s", stale, "down"),
      q.setDelivery("s", stale, "end_of_turn"),
      q.toHead("s", stale),
      q.remove("s", [stale]),
    ];
    for (const r of results) assert.equal(!r.ok && r.code, "conflict");
    assert.deepEqual(order(q), ["a", "b"]);
    assert.equal(q.entry("s", "a")?.text, "text a");
    assert.equal(q.entry("s", "a")?.revision, a.revision);
  });
});

test("edit, move, delivery switch and send-now reorder within the groups and bump revisions", () => {
  withStore((q) => {
    const a = add(q, "a");
    add(q, "b");
    add(q, "e", "end_of_turn");
    const edited = value(q.edit("s", { entryId: "a", revision: a.revision }, "changed"));
    assert.equal(edited.text, "changed");
    assert.ok(edited.revision > a.revision);
    value(q.move("s", { entryId: "a", revision: edited.revision }, "down"));
    assert.deepEqual(order(q), ["b", "a", "e"]);
    const first = q.move("s", { entryId: "b", revision: q.entry("s", "b")!.revision }, "up");
    assert.equal(!first.ok && first.message, "First in its group.");
    const last = q.move("s", { entryId: "e", revision: q.entry("s", "e")!.revision }, "down");
    assert.equal(!last.ok && last.message, "Last in its group.");
    // Switching delivery joins the back of the other group.
    value(
      q.setDelivery("s", { entryId: "b", revision: q.entry("s", "b")!.revision }, "end_of_turn"),
    );
    assert.deepEqual(order(q), ["a", "e", "b"]);
    // Send now: the head of the whole queue, as a next_boundary entry.
    value(q.toHead("s", { entryId: "b", revision: q.entry("s", "b")!.revision }));
    assert.deepEqual(order(q), ["b", "a", "e"]);
    assert.equal(q.entry("s", "b")?.delivery, "next_boundary");
  });
});

test("a handed-over entry is read-only until it is uncertain", () => {
  withStore((q) => {
    add(q, "a");
    add(q, "b");
    q.markDelivering("s", ["a"]);
    const rev = () => ({ entryId: "a", revision: q.entry("s", "a")!.revision });
    for (const r of [q.edit("s", rev(), "x"), q.remove("s", [rev()]), q.toHead("s", rev())])
      assert.equal(!r.ok && r.message, "Already handed to the agent.");
    // b cannot move above it either.
    const up = q.move("s", { entryId: "b", revision: q.entry("s", "b")!.revision }, "up");
    assert.equal(!up.ok && up.code, "refused");
    assert.deepEqual(q.markUncertain("s"), ["a"]);
    assert.equal(q.entry("s", "a")?.uncertain, true);
    value(q.remove("s", [rev()]));
    assert.deepEqual(order(q), ["b"]);
  });
});

test("clear sweeps exactly the observed ids that are still cancellable", () => {
  withStore((q) => {
    add(q, "a");
    add(q, "b");
    add(q, "late");
    q.markDelivering("s", ["b"]);
    const cleared = q.clear("s", ["a", "b", "missing"]);
    assert.deepEqual(
      cleared.map((e) => e.id),
      ["a"],
    );
    assert.deepEqual(order(q), ["b", "late"]);
  });
});

test("requeue puts a discarded entry back at its old place", () => {
  withStore((q) => {
    add(q, "a");
    add(q, "b");
    add(q, "c");
    q.markDelivering("s", ["a", "b"]);
    q.markUncertain("s", ["a"]);
    assert.equal(q.requeue("s", "a"), true);
    assert.equal(q.requeue("s", "c"), false, "only a delivering entry goes back");
    assert.deepEqual(
      q.live("s").map((e) => [e.id, e.state, e.uncertain]),
      [
        ["a", "queued", false],
        ["b", "delivering", false],
        ["c", "queued", false],
      ],
    );
  });
});

test("a restart marks delivering entries uncertain and holds only those sessions", () => {
  withStore((q) => {
    add(q, "a");
    add(q, "b");
    q.enqueue("other", { id: "o", text: "o", author: "c1", delivery: "next_boundary" });
    q.markDelivering("s", ["a"]);
    assert.deepEqual(q.recoverAfterRestart(), ["s"]);
    assert.equal(q.hold("s"), "restart");
    assert.equal(q.hold("other"), null);
    assert.equal(q.entry("s", "a")?.uncertain, true);
    assert.equal(q.entry("s", "b")?.state, "queued");
    assert.deepEqual(q.sessionsWithQueues().sort(), ["other", "s"]);
  });
});

test("settled rows are pruned to the newest few hundred", () => {
  withStore((q) => {
    for (let i = 0; i < QUEUE_LIMITS.settled + 20; i++) {
      add(q, `m${i}`);
      q.markDelivering("s", [`m${i}`]);
      q.markConsumed("s", `m${i}`);
    }
    assert.equal(q.entry("s", "m0"), null);
    assert.equal(q.entry("s", `m${QUEUE_LIMITS.settled + 19}`)?.state, "consumed");
  });
});

test("deleting a session takes its queue with it", () => {
  withStore((q, db) => {
    add(q, "a");
    db.prepare("DELETE FROM sessions WHERE id = 's'").run();
    assert.equal(q.entry("s", "a"), null);
  });
});

test("migration 31 applies to a copied pre-31 database", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-queue-mig-"));
  try {
    const path = join(dir, "loom.db");
    const old = new DatabaseSync(path);
    old.exec("PRAGMA foreign_keys = ON");
    for (let v = 0; v < 30; v++) old.exec(MIGRATIONS[v]!);
    old.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    old.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '30')").run();
    old
      .prepare(
        "INSERT INTO sessions (id, provider, mode, status, created_at, updated_at) VALUES ('old', 'fake', 'default', 'idle', 1, 1)",
      )
      .run();
    old.close();
    const db = openDb(path);
    const q = new MessageQueueStore(db);
    assert.equal(q.hold("old"), null);
    value(q.enqueue("old", { id: "x", text: "hi", author: "c", delivery: "end_of_turn" }));
    q.setHold("old", "interrupt");
    assert.equal(q.hold("old"), "interrupt");
    assert.throws(() =>
      db.prepare("UPDATE sessions SET queue_hold = 'bogus' WHERE id = 'old'").run(),
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
