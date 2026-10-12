/**
 * The queue machine's transition (`queue-machine.ts`): one case per row of
 * docs/message-queue.md "Holds" (H1–H7), the hand-over, stop attribution and
 * a supervisor's reports — and the races the review rounds fixed one by one,
 * each as the sequence of events that produced it.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  holdTicket,
  initialMachine,
  messageWaits,
  step,
  type Hold,
  type QueueEffect,
  type QueueEvent,
  type QueueMachine,
  type RunView,
  type Sender,
  type World,
} from "@loom/daemon/daemon/queue-machine";
import type { QueueSlot } from "@loom/daemon/store/message-queue";
import {
  stateError,
  stateIdle,
  stateInterrupted,
  stateRunning,
  stateAwaitingInput,
} from "@loom/core/session-state";

const FREE: Hold = { kind: "free" };
const USER: Hold = { kind: "user", reason: "interrupt" };
const SUPERVISOR: Hold = { kind: "supervisor" };
const CRASH: Hold = { kind: "loom", reason: "crash" };

interface SlotParams {
  readonly state?: QueueSlot["state"];
  readonly delivery?: QueueSlot["delivery"];
  readonly uncertain?: boolean;
  readonly author?: string;
}

const mkSlot = (id: string, p: SlotParams = {}): QueueSlot => ({
  id,
  state: p.state ?? "queued",
  delivery: p.delivery ?? "next_boundary",
  uncertain: p.uncertain ?? false,
  author: p.author ?? "client-a",
});

const IDLE_RUN: RunView = {
  attached: true,
  state: stateIdle,
  restructuring: false,
  cancelling: false,
  rootTool: null,
  inputReceipts: true,
  lifecycle: false,
};

const mkWorld = (slots: readonly QueueSlot[] = [], run: Partial<RunView> = {}): World => ({
  slots,
  run: { ...IDLE_RUN, ...run },
});

const mkMachine = (p: Partial<QueueMachine> = {}): QueueMachine => ({
  ...initialMachine(FREE),
  ...p,
});

/** Step through `events` in one world; the last step's effects, and every effect. */
const run = (m: QueueMachine, events: readonly QueueEvent[], world: World = mkWorld()) =>
  events.reduce(
    (acc, ev) => {
      const r = step(acc.machine, ev, world);
      return { machine: r.machine, effects: r.effects, all: [...acc.all, ...r.effects] };
    },
    { machine: m, effects: [] as readonly QueueEffect[], all: [] as readonly QueueEffect[] },
  );

const kinds = (effects: readonly QueueEffect[]) => effects.map((e) => e.kind);
const has = (effects: readonly QueueEffect[], kind: QueueEffect["kind"]) =>
  effects.some((e) => e.kind === kind);

const userStop = (scope: "turn" | "session" | "compaction" = "turn"): QueueEvent => ({
  kind: "stop",
  by: "user",
  scope,
  interrupt: scope === "turn",
});
const supervisorStop: QueueEvent = {
  kind: "stop",
  by: "supervisor",
  scope: "turn",
  interrupt: true,
};
const message = (entryId: string, sender: Sender, created = true): QueueEvent => ({
  kind: "message",
  entryId,
  sender,
  created,
  state: "queued",
});

