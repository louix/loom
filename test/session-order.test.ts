import assert from "node:assert/strict";
import { test } from "node:test";
import { STATUS_ORDER, sortSessions } from "@loom/core/session-order";
import { sortSnapshots } from "../backend/daemon/src/daemon/registry.ts";
import { fleetSessions, initialState, reduce } from "@loom/tui/model";
import { fleet, snap } from "./tui-fixtures.ts";

test("every group retains its order through activity, reversed snapshots and reconnects", () => {
  assert.equal(sortSnapshots, sortSessions, "daemon and UI share the ordering policy");
  for (const status of STATUS_ORDER) {
    const rows = [
      snap({ id: "old", status, createdAt: 1, updatedAt: 100 }),
      snap({ id: "b", status, createdAt: 2, updatedAt: 2 }),
      snap({ id: "a", status, createdAt: 2, updatedAt: 3 }),
    ];
    let state = reduce(initialState(), fleet(rows));
    state = reduce(state, { t: "select", id: "b" });
    const changed = rows.toReversed().map((s, i) => ({
      ...s,
      updatedAt: 1000 + i,
      title: `renamed ${i}`,
      turns: 10 + i,
    }));
    state = reduce(state, fleet(changed));
    assert.deepEqual(
      fleetSessions(state).map((s) => s.id),
      ["a", "b", "old"],
      status,
    );
    assert.equal(state.selectedId, "b");
    const reconnected = reduce(initialState(), fleet(changed));
    assert.deepEqual(fleetSessions(reconnected), fleetSessions(state));
    assert.deepEqual(
      rows.map((s) => s.id),
      ["old", "b", "a"],
      "sort does not mutate its input",
    );
  }
});

test("status changes move groups and return to the same position; new rows preserve peer order", () => {
  const old = snap({ id: "old", status: "running", createdAt: 1 });
  const newer = snap({ id: "newer", status: "running", createdAt: 2 });
  const newest = snap({ id: "newest", status: "running", createdAt: 3 });
  let state = reduce(initialState(), fleet([old, newer]));
  state = reduce(state, { t: "select", id: "old" });
  state = reduce(state, fleet([newer, { ...old, status: { kind: "idle" } }, newest]));
  assert.deepEqual(
    fleetSessions(state).map((s) => s.id),
    ["newest", "newer", "old"],
  );
  state = reduce(state, fleet([old, newest, newer]));
  assert.deepEqual(
    fleetSessions(state).map((s) => s.id),
    ["newest", "newer", "old"],
  );
  assert.equal(state.selectedId, "old");
});
