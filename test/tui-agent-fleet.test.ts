/**
 * Loom agents in the FLEET (docs/loom-agents.md): the status a supervisor
 * shows while its agents work (`fleet-status.ts`), and the cursor's walk of
 * the tree — ↑/↓ over the top-level rows, → into a session's tasks and
 * agents, ← back out — with archived agents out of the way until entered.
 */
import { fleet, snap } from "./tui-fixtures.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionStateKind } from "@loom/core/events";
import type { SessionSnapshot } from "@loom/core/wire";
import { STATUS_ORDER } from "@loom/core/session-order";
import { describeCommands } from "@loom/tui/commands";
import { shownStatus, shownStatusIn } from "@loom/tui/fleet-status";
import {
  fleetEntries,
  fleetSessions,
  initialState,
  reduce,
  type Action,
  type TuiState,
} from "@loom/tui/model";

const withFleet = (sessions: SessionSnapshot[]): TuiState =>
  reduce(initialState(), fleet(sessions));

const steps = (s: TuiState, ...actions: Action[]): TuiState => actions.reduce(reduce, s);

const cursor = (s: TuiState): [string | null, string | null] => [s.selectedId, s.selectedChild];

/** The session rows drawn, with what each shows. */
const rows = (s: TuiState): Array<[string, SessionStateKind]> =>
  fleetEntries(s).flatMap((e) => (e.kind === "session" ? [[e.s.id, e.status] as const] : []));

const OWN_WINS: readonly SessionStateKind[] = [
  "awaiting_input",
  "running",
  "starting",
  "working_background",
  "interrupted",
  "error",
  "done",
];

describe("shownStatus", () => {
  test("quiet agents leave every state as it is", () => {
    for (const kind of STATUS_ORDER) assert.equal(shownStatus(kind, "agents_quiet"), kind);
  });

  test("busy agents turn an ended turn into background work, and nothing else", () => {
    assert.equal(shownStatus("idle", "agents_busy"), "working_background");
    for (const kind of OWN_WINS) assert.equal(shownStatus(kind, "agents_busy"), kind, kind);
  });
});

describe("shownStatusIn", () => {
  const lead = (status: SessionStateKind) => snap({ id: "lead", status });
  const agent = (id: string, status: SessionStateKind, supervisorId = "lead") =>
    snap({ id, status, supervisorId });

  test("an idle supervisor shows as working while an agent runs, starts or works on", () => {
    for (const kind of ["running", "starting", "working_background"] as const) {
      const list = [lead("idle"), agent("a", kind)];
      assert.equal(shownStatusIn(list)(list[0]!), "working_background", kind);
    }
  });

  test("an agent's question, error, stop or rest does not reach its supervisor", () => {
    for (const kind of ["awaiting_input", "error", "interrupted", "idle", "done"] as const) {
      const list = [lead("idle"), agent("a", kind)];
      assert.equal(shownStatusIn(list)(list[0]!), "idle", kind);
    }
    const failing = [lead("idle"), agent("a", "error"), agent("b", "awaiting_input")];
    assert.equal(shownStatusIn(failing)(failing[0]!), "idle");
  });

  test("a supervisor's own question, error, turn or stop outranks its agents' work", () => {
    for (const kind of OWN_WINS) {
      const list = [lead(kind), agent("a", "running")];
      assert.equal(shownStatusIn(list)(list[0]!), kind, kind);
    }
  });

  test("an agent's agents count, however deep; the agents show their own", () => {
    const list = [lead("idle"), agent("mid", "idle"), agent("leaf", "running", "mid")];
    const shown = shownStatusIn(list);
    assert.deepEqual(
      list.map((s) => shown(s)),
      ["working_background", "working_background", "running"],
    );
  });

  test("a supervision loop ends; a session outside the list shows its own state", () => {
    const list = [agent("x", "idle", "y"), agent("y", "idle", "x")];
    assert.equal(shownStatusIn(list)(list[0]!), "idle");
    const running = [agent("x", "idle", "y"), agent("y", "running", "x")];
    assert.equal(shownStatusIn(running)(running[0]!), "working_background");
    assert.equal(shownStatusIn([])(lead("idle")), "idle");
  });
});