describe("H1 combine", () => {
  test("the user's stop holds even an empty queue", () => {
    // when
    const { machine } = run(mkMachine(), [userStop()]);
    // then
    assert.deepEqual(machine.hold, USER);
  });

  test("a supervisor's stop holds only while entries wait", () => {
    assert.deepEqual(run(mkMachine(), [supervisorStop]).machine.hold, FREE);
    assert.deepEqual(
      run(mkMachine(), [supervisorStop], mkWorld([mkSlot("a")])).machine.hold,
      SUPERVISOR,
    );
  });

  test("the user's stop takes over a hold already set, keeping its reason", () => {
    assert.deepEqual(run(mkMachine({ hold: SUPERVISOR }), [userStop()]).machine.hold, USER);
    assert.deepEqual(run(mkMachine({ hold: CRASH }), [userStop()]).machine.hold, {
      kind: "user",
      reason: "crash",
    });
  });

  test("nothing but the user's stop changes a hold already set", () => {
    // given
    const held = [USER, SUPERVISOR, CRASH];
    const later: QueueEvent[] = [
      supervisorStop,
      { kind: "crashed" },
      { kind: "restart_recovered" },
    ];
    const world = mkWorld([mkSlot("a", { state: "delivering" })]);
    for (const hold of held)
      for (const ev of later) {
        // when
        const { machine } = run(mkMachine({ hold }), [ev], world);
        // then
        assert.deepEqual(machine.hold, hold, `${ev.kind} on ${hold.kind}`);
      }
  });

  test("a doubtful hand-over on the user's hold leaves it the user's", () => {
    // given: send now through the user's hold
    const world = mkWorld([mkSlot("m1")]);
    const sending = run(mkMachine({ hold: USER }), [{ kind: "send_now", entryId: "m1" }], world);
    const op = sending.machine.ops;
    // when
    const { machine, all } = run(
      sending.machine,
      [
        { kind: "gate_reached", op },
        { kind: "sent", op, entryId: "m1", outcome: { kind: "uncertain", message: "gone" } },
      ],
      world,
    );
    // then
    assert.deepEqual(machine.hold, USER, "not `rejected`");
    assert.ok(all.some((e) => e.kind === "mark_uncertain" && e.ids.includes("m1")));
  });

  test("a requeued discard with no stop under way is Loom's own interrupt hold", () => {
    const world = mkWorld([mkSlot("m1", { state: "delivering" })]);
    const { machine, effects } = run(mkMachine(), [{ kind: "discarded", refs: ["m1"] }], world);
    assert.deepEqual(machine.hold, { kind: "loom", reason: "interrupt" });
    assert.deepEqual(effects[0], { kind: "requeue", ids: ["m1"] });
  });

  test("a discard reported after the user lifted its stop's hold holds nothing, and keeps the send first", () => {
    // given: a stop, then the user's send lifting its hold
    const world = mkWorld([mkSlot("go"), mkSlot("m1", { state: "delivering" })]);
    const lifted = run(mkMachine(), [userStop(), message("go", "user")], world);
    assert.equal(lifted.machine.stop.kind, "lifted");
    // when
    const { machine, effects } = run(lifted.machine, [{ kind: "discarded", refs: ["m1"] }], world);
    // then
    assert.deepEqual(machine.hold, FREE, "the lift stands");
    assert.deepEqual(machine.push, { kind: "forced", entryId: "go", now: false });
    assert.ok(has(effects, "requeue"));
  });

  test("a discard on a stop's standing hold is the stopper's; one that is not a queue entry is dropped", () => {
    const world = mkWorld([mkSlot("m1", { state: "delivering" })]);
    const held = run(mkMachine(), [supervisorStop, { kind: "release" }, supervisorStop], world);
    assert.deepEqual(held.machine.hold, SUPERVISOR);
    assert.deepEqual(
      run(held.machine, [{ kind: "discarded", refs: ["direct"] }], world).effects,
      [],
    );
  });
});

