/**
 * The supervision tree (docs/loom-agents.md): migration 33's columns, the
 * snapshot fields they surface as, and the depth / cycle rules over them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@loom/daemon/store/db";
import { MIGRATIONS } from "@loom/daemon/store/migrations";
import { SessionStore } from "@loom/daemon/store/sessions";
import { supervisionCycle, supervisionDepth, type Supervised } from "@loom/core/agents";
import { sessionSnapshotSchema } from "@loom/core/wire";
import { makeLogger, setLogLevel } from "@loom/core/logger";
import { stateIdle, stateInterrupted, stateRunning } from "@loom/core/session-state";
import type { Db } from "@loom/daemon/store/db";
import { Registry, sortSnapshots } from "@loom/daemon/daemon/registry";

setLogLevel("error");

const withStore = (fn: (store: SessionStore, path: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "loom-agents-store-"));
  try {
    const path = join(dir, "loom.db");
    const db = openDb(path);
    try {
      fn(new SessionStore(db), path);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("migration 33 records the supervisor, profile and task apart from fork lineage", () => {
  assert.match(MIGRATIONS[32]!, /ADD COLUMN supervisor_id/);
  withStore((store) => {
    store.create({ id: "lead", provider: "fake" });
    store.create({ id: "fork", provider: "fake", parentId: "lead" });
    store.create({
      id: "child",
      provider: "fake",
      supervisorId: "lead",
      agentProfile: "implementer",
      taskId: "T-1",
    });
    const child = store.get("child")!;
    assert.equal(child.supervisorId, "lead");
    assert.equal(child.agentProfile, "implementer");
    assert.equal(child.taskId, "T-1");
    assert.equal(child.parentId, null, "supervision is not fork lineage");
    const fork = store.get("fork")!;
    assert.equal(fork.parentId, "lead");
    assert.equal(fork.supervisorId, undefined);
    assert.equal(store.get("lead")!.supervisorId, undefined);
    assert.ok(sessionSnapshotSchema.safeParse(child).success);

    // Detaching clears the link and keeps the record of how it started.
    store.setFields("child", { supervisorId: null });
    assert.equal(store.get("child")!.supervisorId, undefined);
    assert.equal(store.get("child")!.agentProfile, "implementer");

    // Deleting a supervisor leaves its children as sessions of their own.
    store.create({ id: "child2", provider: "fake", supervisorId: "lead" });
    store.delete("lead");
    assert.equal(store.get("child2")!.supervisorId, undefined);
  });
});

test("supervision depth counts from the root and stops at a loop", () => {
  const rows = new Map<string, Supervised>([
    ["a", { id: "a" }],
    ["b", { id: "b", supervisorId: "a" }],
    ["c", { id: "c", supervisorId: "b" }],
    ["x", { id: "x", supervisorId: "y" }],
    ["y", { id: "y", supervisorId: "x" }],
  ]);
  const lookup = (id: string) => rows.get(id);
  assert.equal(supervisionDepth("a", lookup), 1);
  assert.equal(supervisionDepth("b", lookup), 2);
  assert.equal(supervisionDepth("c", lookup), 3);
  assert.equal(supervisionDepth("x", lookup), 2);
  // A session may not supervise itself or anything above it in its own tree.
  assert.equal(supervisionCycle("a", "a", lookup), true);
  assert.equal(supervisionCycle("a", "c", lookup), true);
  assert.equal(supervisionCycle("b", "c", lookup), true);
  assert.equal(supervisionCycle("c", "a", lookup), false);
  assert.equal(supervisionCycle("new", "c", lookup), false);
  assert.equal(supervisionCycle("z", "x", lookup), false);
});

test("the store refuses a supervisor that would close a loop", () => {
  withStore((store) => {
    store.create({ id: "lead", provider: "fake" });
    store.create({ id: "child", provider: "fake", supervisorId: "lead" });
    store.create({ id: "grandchild", provider: "fake", supervisorId: "child" });
    assert.throws(() => store.setFields("lead", { supervisorId: "grandchild" }), /would loop/);
    assert.throws(() => store.setFields("child", { supervisorId: "child" }), /would loop/);
    assert.throws(
      () => store.create({ id: "self", provider: "fake", supervisorId: "self" }),
      /would loop/,
    );
    assert.equal(store.get("lead")!.supervisorId, undefined, "nothing was written");
    assert.equal(store.get("self"), null);
    // A move that keeps the tree a tree is fine.
    store.create({ id: "other", provider: "fake" });
    store.setFields("grandchild", { supervisorId: "other" });
    assert.equal(store.get("grandchild")!.supervisorId, "other");
  });
});

const withRegistry = (fn: (registry: Registry, db: Db, warned: string[]) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "loom-agents-registry-"));
  const db = openDb(join(dir, "loom.db"));
  try {
    const warned: string[] = [];
    fn(new Registry(db, { ...makeLogger("test"), warn: (m) => void warned.push(m) }), db, warned);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

test("a supervisor's children come from one indexed query, in fleet order", () => {
  withRegistry((registry, db) => {
    for (const [id, supervisorId] of [
      ["lead", undefined],
      ["other", undefined],
      ["a", "lead"],
      ["b", "lead"],
      ["c", "other"],
    ] as const)
      registry.create({ id, provider: "fake", ...(supervisorId ? { supervisorId } : {}) });
    registry.setStatus("b", stateRunning);
    assert.deepEqual(
      registry.children("lead").map((s) => s.id),
      sortSnapshots(registry.list().filter((s) => s.supervisorId === "lead")).map((s) => s.id),
    );
    assert.deepEqual(
      registry.store
        .children("lead")
        .map((s) => s.id)
        .sort(),
      ["a", "b"],
    );
    assert.deepEqual(registry.children("a"), []);
    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE supervisor_id = ?")
      .all("lead") as Array<{ detail: string }>;
    assert.match(plan.map((p) => p.detail).join("\n"), /sessions_supervisor_idx/);
  });
});

test("every status listener hears every write; one that throws breaks neither the write nor the rest", () => {
  withRegistry((registry, _db, warned) => {
    registry.create({ id: "s", provider: "fake" });
    const heard: string[] = [];
    registry.watchStatus(() => {
      throw new Error("listener bug");
    });
    const stop = registry.watchStatus((id, state) => heard.push(`${id}:${state.kind}`));
    const snap = registry.setStatus("s", stateInterrupted("supervisor"));
    assert.deepEqual(snap.status, { kind: "interrupted", by: "supervisor" }, "the write stands");
    assert.deepEqual(registry.get("s")!.status, { kind: "interrupted", by: "supervisor" });
    assert.deepEqual(heard, ["s:interrupted"]);
    assert.deepEqual(warned, ["status listener failed"]);
    stop();
    registry.setStatus("s", stateIdle);
    assert.deepEqual(heard, ["s:interrupted"], "unsubscribed");
  });
});
