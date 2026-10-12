/**
 * Loom agents in the FLEET (docs/loom-agents.md): the status a supervisor
 * shows while its agents work or wait on the person (`fleet-status.ts`), the
 * mark and Detail line naming those that wait, and the cursor's walk of
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
import { stripVTControlCharacters } from "node:util";
import { createElement } from "react";
import { renderToString } from "ink";
import { shownStatus, shownStatusIn, waitingAgentsIn } from "@loom/tui/fleet-status";
import { agentsWaitingLine, detailLayout, Fleet, showAgentsWaiting } from "@loom/tui/components";
import { fleetPaneView } from "@loom/tui/views";
import {
  fleetEntries,
  fleetHits,
  fleetLayout,
  fleetSessions,
  focusedChildOf,
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

  test("an agent asking raises every live state into needs-input", () => {
    for (const kind of ["running", "starting", "working_background", "idle"] as const)
      assert.equal(shownStatus(kind, "agents_asking"), "awaiting_input", kind);
  });

  test("its own question, error or stop, or its archive, outranks an agent asking", () => {
    for (const kind of ["awaiting_input", "error", "interrupted", "done"] as const)
      assert.equal(shownStatus(kind, "agents_asking"), kind, kind);
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

  test("an agent's error, stop or rest does not reach its supervisor", () => {
    for (const kind of ["error", "interrupted", "idle", "done"] as const) {
      const list = [lead("idle"), agent("a", kind)];
      assert.equal(shownStatusIn(list)(list[0]!), "idle", kind);
    }
    const failing = [lead("idle"), agent("a", "error"), agent("b", "interrupted")];
    assert.equal(shownStatusIn(failing)(failing[0]!), "idle");
  });

  test("an agent's question reaches its supervisor over another's work or failure", () => {
    const mixed = [
      lead("idle"),
      agent("a", "error"),
      agent("b", "running"),
      agent("c", "awaiting_input"),
    ];
    assert.equal(shownStatusIn(mixed)(mixed[0]!), "awaiting_input");
    const busy = [lead("running"), agent("a", "awaiting_input")];
    assert.equal(shownStatusIn(busy)(busy[0]!), "awaiting_input", "even over its own turn");
    for (const kind of ["error", "interrupted", "awaiting_input"] as const) {
      const own = [lead(kind), agent("a", "awaiting_input")];
      assert.equal(shownStatusIn(own)(own[0]!), kind, `its own ${kind} shows as itself`);
    }
  });

  test("a question however deep reaches every supervisor above it, past their own work", () => {
    const list = [
      lead("idle"),
      agent("mid", "running"),
      agent("leaf", "awaiting_input", "mid"),
      agent("side", "error"),
    ];
    const shown = shownStatusIn(list);
    assert.deepEqual(
      list.map((s) => shown(s)),
      ["awaiting_input", "awaiting_input", "awaiting_input", "error"],
    );
    const failed = [lead("idle"), agent("mid", "error"), agent("leaf", "awaiting_input", "mid")];
    assert.equal(shownStatusIn(failed)(failed[0]!), "awaiting_input", "past a failed agent too");
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

describe("waitingAgentsIn", () => {
  const agent = (id: string, status: SessionStateKind, supervisorId = "lead") =>
    snap({ id, status, supervisorId });

  test("every agent below waiting on the person, by its own state, however deep", () => {
    const list = [
      snap({ id: "lead", status: "awaiting_input" }),
      agent("a", "awaiting_input"),
      agent("b", "running"),
      agent("c", "awaiting_input", "b"),
      agent("d", "awaiting_input", "c"),
      agent("e", "error"),
      snap({ id: "other", status: "awaiting_input" }),
    ];
    const waiting = waitingAgentsIn(list);
    assert.deepEqual(
      waiting(list[0]!).map((s) => s.id),
      ["a", "c", "d"],
      "not itself, not a stranger",
    );
    assert.deepEqual(
      waiting(list[3]!).map((s) => s.id),
      ["d"],
      "an agent's own count starts below it",
    );
  });

  test("a supervision loop ends", () => {
    const list = [agent("x", "awaiting_input", "y"), agent("y", "awaiting_input", "x")];
    assert.deepEqual(
      waitingAgentsIn(list)(list[0]!).map((s) => s.id),
      ["y"],
    );
  });
});

describe("showAgentsWaiting", () => {
  test("no mark for none, ?N otherwise", () => {
    assert.equal(showAgentsWaiting(0), "");
    assert.equal(showAgentsWaiting(1), " ?1");
    assert.equal(showAgentsWaiting(12), " ?12");
  });
});

describe("agentsWaitingLine", () => {
  const waiting = [
    snap({ id: "aaaaaaaa1111", title: "Verify the widget", status: "awaiting_input" }),
    snap({ id: "bbbbbbbb2222", title: "Port the parser", status: "awaiting_input" }),
  ];

  test("names each waiting agent and the way to it", () => {
    assert.equal(
      agentsWaitingLine(waiting, 100),
      "? 2 agents waiting on you: aaaaaaaa Verify the widget, bbbbbbbb Port the parser  → opens",
    );
    assert.match(agentsWaitingLine(waiting.slice(0, 1), 100), /^\? 1 agent waiting on you: /);
  });

  test("a narrow pane cuts the names, never the hint", () => {
    const line = agentsWaitingLine(waiting, 50);
    assert.ok([...line].length <= 50, line);
    assert.match(line, /^\? 2 agents waiting on you: aaaaa.*  → opens$/);
  });
});

/**
 *   lead     (idle)
 *   ├ mid    (running)
 *   │ └ ask  (awaiting_input)
 *   └ also   (awaiting_input)
 *   rest     (idle)
 */