describe("H2 wait or lift", () => {
  test("who waits behind which hold", () => {
    const expected: Array<[Hold, Sender, boolean]> = [
      [FREE, "child", false],
      [USER, "user", false],
      [USER, "supervisor", true],
      [USER, "child", true],
      [SUPERVISOR, "supervisor", false],
      [SUPERVISOR, "child", true],
      [CRASH, "supervisor", false],
      [CRASH, "child", true],
    ];
    for (const [hold, sender, waits] of expected)
      assert.equal(messageWaits(hold, sender), waits, `${sender} behind ${hold.kind}`);
  });

  test("a message that lifts clears the hold and goes first, alone", () => {
    const { machine, effects } = run(mkMachine({ hold: CRASH }), [message("m", "supervisor")]);
    assert.deepEqual(machine.hold, FREE);
    assert.deepEqual(machine.push, { kind: "forced", entryId: "m", now: false });
    assert.ok(effects.some((e) => e.kind === "persist_hold" && e.hold.kind === "free"));
  });

  test("a child's report to a held cold supervisor waits and revives nothing", () => {
    const cold = mkWorld([mkSlot("r")], { attached: false });
    const { machine, effects } = run(mkMachine({ hold: USER }), [message("r", "child")], cold);
    assert.deepEqual(machine.hold, USER);
    assert.equal(machine.push.kind, "none");
    assert.equal(has(effects, "revive"), false);
  });

  test("only a cold session is revived for a message; a live one is not, and a message never dispatches", () => {
    const live = run(mkMachine(), [message("m", "user")], mkWorld([mkSlot("m")]));
    assert.deepEqual(kinds(live.effects), ["publish"]);
    const cold = run(
      mkMachine(),
      [message("m", "user")],
      mkWorld([mkSlot("m")], { attached: false }),
    );
    assert.ok(has(cold.effects, "revive"));
    const refreshing = run(
      mkMachine(),
      [message("m", "user")],
      mkWorld([mkSlot("m")], { lifecycle: true }),
    );
    assert.ok(has(refreshing.effects, "revive"), "a lifecycle op under way counts as cold");
  });

  test("a retried message lifts nothing but still revives a cold session", () => {
    const { machine, effects } = run(
      mkMachine({ hold: CRASH }),
      [message("m", "user", false)],
      mkWorld([mkSlot("m")], { attached: false }),
    );
    assert.deepEqual(machine.hold, CRASH);
    assert.deepEqual(kinds(effects), ["revive"]);
  });
});

describe("H3 a hold beats a forced entry not yet handed over", () => {
  test("a stop while a cold session comes back holds the message that lifted the hold", () => {
    const world = mkWorld([mkSlot("go"), mkSlot("later")], { attached: false });
    const { machine } = run(
      mkMachine({ hold: CRASH }),
      [message("go", "user"), userStop("session")],
      world,
    );
    assert.deepEqual(machine.hold, USER);
    assert.equal(machine.push.kind, "none");
  });

  test("a forced send-now entry keeps its now mark when a hold drops it", () => {
    const world = mkWorld([mkSlot("a")], { attached: false });
    const { machine } = run(
      mkMachine(),
      [{ kind: "send_now", entryId: "a" }, { kind: "crashed" }],
      world,
    );
    assert.deepEqual(machine.push, { kind: "now", entryId: "a" });
  });
});

describe("H4 send now", () => {
  test("on a held queue it goes alone through the hold and leaves it", () => {
    const world = mkWorld([mkSlot("a"), mkSlot("b")], { state: stateInterrupted("user") });
    const queued = run(mkMachine({ hold: USER }), [{ kind: "send_now", entryId: "a" }], world);
    const op = queued.machine.ops;
    const { machine, all } = run(queued.machine, [{ kind: "gate_reached", op }], world);
    assert.deepEqual(machine.hold, USER);
    assert.ok(all.some((e) => e.kind === "mark_delivering" && e.ids.join() === "a"));
  });

  test("on a live turn it is handed in marked now, only when a person wrote it", () => {
    const tool = { state: stateRunning, rootTool: "Bash" };
    for (const [author, now] of [
      ["client-a", true],
      ["supervisor:x", false],
    ] as const) {
      const world = mkWorld([mkSlot("a", { author })], tool);
      const queued = run(mkMachine(), [{ kind: "send_now", entryId: "a" }], world);
      assert.deepEqual(queued.machine.push, { kind: "now", entryId: "a" });
      const { effects } = run(
        queued.machine,
        [{ kind: "gate_reached", op: queued.machine.ops }],
        world,
      );
      assert.ok(
        effects.some((e) => e.kind === "send" && e.now === now && e.midTurn),
        author,
      );
    }
  });
});

