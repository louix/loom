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
): QueueEntry => value(q.enqueue("s", { id, text, author: "c1", delivery })).entry!;

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
    assert.equal(again.entry?.author, "c1");
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
    assert.equal(settled.entry?.state, "consumed");
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

/** Settle `n` ordinary entries, oldest first. */
const settleMany = (q: MessageQueueStore, prefix: string, n: number): void => {
  for (let i = 0; i < n; i++) {
    add(q, `${prefix}${i}`);
    q.markDelivering("s", [`${prefix}${i}`]);
    q.markConsumed("s", `${prefix}${i}`);
  }
};

test("pruning keeps the most recently settled, a head-inserted entry's low seq notwithstanding", () => {
  withStore((q) => {
    settleMany(q, "m", QUEUE_LIMITS.settled);
    // Sent to a held queue: in front of everything, so its seq is the lowest.
    const head = { id: "h", text: "now", author: "c1", delivery: "end_of_turn" } as const;
    value(q.enqueue("s", head, { head: true }));
    q.markDelivering("s", ["h"]);
    q.markConsumed("s", "h");
    assert.equal(q.entry("s", "h")?.state, "consumed", "the newest settled row stays whole");
    assert.equal(q.entry("s", "m0"), null, "the oldest one went instead");
    // The client never saw the reply and retries: answered, not queued again.
    const retry = value(q.enqueue("s", head));
    assert.equal(retry.created, false);
    assert.equal(retry.state, "consumed");
    assert.deepEqual(order(q), []);
  });
});