describe("the fleet groups a supervisor by what it shows", () => {
  test("an idle supervisor joins background work while an agent runs, and leaves after", () => {
    const busy = [
      snap({ id: "lead", status: "idle", createdAt: 1 }),
      snap({ id: "kid", status: "running", supervisorId: "lead", createdAt: 2 }),
      snap({ id: "rest", status: "idle", createdAt: 3 }),
    ];
    let s = withFleet(busy);
    s = reduce(s, { t: "select", id: "lead" });
    assert.deepEqual(rows(s), [
      ["lead", "working_background"],
      ["kid", "running"],
      ["rest", "idle"],
    ]);
    assert.equal(fleetSessions(s)[0]!.status.kind, "idle", "its own state is left alone");
    const done = busy.map((x) =>
      x.id === "kid" ? { ...x, status: { kind: "idle" as const } } : x,
    );
    s = reduce(s, fleet(done));
    assert.deepEqual(
      rows(s).map(([id]) => id),
      ["rest", "lead", "kid"],
      "back among the idle, by its turn boundary",
    );
    assert.equal(s.selectedId, "lead", "the cursor follows the session, not the row");
  });
});

/**
 *   top                (running)
 *   lead               (idle, two tasks)
 *   ├ ask              (awaiting_input)
 *   ├ work             (running, one task)
 *   └ old              (done — drawn only while lead is entered)
 *   bottom             (idle)
 */
const tree = (): SessionSnapshot[] => [
  snap({ id: "top", status: "running", createdAt: 1 }),
  snap({
    id: "lead",
    status: "idle",
    createdAt: 2,
    backgroundTasks: [
      { id: "t1", kind: "shell", title: "watch" },
      { id: "t2", kind: "shell", title: "serve" },
    ],
  }),
  snap({ id: "work", status: "running", supervisorId: "lead", createdAt: 3, turnCompletedAt: 3 }),
  snap({
    id: "ask",
    status: "awaiting_input",
    supervisorId: "lead",
    createdAt: 4,
    backgroundTasks: [{ id: "w1", kind: "shell", title: "build" }],
  }),
  snap({ id: "old", status: "done", supervisorId: "lead", createdAt: 0 }),
  snap({ id: "bottom", status: "idle", createdAt: 5 }),
];