describe("H5 a revival that fails", () => {
  test("takes the message back and puts back the hold it lifted", () => {
    // given
    const before = mkMachine({ hold: CRASH });
    const sent = run(before, [message("m", "user")]);
    const ticket = holdTicket(before, sent.machine);
    // when
    const { machine, effects } = run(
      sent.machine,
      [{ kind: "message_withdrawn", entryId: "m", ticket }],
      mkWorld([mkSlot("m")], { attached: false }),
    );
    // then
    assert.deepEqual(machine.hold, CRASH);
    assert.equal(machine.push.kind, "none");
    assert.ok(has(effects, "withdraw"));
  });

  test("a message handed over meanwhile is not taken back, and the lift stands", () => {
    const before = mkMachine({ hold: CRASH });
    const sent = run(before, [message("m", "user")]);
    const { machine, effects } = run(
      sent.machine,
      [{ kind: "message_withdrawn", entryId: "m", ticket: holdTicket(before, sent.machine) }],
      mkWorld([mkSlot("m", { state: "delivering" })]),
    );
    assert.deepEqual(machine.hold, FREE);
    assert.deepEqual(effects, []);
  });

  test("a hold written since is not undone", () => {
    const before = mkMachine({ hold: CRASH });
    const sent = run(before, [message("m", "user")]);
    const ticket = holdTicket(before, sent.machine);
    const { machine } = run(
      sent.machine,
      [userStop("session"), { kind: "message_withdrawn", entryId: "m", ticket }],
      mkWorld([mkSlot("m")], { attached: false }),
    );
    assert.deepEqual(machine.hold, USER);
  });
});

describe("H6 a stop that does not complete", () => {
  test("a failed close puts back the hold it set", () => {
    const before = mkMachine();
    const closing = run(before, [userStop()]);
    const { machine } = run(closing.machine, [
      { kind: "stop_undone", ticket: holdTicket(before, closing.machine) },
    ]);
    assert.deepEqual(machine.hold, FREE);
  });

  test("a discard put back as the adapter closes voids nothing", () => {
    // given: an archive's close holds the user's queue; the adapter drops m1 as it goes
    const world = mkWorld([mkSlot("m1", { state: "delivering" })]);
    const before = mkMachine();
    const closing = run(before, [userStop()], world);
    const ticket = holdTicket(before, closing.machine);
    // when: the worktree will not go
    const { machine } = run(
      closing.machine,
      [
        { kind: "discarded", refs: ["m1"] },
        { kind: "crashed" },
        supervisorStop,
        { kind: "stop_undone", ticket },
      ],
      world,
    );
    // then
    assert.deepEqual(machine.hold, FREE, "no user's hold left by an archive that did not happen");
  });

  test("the user's stop on the user's hold re-asserts it: an older undo is void", () => {
    const before = mkMachine({ hold: SUPERVISOR });
    const closing = run(before, [userStop()]);
    const ticket = holdTicket(before, closing.machine);
    const { machine } = run(closing.machine, [userStop(), { kind: "stop_undone", ticket }]);
    assert.deepEqual(machine.hold, USER);
  });

  test("an archive whose close lands on a supervisor's hold leaves it the supervisor's when undone", () => {
    const before = mkMachine({ hold: SUPERVISOR });
    const closing = run(before, [userStop()]);
    assert.deepEqual(closing.machine.hold, USER);
    const { machine } = run(closing.machine, [
      { kind: "stop_undone", ticket: holdTicket(before, closing.machine) },
    ]);
    assert.deepEqual(machine.hold, SUPERVISOR);
  });
});

describe("H7 busy", () => {
  test("nothing is scheduled while busy, a forced entry included; ending it looks again", () => {
    const world = mkWorld([mkSlot("a")], { state: stateInterrupted("user") });
    const busy = run(
      mkMachine({ hold: USER }),
      [
        { kind: "busy", busy: true },
        { kind: "send_now", entryId: "a" },
      ],
      world,
    );
    assert.equal(has(busy.all, "schedule_handover"), false);
    const { effects } = run(busy.machine, [{ kind: "busy", busy: false }], world);
    assert.ok(has(effects, "schedule_handover"));
  });
});