test("a retried send is answered even after its row is pruned", () => {
  withStore((q) => {
    const sent = { id: "x", text: "once", author: "c1", delivery: "next_boundary" } as const;
    value(q.enqueue("s", sent, { head: true }));
    q.markDelivering("s", ["x"]);
    q.markConsumed("s", "x");
    add(q, "c");
    q.remove("s", [{ entryId: "c", revision: 0 }]);
    settleMany(q, "m", QUEUE_LIMITS.settled + 5);
    assert.equal(q.entry("s", "x"), null, "pruned");
    const retry = value(q.enqueue("s", sent));
    assert.deepEqual(retry, { created: false, entry: null, state: "consumed" });
    assert.deepEqual(order(q), [], "not queued a second time");
    const cancelled = value(
      q.enqueue("s", { id: "c", text: "text c", author: "c1", delivery: "next_boundary" }),
    );
    assert.equal(cancelled.state, "cancelled");
    const clash = q.enqueue("s", { ...sent, text: "different" });
    assert.equal(!clash.ok && clash.code, "conflict");
    assert.deepEqual(order(q), []);
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
    q.applyHold("old", { t: "stop", by: null, empty: true });
    assert.equal(q.hold("old"), "interrupt");
    assert.throws(() =>
      db.prepare("UPDATE sessions SET queue_hold = 'bogus' WHERE id = 'old'").run(),
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration 32 orders a pre-32 database's settled rows and keeps answering their ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-queue-mig32-"));
  try {
    const path = join(dir, "loom.db");
    const old = new DatabaseSync(path);
    old.exec("PRAGMA foreign_keys = ON");
    for (let v = 0; v < 31; v++) old.exec(MIGRATIONS[v]!);
    old.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    old.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '31')").run();
    old
      .prepare(
        "INSERT INTO sessions (id, provider, mode, status, created_at, updated_at) VALUES ('s', 'fake', 'default', 'idle', 1, 1)",
      )
      .run();
    const row = old.prepare(
      "INSERT INTO session_queue (session_id, id, seq, text, author, delivery, state, created_at) " +
        "VALUES ('s', ?, ?, ?, 'c', 'next_boundary', 'consumed', 1)",
    );
    // Settled in this order; the later one was head-inserted, so its seq is lower.
    row.run("first", 1, "one");
    row.run("head", -1, "two");
    old.close();
    const db = openDb(path);
    const q = new MessageQueueStore(db);
    settleMany(q, "m", QUEUE_LIMITS.settled - 1);
    assert.equal(q.entry("s", "first"), null, "the earliest settled went first");
    assert.equal(q.entry("s", "head")?.state, "consumed");
    const again = value(
      q.enqueue("s", { id: "first", text: "one", author: "c", delivery: "next_boundary" }),
    );
    assert.deepEqual(again, { created: false, entry: null, state: "consumed" });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hold records whose stop it is; lifting it forgets that", () =>
  withStore((q, db) => {
    assert.equal(q.holdCause("s"), null);
    q.applyHold("s", { t: "stop", by: "supervisor", empty: true });
    assert.deepEqual(q.holdCause("s"), { reason: "interrupt", by: "supervisor" });
    assert.equal(q.hold("s"), "interrupt", "hold() is holdCause()'s reason");
    q.applyHold("s", { t: "lift", respect: "none" });
    assert.equal(q.holdCause("s"), null);
    const row = db.prepare("SELECT queue_hold_by FROM sessions WHERE id = 's'").get() as {
      queue_hold_by: string | null;
    };
    assert.equal(row.queue_hold_by, null);
    assert.throws(() => db.prepare("UPDATE sessions SET queue_hold_by = 'agent'").run());
  }));

// docs/message-queue.md, "Holds": every row of the table, through the one write.
const USER = { reason: "interrupt", by: "user" } as const;
const SUPERVISOR = { reason: "interrupt", by: "supervisor" } as const;
const LOOM_HOLDS = [
  { t: "loom", reason: "crash" },
  { t: "loom", reason: "restart" },
  { t: "loom", reason: "rejected" },
] as const;

test("Holds, user row: a user's stop holds even an empty queue, and lands on any hold as the user's", () =>
  withStore((q) => {
    assert.deepEqual(q.applyHold("s", { t: "stop", by: "user", empty: true }).after, USER);
    // On a supervisor's stop, a crash, a restart, a doubtful hand-over, or
    // Loom's own interrupt: the reason stays, the hold becomes the user's.
    const existing = [
      { t: "stop", by: "supervisor", empty: true },
      { t: "stop", by: null, empty: true },
      ...LOOM_HOLDS,
    ] as const;
    for (const first of existing) {
      q.applyHold("other", { t: "lift", respect: "none" });
      const set = q.applyHold("other", first).after!;
      const after = q.applyHold("other", { t: "stop", by: "user", empty: false }).after;
      assert.deepEqual(after, { reason: set.reason, by: "user" }, JSON.stringify(first));
    }
  }));

test("Holds, H1: nothing but the user changes a user's hold — no stop, crash, restart or rejection", () =>
  withStore((q) => {
    add(q, "a");
    q.applyHold("s", { t: "stop", by: "user", empty: true });
    for (const change of [
      { t: "stop", by: "supervisor", empty: true },
      { t: "stop", by: null, empty: true },
      ...LOOM_HOLDS,
    ] as const) {
      const r = q.applyHold("s", change);
      assert.equal(r.changed, false, JSON.stringify(change));
      assert.deepEqual(q.holdCause("s"), USER);
    }
    // Neither does an agent's message: a supervisor's or a child's waits.
    assert.equal(q.applyHold("s", { t: "lift", respect: "user" }).changed, false);
    assert.equal(q.applyHold("s", { t: "lift", respect: "any" }).changed, false);
    assert.deepEqual(q.holdCause("s"), USER);
    assert.equal(q.applyHold("s", { t: "lift", respect: "none" }).after, null);
  }));

test("Holds, supervisor row: only while entries wait; first come stays; its message lifts it", () =>
  withStore((q) => {
    assert.equal(q.applyHold("s", { t: "stop", by: "supervisor", empty: false }).after, null);
    add(q, "a");
    assert.deepEqual(
      q.applyHold("s", { t: "stop", by: "supervisor", empty: false }).after,
      SUPERVISOR,
    );
    for (const later of LOOM_HOLDS) assert.equal(q.applyHold("s", later).changed, false);
    assert.equal(q.applyHold("s", { t: "lift", respect: "any" }).changed, false, "a report waits");
    assert.equal(q.applyHold("s", { t: "lift", respect: "user" }).after, null, "its message lifts");
  }));

test("Holds, crash / restart / rejected rows: Loom's own, set only when unheld, lifted by a supervisor", () =>
  withStore((q) => {
    for (const hold of LOOM_HOLDS) {
      q.applyHold("s", { t: "lift", respect: "none" });
      assert.deepEqual(q.applyHold("s", hold).after, { reason: hold.reason, by: null });
      for (const later of LOOM_HOLDS) assert.equal(q.applyHold("s", later).changed, false);
      assert.equal(
        q.applyHold("s", { t: "stop", by: "supervisor", empty: true }).changed,
        false,
        "a supervisor's stop on it changes nothing",
      );
      assert.equal(q.applyHold("s", { t: "lift", respect: "any" }).changed, false);
      assert.equal(q.applyHold("s", { t: "lift", respect: "user" }).after, null);
    }
  }));

test("Holds, H5/H6: a restore undoes its own change only while nothing wrote the hold since", () =>
  withStore((q) => {
    q.applyHold("s", { t: "stop", by: "supervisor", empty: true });
    // A close by the user that did not complete: back to the supervisor's.
    const closing = q.applyHold("s", { t: "stop", by: "user", empty: true });
    assert.deepEqual(closing.after, USER);
    assert.equal(q.applyHold("s", { t: "restore", ticket: closing.ticket }).changed, true);
    assert.deepEqual(q.holdCause("s"), SUPERVISOR);
    // A lift undone; but not past a later write — even a user's stop that
    // changed nothing, which re-asserts the user's hold.
    const lift = q.applyHold("s", { t: "lift", respect: "none" });
    assert.equal(q.applyHold("s", { t: "restore", ticket: lift.ticket }).changed, true);
    assert.deepEqual(q.holdCause("s"), SUPERVISOR);
    const user = q.applyHold("s", { t: "stop", by: "user", empty: true });
    q.applyHold("s", { t: "stop", by: "user", empty: true });
    assert.equal(q.applyHold("s", { t: "restore", ticket: user.ticket }).changed, false);
    assert.deepEqual(q.holdCause("s"), USER);
  }));

test("a restart keeps a hold already set: a user's stays the user's", () =>
  withStore((q) => {
    add(q, "a");
    q.markDelivering("s", ["a"]);
    q.applyHold("s", { t: "stop", by: "user", empty: true });
    assert.deepEqual(q.recoverAfterRestart(), ["s"]);
    assert.deepEqual(q.holdCause("s"), USER);
    assert.equal(q.entry("s", "a")?.uncertain, true);
  }));

test("a withdrawn enqueue leaves no trace: the id is new again", () =>
  withStore((q) => {
    add(q, "a");
    assert.equal(q.withdraw("s", "a"), true);
    assert.equal(q.entry("s", "a"), null);
    assert.equal(
      value(q.enqueue("s", { id: "a", text: "other", author: "c1", delivery: "next_boundary" }))
        .created,
      true,
    );
    q.markDelivering("s", ["a"]);
    assert.equal(q.withdraw("s", "a"), false, "a handed-over entry stays");
  }));

test("migration 34 makes an interrupt hold recorded before it the user's", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-queue-mig34-"));
  try {
    const path = join(dir, "loom.db");
    const old = new DatabaseSync(path);
    old.exec("PRAGMA foreign_keys = ON");
    for (let v = 0; v < 33; v++) old.exec(MIGRATIONS[v]!);
    old.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    old.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '33')").run();
    const insert = old.prepare(
      "INSERT INTO sessions (id, provider, mode, status, created_at, updated_at, queue_hold) VALUES (?, 'fake', 'default', 'idle', 1, 1, ?)",
    );
    insert.run("stopped", "interrupt");
    insert.run("crashed", "crash");
    old.close();
    const db = openDb(path);
    const q = new MessageQueueStore(db);
    assert.deepEqual(q.holdCause("stopped"), { reason: "interrupt", by: "user" });
    assert.deepEqual(q.holdCause("crashed"), { reason: "crash", by: null });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