const asking = (): SessionSnapshot[] => [
  snap({ id: "lead", title: "Coordinate", status: "idle", createdAt: 1 }),
  snap({ id: "mid", status: "running", supervisorId: "lead", createdAt: 2 }),
  snap({ id: "ask", title: "Verify", status: "awaiting_input", supervisorId: "mid", createdAt: 3 }),
  snap({ id: "also", title: "Port", status: "awaiting_input", supervisorId: "lead", createdAt: 4 }),
  snap({ id: "rest", status: "idle", createdAt: 5 }),
];

describe("a supervisor whose agents wait on the person", () => {
  test("joins needs-input with a ?N mark; its own state is left alone", () => {
    const s = withFleet(asking());
    const marks = fleetEntries(s).flatMap((e) =>
      e.kind === "session" ? [[e.s.id, e.status, e.agents?.waiting ?? null] as const] : [],
    );
    assert.deepEqual(marks, [
      ["lead", "awaiting_input", 2],
      ["also", "awaiting_input", null],
      ["mid", "awaiting_input", 1],
      ["ask", "awaiting_input", null],
      ["rest", "idle", null],
    ]);
    const groups = fleetEntries(s).flatMap((e) => (e.kind === "groupHeader" ? [e.group] : []));
    assert.deepEqual(
      groups.map((g) => [g.status, g.sessions.map((x) => x.id)]),
      [
        ["awaiting_input", ["lead"]],
        ["idle", ["rest"]],
      ],
    );
    const own = new Map(fleetSessions(s).map((x) => [x.id, x.status.kind]));
    assert.equal(own.get("lead"), "idle");
    assert.equal(own.get("mid"), "running");
  });

  test("its row draws the needs-input glyph and ?N; the asking agent's own row does not", () => {
    const s = withFleet(asking());
    const view = fleetPaneView(s.fleet, fleetLayout(s, 40), "rest", null, null);
    const out = stripVTControlCharacters(
      renderToString(createElement(Fleet, { view, find: null, tick: 0, width: 80, now: 0 }), {
        columns: 80,
      }),
    );
    const line = (id: string) => out.split("\n").find((l) => l.includes(` ${id} `))!;
    assert.match(line("lead"), /◆ lead\s+Coordinate\s+\?2 Σ-- │$/);
    assert.match(line("mid"), /\?1 Σ/);
    assert.doesNotMatch(line("ask"), /\?\d/);
  });

  test("its Detail names who waits; a session with none waiting has no such line", () => {
    const list = asking();
    const lead = list[0]!;
    const render = (waiting: readonly SessionSnapshot[]) =>
      stripVTControlCharacters(
        renderToString(detailLayout(lead, { width: 100, waiting }).render(0), { columns: 100 }),
      );
    const out = render(waitingAgentsIn(list)(lead));
    assert.match(out, /\? 2 agents waiting on you: ask Verify, also Port {2}→ opens/);
    assert.doesNotMatch(render([]), /waiting on you/);
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
    let s = reduce(withFleet(tree()), { t: "select", id: "lead" });
    s = reduce(s, { t: "move", delta: 1 });
    assert.equal(s.selectedId, "top", "past lead's agents");
    s = reduce(s, { t: "move", delta: -1 });
    assert.equal(s.selectedId, "lead");
    s = reduce(s, { t: "move", delta: 2 });
    assert.equal(s.selectedId, "bottom");
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
      ["lead", "ask", "work", "top", "bottom"],
      "lead is in needs-input for ask",
    );
    const inside = reduce(top, { t: "childEnter" });
    assert.deepEqual(
      rows(inside).map(([id]) => id),
      ["lead", "ask", "work", "old", "top", "bottom"],
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

const shells = (...ids: string[]) =>
  ids.map((id) => ({ id, kind: "shell" as const, title: `task ${id}` }));

/**
 *   lead      (tasks l1 l2)
 *   ├ b       (task b1)
 *   │ └ ba    (task z1)
 *   └ a       (tasks a1 a2)
 *     ├ ab    (six tasks: four drawn, "+2 more")
 *     └ aa    (task x1)
 */
const tasked = (): SessionSnapshot[] => [
  snap({
    id: "lead",
    status: "idle",
    createdAt: 1,
    backgroundTasks: shells("l1", "l2"),
  }),
  snap({
    id: "a",
    status: "running",
    supervisorId: "lead",
    createdAt: 2,
    backgroundTasks: shells("a1", "a2"),
  }),
  snap({
    id: "aa",
    status: "running",
    supervisorId: "a",
    createdAt: 3,
    backgroundTasks: shells("x1"),
  }),
  snap({
    id: "ab",
    status: "running",
    supervisorId: "a",
    createdAt: 4,
    backgroundTasks: shells("y1", "y2", "y3", "y4", "y5", "y6"),
  }),
  snap({
    id: "b",
    status: "running",
    supervisorId: "lead",
    createdAt: 5,
    backgroundTasks: shells("b1"),
  }),
  snap({
    id: "ba",
    status: "running",
    supervisorId: "b",
    createdAt: 6,
    backgroundTasks: shells("z1"),
  }),
];

/** The FLEET pane for `s`, its entry rows cut to their tree, glyphs and
 *  id/label (titles and costs dropped), and the click hits for the same frame. */
const drawn = (s: TuiState) => {
  const layout = fleetLayout(s, 40);
  const view = fleetPaneView(s.fleet, layout, s.selectedId, focusedChildOf(s), null);
  const lines = stripVTControlCharacters(
    renderToString(createElement(Fleet, { view, find: null, tick: 0, width: 60, now: 0 }), {
      columns: 60,
    }),
  ).split("\n");
  const cut = (line: string) => line.slice(2).replace(/(?<=[^\s▍│├└])\s{2,}.*$/, "");
  const hits = fleetHits(
    s,
    {
      originX: 1,
      listW: 60,
      originY: 1,
      maxY: lines.length,
    },
    layout,
  );
  return {
    rows: lines.slice(4, -1).map(cut),
    line: (y: number) => cut(lines[y - 1]!),
    hits,
  };
};

describe("a nested agent's task rows", () => {
  test("a top-level session's tasks hang one level under it", () => {
    const s = withFleet([
      snap({ id: "solo", status: "idle", backgroundTasks: shells("s1", "s2") }),
    ]);
    assert.deepEqual(drawn(s).rows, ["▍ ○ solo", "  ├ ⠋ $ task s1", "  └ ⠋ $ task s2"]);
  });

  test("hang one level under their agent, at any depth, with │ past a non-last branch", () => {
    const s = reduce(withFleet(tasked()), { t: "select", id: "lead" });
    assert.deepEqual(drawn(s).rows, [
      "▍ ◐ lead",
      "  ├ ⠋ $ task l1",
      "  ├ ⠋ $ task l2",
      "  ├ ⠋ b",
      "  │ ├ ⠋ $ task b1",
      "  │ └ ⠋ ba",
      "  │   └ ⠋ $ task z1",
      "  └ ⠋ a",
      "    ├ ⠋ $ task a1",
      "    ├ ⠋ $ task a2",
      "    ├ ⠋ ab",
      "    │ ├ ⠋ $ task y1",
      "    │ ├ ⠋ $ task y2",
      "    │ ├ ⠋ $ task y3",
      "    │ ├ ⠋ $ task y4",
      "    │ └ +2 more",
      "    └ ⠋ aa",
      "      └ ⠋ $ task x1",
    ]);
  });

  test("the cursor and click targets sit on the rows drawn", () => {
    const onRows = (s: TuiState) => {
      const { rows, line, hits } = drawn(s);
      assert.equal(hits.length, rows.length, "one click target per entry row");
      for (const h of hits) {
        if (h.kind === "session") {
          assert.match(line(h.y), new RegExp(`[├└◐] (⠋ )?${h.id}$`));
        } else if (h.kind === "child") {
          assert.match(line(h.y), new RegExp(`task ${h.key.slice(3)}$`));
        } else if (h.kind === "childMore") {
          assert.match(line(h.y), /│ └ \+2 more$/);
        }
      }
      return { line, hits };
    };
    const capped = onRows(reduce(withFleet(tasked()), { t: "select", id: "lead" }));
    assert.ok(capped.hits.some((h) => h.kind === "childMore" && h.sessionId === "ab"));

    let s = reduce(withFleet(tasked()), { t: "select", id: "ab" });
    s = reduce(s, { t: "childEnter" });
    assert.deepEqual(cursor(s), ["ab", "bg:y1"]);
    const { line, hits } = onRows(s);
    const focused = hits.find((h) => h.kind === "child" && h.key === "bg:y1")!;
    assert.match(line(focused.y), /^▍ {3}│ ├ ⠋ \$ task y1$/);
    assert.ok(!hits.some((h) => h.kind === "childMore"), "entered: its tasks are uncapped");
  });
});