describe("hand-over", () => {
  const world = mkWorld([mkSlot("a"), mkSlot("b")]);
  const scheduled = run(mkMachine(), [{ kind: "touched" }], world);
  const op = scheduled.machine.ops;

  test("the turn ended: every next-boundary entry goes as one fresh turn, recorded first", () => {
    const { machine, effects } = run(scheduled.machine, [{ kind: "gate_reached", op }], world);
    assert.deepEqual(kinds(effects), ["mark_delivering", "publish", "send"]);
    assert.deepEqual(effects[2], {
      kind: "send",
      op,
      entryId: "a",
      midTurn: false,
      now: false,
      human: true,
    });
    assert.equal(machine.delivery.kind, "handing_over");
  });

  test("each send that goes hands over the next; the last ends the trip", () => {
    // given
    const trip = run(scheduled.machine, [{ kind: "gate_reached", op }], world);
    const handed = mkWorld([
      mkSlot("a", { state: "delivering" }),
      mkSlot("b", { state: "delivering" }),
    ]);
    // when
    const first = run(
      trip.machine,
      [{ kind: "sent", op, entryId: "a", outcome: { kind: "ok" } }],
      handed,
    );
    const last = run(
      first.machine,
      [{ kind: "sent", op, entryId: "b", outcome: { kind: "ok" } }],
      handed,
    );
    // then
    assert.deepEqual(first.effects, [
      { kind: "send", op, entryId: "b", midTurn: true, now: false, human: true },
    ]);
    assert.equal(last.machine.delivery.kind, "ready");
    assert.deepEqual(kinds(last.effects), ["publish"]);
  });

  test("a send says whether a person wrote it: not a supervisor's message nor a child's report", () => {
    for (const [author, human] of [
      ["client-a", true],
      ["supervisor:x", false],
      ["agent:child", false],
    ] as const) {
      const world = mkWorld([mkSlot("a", { author })]);
      const s = run(mkMachine(), [{ kind: "touched" }], world);
      const { effects } = run(s.machine, [{ kind: "gate_reached", op: s.machine.ops }], world);
      assert.ok(
        effects.some((e) => e.kind === "send" && e.human === human),
        author,
      );
    }
  });

  test("without receipts an entry is consumed as it is handed over", () => {
    const noReceipts = mkWorld([mkSlot("a")], { inputReceipts: false });
    const s = run(mkMachine(), [{ kind: "touched" }], noReceipts);
    const { effects } = run(
      s.machine,
      [
        { kind: "gate_reached", op: s.machine.ops },
        { kind: "sent", op: s.machine.ops, entryId: "a", outcome: { kind: "ok" } },
      ],
      noReceipts,
    );
    assert.deepEqual(effects[0], { kind: "consume", entryId: "a", midTurn: false });
  });

  test("a refusal requeues the rest and backs off until the run moves or the user acts", () => {
    const refused = run(
      scheduled.machine,
      [
        { kind: "gate_reached", op },
        { kind: "sent", op, entryId: "a", outcome: { kind: "refused", message: "no" } },
      ],
      world,
    );
    assert.deepEqual(refused.effects[0], { kind: "requeue", ids: ["a", "b"] });
    assert.ok(
      refused.effects.some((e) => e.kind === "warn"),
      "a refused turn start is said",
    );
    assert.equal(refused.machine.delivery.kind, "backoff");
    assert.equal(
      has(run(refused.machine, [{ kind: "run_moved" }], world).effects, "schedule_handover"),
      false,
    );
    const moved = run(
      refused.machine,
      [{ kind: "status_moved", from: stateIdle, to: stateIdle }],
      world,
    );
    assert.ok(has(moved.effects, "schedule_handover"));
    assert.ok(has(run(refused.machine, [{ kind: "touched" }], world).effects, "schedule_handover"));
  });

  test("a refused fold is not said", () => {
    const live = mkWorld([mkSlot("a")], { state: stateRunning, rootTool: "Bash" });
    const s = run(mkMachine(), [{ kind: "run_moved" }], live);
    const { effects } = run(
      s.machine,
      [
        { kind: "gate_reached", op: s.machine.ops },
        {
          kind: "sent",
          op: s.machine.ops,
          entryId: "a",
          outcome: { kind: "refused", message: "ended" },
        },
      ],
      live,
    );
    assert.equal(has(effects, "warn"), false);
  });

  test("an uncertain hand-over holds the queue as Loom's own and says so", () => {
    const { machine, effects } = run(
      scheduled.machine,
      [
        { kind: "gate_reached", op },
        {
          kind: "sent",
          op,
          entryId: "a",
          outcome: { kind: "uncertain", message: "frame timeout" },
        },
      ],
      world,
    );
    assert.deepEqual(machine.hold, { kind: "loom", reason: "rejected" });
    assert.deepEqual(effects.slice(0, 2), [
      { kind: "mark_uncertain", ids: ["a"] },
      { kind: "requeue", ids: ["b"] },
    ]);
    assert.ok(has(effects, "warn"));
  });

  test("a forced entry stays forced until it has gone", () => {
    const held = mkWorld([mkSlot("a"), mkSlot("b")], { state: stateInterrupted("user") });
    const s = run(mkMachine({ hold: USER }), [{ kind: "send_now", entryId: "a" }], held);
    const o = s.machine.ops;
    const refused = run(
      s.machine,
      [
        { kind: "gate_reached", op: o },
        { kind: "sent", op: o, entryId: "a", outcome: { kind: "refused", message: "no" } },
      ],
      held,
    );
    assert.equal(refused.machine.push.kind, "forced");
    const went = run(
      s.machine,
      [
        { kind: "gate_reached", op: o },
        { kind: "sent", op: o, entryId: "a", outcome: { kind: "ok" } },
      ],
      held,
    );
    assert.equal(went.machine.push.kind, "none");
  });

  test("a new adapter attached mid-trip settles the old trip's entries, whose late events change nothing", () => {
    // given: "a" is on the wire to the old adapter, "b" not yet sent
    const trip = run(scheduled.machine, [{ kind: "gate_reached", op }], world);
    const handed = mkWorld([
      mkSlot("a", { state: "delivering" }),
      mkSlot("b", { state: "delivering" }),
    ]);
    // when
    const attached = run(trip.machine, [{ kind: "attached" }], handed);
    const late = run(
      attached.machine,
      [
        { kind: "sent", op, entryId: "a", outcome: { kind: "ok" } },
        { kind: "handover_ended", op },
      ],
      handed,
    );
    // then
    assert.deepEqual(attached.effects.slice(0, 2), [
      { kind: "mark_uncertain", ids: ["a"] },
      { kind: "requeue", ids: ["b"] },
    ]);
    assert.ok(has(attached.effects, "warn"));
    assert.deepEqual(attached.machine.hold, { kind: "loom", reason: "rejected" });
    assert.equal(attached.machine.delivery.kind, "ready");
    assert.equal(has(late.all, "send"), false);
    assert.equal(has(late.all, "consume"), false);
  });

  test("an adapter attached with no trip under way changes no entry", () => {
    const { machine, effects } = run(scheduled.machine, [{ kind: "attached" }], world);
    assert.deepEqual(effects, []);
    assert.deepEqual(machine.hold, FREE);
  });

  test("a send that found no adapter puts it and the rest back", () => {
    const trip = run(scheduled.machine, [{ kind: "gate_reached", op }], world);
    const { machine, effects } = run(
      trip.machine,
      [{ kind: "sent", op, entryId: "a", outcome: { kind: "detached" } }],
      mkWorld([mkSlot("a", { state: "delivering" }), mkSlot("b", { state: "delivering" })], {
        attached: false,
      }),
    );
    assert.deepEqual(effects[0], { kind: "requeue", ids: ["a", "b"] });
    assert.equal(machine.delivery.kind, "ready");
  });

  test("a stale trip's end does not reset the next one", () => {
    const next = run(scheduled.machine, [{ kind: "handover_ended", op }], world);
    assert.equal(
      next.machine.delivery.kind,
      "scheduled",
      "it looked again and scheduled a new trip",
    );
    const newer = next.machine.ops;
    assert.notEqual(newer, op);
    const { machine } = run(next.machine, [{ kind: "handover_ended", op }], world);
    assert.deepEqual(machine.delivery, { kind: "scheduled", op: newer });
  });

  test("nothing while a request waits, while held, or while the model only writes", () => {
    const waiting = mkWorld([mkSlot("a")], { state: stateAwaitingInput("permission") });
    assert.equal(
      has(run(mkMachine(), [{ kind: "touched" }], waiting).effects, "schedule_handover"),
      false,
    );
    assert.equal(
      has(
        run(mkMachine({ hold: USER }), [{ kind: "touched" }], world).effects,
        "schedule_handover",
      ),
      false,
    );
    const writing = mkWorld([mkSlot("a")], { state: stateRunning });
    assert.equal(
      has(run(mkMachine(), [{ kind: "touched" }], writing).effects, "schedule_handover"),
      false,
    );
  });
});