describe("the cursor in a supervision tree", () => {
  test("↑/↓ walk the top-level rows only", () => {
    let s = reduce(withFleet(tree()), { t: "select", id: "top" });
    s = reduce(s, { t: "move", delta: 1 });
    assert.equal(s.selectedId, "lead");
    s = reduce(s, { t: "move", delta: 1 });
    assert.equal(s.selectedId, "bottom", "past lead's agents");
    s = reduce(s, { t: "move", delta: -1 });
    assert.equal(s.selectedId, "lead");
  });

  test("→ enters a session's tasks then its agents, ↑/↓ walk them, ← steps out", () => {
    let s = reduce(withFleet(tree()), { t: "select", id: "lead" });
    s = reduce(s, { t: "childEnter" });
    assert.deepEqual(cursor(s), ["lead", "bg:t1"]);
    const walk: Array<[string | null, string | null]> = [];
    for (let i = 0; i < 5; i++) {
      s = reduce(s, { t: "childMove", delta: 1 });
      walk.push(cursor(s));
    }
    assert.deepEqual(walk, [
      ["lead", "bg:t2"],
      ["ask", null],
      ["work", null],
      ["old", null],
      ["old", null],
    ]);
    s = reduce(s, { t: "childExit" });
    assert.deepEqual(cursor(s), ["lead", null]);
    s = reduce(s, { t: "childExit" });
    assert.deepEqual(cursor(s), ["lead", null], "nothing to step out of at the top");
  });

  test("an agent's own tasks are a level further in, and ← climbs one level at a time", () => {
    let s = reduce(withFleet(tree()), { t: "select", id: "ask" });
    s = reduce(s, { t: "childEnter" });
    assert.deepEqual(cursor(s), ["ask", "bg:w1"]);
    s = reduce(s, { t: "childMove", delta: 1 });
    assert.deepEqual(cursor(s), ["ask", "bg:w1"], "its own tasks only");
    s = steps(s, { t: "childExit" });
    assert.deepEqual(cursor(s), ["ask", null]);
    s = steps(s, { t: "childExit" });
    assert.deepEqual(cursor(s), ["lead", null]);
  });

  test("a nested agent keeps every session verb; its supervisor's task rows do not", () => {
    const s = steps(
      withFleet(tree()),
      { t: "select", id: "lead" },
      { t: "childEnter" },
      { t: "childMove", delta: 3 },
    );
    assert.deepEqual(cursor(s), ["work", null]);
    const enabled = new Set(describeCommands(s).flatMap((a) => (a.disabled ? [] : [a.id])));
    for (const id of ["send", "interrupt", "childExit"] as const) assert.ok(enabled.has(id), id);
    const onTask = steps(withFleet(tree()), { t: "select", id: "lead" }, { t: "childEnter" });
    const task = new Map(describeCommands(onTask).map((a) => [a.id, a.disabled]));
    assert.match(task.get("interrupt") ?? "", /Select the session row/);
  });

  test("archived agents are drawn, last, only while the supervisor is entered", () => {
    const top = reduce(withFleet(tree()), { t: "select", id: "lead" });
    assert.deepEqual(
      rows(top).map(([id]) => id),
      ["top", "lead", "ask", "work", "bottom"],
    );
    const inside = reduce(top, { t: "childEnter" });
    assert.deepEqual(
      rows(inside).map(([id]) => id),
      ["top", "lead", "ask", "work", "old", "bottom"],
    );
    const onOld = steps(inside, { t: "childMove", delta: 9 });
    assert.deepEqual(cursor(onOld), ["old", null]);
    assert.ok(rows(onOld).some(([id, status]) => id === "old" && status === "done"));
  });

  test("an entered supervisor's task rows are uncapped while the cursor is on its agent", () => {
    const tasks = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      kind: "shell" as const,
      title: `task ${i}`,
    }));
    const list = [
      snap({ id: "lead", status: "idle", backgroundTasks: tasks }),
      snap({ id: "kid", status: "running", supervisorId: "lead" }),
    ];
    const drawn = (s: TuiState) => fleetEntries(s).filter((e) => e.kind === "child").length;
    assert.equal(drawn(reduce(withFleet(list), { t: "select", id: "lead" })), 4);
    const onKid = reduce(withFleet(list), { t: "select", id: "kid" });
    assert.equal(drawn(onKid), 6);
    assert.deepEqual(cursor(reduce(onKid, { t: "childMove", delta: -1 })), ["lead", "bg:t5"]);
  });

  test("the selected agent stays selected while its siblings reorder", () => {
    let s = steps(withFleet(tree()), { t: "select", id: "work" });
    const swapped = tree().map((x) => {
      if (x.id === "ask") return snap({ ...x, status: "idle" });
      if (x.id === "work") return snap({ ...x, status: "awaiting_input" });
      return x;
    });
    s = reduce(s, fleet(swapped));
    assert.deepEqual(
      rows(s).flatMap(([id]) => (id === "work" || id === "ask" ? [id] : [])),
      ["work", "ask"],
    );
    assert.deepEqual(cursor(s), ["work", null]);
  });

  test("a selected agent archived or removed hands the cursor back to its supervisor", () => {
    const on = reduce(withFleet(tree()), { t: "select", id: "work" });
    const archived = tree().map((x) =>
      x.id === "work" ? { ...x, status: { kind: "done" as const } } : x,
    );
    assert.deepEqual(cursor(reduce(on, fleet(archived))), ["lead", null]);
    const removed = tree().filter((x) => x.id !== "work");
    assert.deepEqual(cursor(reduce(on, fleet(removed))), ["lead", null]);
  });

  test("an active filter's ranked list is flat: → reaches tasks only, ← leaves an agent be", () => {
    const ids = ["work", "lead", "top"];
    let s = reduce(withFleet(tree()), { t: "select", id: "lead" });
    s = reduce(s, { t: "move", delta: -1, ids });
    assert.equal(s.selectedId, "work", "the ranked rows, agents among them");
    s = reduce(s, { t: "childExit", ids });
    assert.deepEqual(cursor(s), ["work", null]);
    s = reduce(s, { t: "select", id: "lead" });
    s = reduce(s, { t: "childEnter", ids });
    s = reduce(s, { t: "childMove", delta: 5, ids });
    assert.deepEqual(cursor(s), ["lead", "bg:t2"]);
  });
});
