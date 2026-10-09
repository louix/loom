import assert from "node:assert/strict";
import { test } from "node:test";
import { STATUS_ORDER, sortSessions } from "@loom/core/session-order";
import { sortSnapshots } from "../backend/daemon/src/daemon/registry.ts";
import { fleetSessions, initialState, reduce } from "@loom/tui/model";
import { fleet, snap } from "./tui-fixtures.ts";

const ids = (state: Parameters<typeof fleetSessions>[0]): string[] =>
  fleetSessions(state).map((s) => s.id);

test("every group retains its order through activity, reversed snapshots and reconnects", () => {
  assert.equal(sortSnapshots, sortSessions, "daemon and UI share the ordering policy");
  for (const status of STATUS_ORDER) {
    const rows = [
      snap({ id: "old", status, createdAt: 1, updatedAt: 100 }),
      snap({ id: "b", status, createdAt: 2, updatedAt: 2 }),
      snap({ id: "a", status, createdAt: 2, updatedAt: 3 }),
      snap({ id: "done", status, createdAt: 0, turnCompletedAt: 50 }),
    ];
    let state = reduce(initialState(), fleet(rows));
    state = reduce(state, { t: "select", id: "b" });
    // Everything a streaming turn moves — timestamps, titles, turn counts,
    // usage, the cache countdown, sub-agents and background tasks — but no
    // turn boundary.
    const changed = rows.toReversed().map((s, i) => ({
      ...s,
      updatedAt: 1000 + i,
      title: `renamed ${i}`,
      turns: 10 + i,
      usage: { input: 1000 * i, output: 10, cacheRead: 0, cacheWrite: 0 },
      cache: { ...s.cache, lastTurnAt: 2000 + i },
      subagents: [{ id: `sub${i}`, name: "explore", active: true }],
      backgroundTasks: [{ id: `bg${i}`, kind: "subagent" as const, title: "task" }],
    }));
    state = reduce(state, fleet(changed));
    assert.deepEqual(ids(state), ["done", "a", "b", "old"], status);
    assert.equal(state.selectedId, "b");
    const reconnected = reduce(initialState(), fleet(changed));
    assert.deepEqual(fleetSessions(reconnected), fleetSessions(state));
    assert.deepEqual(
      rows.map((s) => s.id),
      ["old", "b", "a", "done"],
      "sort does not mutate its input",
    );
  }
});

test("within a group the latest completed turn leads; creation time stands in, then id", () => {
  const rows = [
    snap({ id: "fresh", status: "idle", createdAt: 30 }),
    snap({ id: "finished", status: "idle", createdAt: 1, turnCompletedAt: 40 }),
    snap({ id: "stale", status: "idle", createdAt: 2, turnCompletedAt: 10 }),
    snap({ id: "tie-b", status: "idle", createdAt: 20 }),
    snap({ id: "tie-a", status: "idle", createdAt: 5, turnCompletedAt: 20 }),
    snap({ id: "busy", status: "running", createdAt: 0, turnCompletedAt: 1 }),
  ];
  assert.deepEqual(
    sortSessions(rows).map((s) => s.id),
    // Group first: a running row stays above idle ones however old its boundary.
    ["busy", "finished", "fresh", "tie-a", "tie-b", "stale"],
  );
});

test("a turn boundary reorders its group and the selection follows the session, not the row", () => {
  const a = snap({ id: "a", status: "idle", createdAt: 3 });
  const b = snap({ id: "b", status: "idle", createdAt: 2 });
  const c = snap({ id: "c", status: "idle", createdAt: 1 });
  let state = reduce(initialState(), fleet([a, b, c]));
  state = reduce(state, { t: "select", id: "b" });
  assert.deepEqual(ids(state), ["a", "b", "c"]);
  // `c` finished a turn the user sent it: it leads its group from now on.
  state = reduce(state, fleet([a, b, { ...c, turnCompletedAt: 100 }]));
  assert.deepEqual(ids(state), ["c", "a", "b"]);
  assert.equal(state.selectedId, "b", "selection is by id and survives the reorder");
  state = reduce(state, { t: "select", id: "c" });
  // A later boundary elsewhere moves `c` down; it stays selected.
  state = reduce(state, fleet([{ ...a, turnCompletedAt: 200 }, b, { ...c, turnCompletedAt: 100 }]));
  assert.deepEqual(ids(state), ["a", "c", "b"]);
  assert.equal(state.selectedId, "c");
});

test("status changes move groups and return to the same position; new rows preserve peer order", () => {
  const old = snap({ id: "old", status: "running", createdAt: 1, turnCompletedAt: 10 });
  const newer = snap({ id: "newer", status: "running", createdAt: 2 });
  const newest = snap({ id: "newest", status: "running", createdAt: 3 });
  let state = reduce(initialState(), fleet([old, newer]));
  state = reduce(state, { t: "select", id: "old" });
  assert.deepEqual(ids(state), ["old", "newer"]);
  state = reduce(state, fleet([newer, { ...old, status: { kind: "idle" } }, newest]));
  assert.deepEqual(ids(state), ["newest", "newer", "old"]);
  state = reduce(state, fleet([old, newest, newer]));
  assert.deepEqual(ids(state), ["old", "newest", "newer"]);
  assert.equal(state.selectedId, "old");
});