describe("stop attribution", () => {
  test("the user wins over a supervisor that asked too", () => {
    const { machine } = run(mkMachine(), [userStop(), supervisorStop]);
    assert.deepEqual(machine.stop, { kind: "holding", by: "user" });
  });

  test("a turn start clears who stopped the last, and so does a hand-over", () => {
    const stopped = run(mkMachine(), [supervisorStop]);
    const started = run(stopped.machine, [
      { kind: "status_moved", from: stateInterrupted("supervisor"), to: stateRunning },
    ]);
    assert.deepEqual(started.machine.stop, { kind: "holding", by: null });
    assert.deepEqual(run(stopped.machine, [{ kind: "direct_send" }]).machine.stop, {
      kind: "holding",
      by: null,
    });
  });

  test("stopping a compaction on a settled session stops no turn and holds only what waits", () => {
    const { machine } = run(mkMachine(), [userStop("compaction")]);
    assert.deepEqual(machine.hold, FREE);
    assert.deepEqual(machine.stop, { kind: "holding", by: null });
    const waiting = run(mkMachine(), [userStop("compaction")], mkWorld([mkSlot("a")]));
    assert.deepEqual(waiting.machine.hold, USER, "the hold is the stopper's");
  });

  test("an interrupt clears what was pushed ahead", () => {
    const world = mkWorld([mkSlot("a")], { state: stateRunning, rootTool: "Bash" });
    const { machine } = run(mkMachine(), [{ kind: "send_now", entryId: "a" }, userStop()], world);
    assert.equal(machine.push.kind, "none");
  });

  test("a new run starts with no stops", () => {
    const { machine } = run(mkMachine(), [userStop(), { kind: "attached" }]);
    assert.deepEqual(machine.stop, { kind: "none" });
  });
});

describe("crash, restart, interrupt", () => {
  test("a crash with entries waiting marks the handed ones uncertain and holds", () => {
    const world = mkWorld([mkSlot("a", { state: "delivering" }), mkSlot("b")]);
    const { machine, effects } = run(mkMachine(), [{ kind: "crashed" }], world);
    assert.deepEqual(machine.hold, CRASH);
    assert.deepEqual(effects[0], { kind: "mark_uncertain", ids: ["a"] });
  });

  test("a crash with nothing queued holds nothing", () => {
    assert.deepEqual(run(mkMachine(), [{ kind: "crashed" }]).machine.hold, FREE);
  });

  test("a restart with entries left delivering holds as restart", () => {
    const world = mkWorld([mkSlot("a", { state: "delivering" })], { attached: false });
    assert.deepEqual(run(mkMachine(), [{ kind: "restart_recovered" }], world).machine.hold, {
      kind: "loom",
      reason: "restart",
    });
    assert.deepEqual(
      run(mkMachine(), [{ kind: "restart_recovered" }], mkWorld([mkSlot("q")])).machine.hold,
      FREE,
    );
  });

  test("a confirmed stop leaves handed entries uncertain, with receipts only", () => {
    const world = mkWorld([mkSlot("a", { state: "delivering" })]);
    assert.deepEqual(run(mkMachine(), [{ kind: "interrupt_stopped" }], world).effects, [
      { kind: "mark_uncertain", ids: ["a"] },
    ]);
    const noReceipts = mkWorld([mkSlot("a", { state: "delivering" })], { inputReceipts: false });
    assert.deepEqual(run(mkMachine(), [{ kind: "interrupt_stopped" }], noReceipts).effects, []);
  });
});

describe("supervision", () => {
  const settle = (
    turn: number,
    state = stateIdle,
    cause: "user" | "supervisor" | null = null,
  ): QueueEvent => ({
    kind: "turn_settled",
    turn,
    state,
    cause,
    supervisor: "live",
  });
  const written = (state = stateIdle): QueueEvent => ({ kind: "status_written", state });

  test("each state spell is a turn; the same state written again is not", () => {
    const { machine } = run(mkMachine(), [
      written(stateRunning),
      written(stateIdle),
      written(stateIdle),
    ]);
    assert.deepEqual(machine.spell, { kind: "in", state: stateIdle, turn: 2 });
  });

  test("a settled turn is reported once", () => {
    const first = run(mkMachine(), [written(), settle(1)]);
    assert.deepEqual(first.effects, [{ kind: "make_report", turn: 1, state: stateIdle }]);
    assert.deepEqual(run(first.machine, [settle(1)]).effects, []);
    const sent = run(first.machine, [{ kind: "report_ready", turn: 1 }, settle(1)]);
    assert.deepEqual(sent.all, [{ kind: "send_report", turn: 1 }]);
  });

  test("a second failure is a second report", () => {
    const { all } = run(mkMachine(), [
      written(stateError("one")),
      settle(1, stateError("one")),
      { kind: "report_ready", turn: 1 },
      written(stateError("two")),
      settle(2, stateError("two")),
    ]);
    assert.equal(all.filter((e) => e.kind === "make_report").length, 2);
  });

  test("a turn it has moved on from is not reported, even while its facts were read", () => {
    const { all } = run(mkMachine(), [
      written(),
      settle(1),
      written(stateRunning),
      { kind: "report_ready", turn: 1 },
    ]);
    assert.equal(has(all, "send_report"), false);
    assert.deepEqual(run(mkMachine(), [written(), written(stateRunning), settle(1)]).all, []);
  });

  test("a later turn's report takes over one still being made", () => {
    const { machine, all } = run(mkMachine(), [
      written(),
      settle(1),
      written(stateRunning),
      written(),
      settle(3),
      { kind: "report_ready", turn: 1 },
    ]);
    assert.deepEqual(machine.report, { kind: "making", turn: 3 });
    assert.equal(has(all, "send_report"), false);
  });

  test("not of a stop the supervisor made, or a failure that stop ended in", () => {
    const interrupted = stateInterrupted("supervisor");
    assert.deepEqual(run(mkMachine(), [written(interrupted), settle(1, interrupted)]).all, []);
    const failed = stateError("broke");
    assert.deepEqual(run(mkMachine(), [written(failed), settle(1, failed, "supervisor")]).all, []);
    const user = stateInterrupted("user");
    assert.ok(
      has(run(mkMachine(), [written(user), settle(1, user)]).all, "make_report"),
      "the user's stop is reported",
    );
  });

  test("not of a wait, nor to a supervisor gone or archived", () => {
    const waiting = stateAwaitingInput("question");
    assert.deepEqual(run(mkMachine(), [written(waiting), settle(1, waiting)]).all, []);
    const gone: QueueEvent = {
      kind: "turn_settled",
      turn: 1,
      state: stateIdle,
      cause: null,
      supervisor: "gone",
    };
    assert.deepEqual(run(mkMachine(), [written(), gone]).all, []);
  });
});
