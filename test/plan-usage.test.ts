/**
 * On-demand plan-window refresh: when a stale window triggers a refresh, the
 * per-account throttle, in-flight dedupe and failure backoff, and which source
 * (a live session or a probe) answers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanWindow } from "@loom/core/events";
import { openDb } from "@loom/daemon/store/db";
import { SessionStore } from "@loom/daemon/store/sessions";
import {
  PLAN_USAGE_MAX_GAP_MS,
  PLAN_USAGE_MIN_GAP_MS,
  type PlanUsageOutcome,
  PlanUsageRefresher,
  type PlanUsageRoute,
  refreshPlanUsage,
} from "../backend/daemon/src/daemon/plan-usage.ts";

const MIN = 60_000;

/** A refresher on a fake clock whose refreshes the test settles by hand. */
const harness = () => {
  let now = 1_000_000;
  const calls: Array<{
    scope: string;
    provider: string;
    settle: (outcome: PlanUsageOutcome | Error) => void;
  }> = [];
  const refresher = new PlanUsageRefresher({
    now: () => now,
    refresh: (scope, provider) =>
      new Promise((resolve, reject) =>
        calls.push({
          scope,
          provider,
          settle: (o) => (o instanceof Error ? reject(o) : resolve(o)),
        }),
      ),
  });
  return {
    refresher,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
    /** Let a settled refresh run its bookkeeping. */
    flush: () => new Promise<void>((r) => setTimeout(r, 0)),
  };
};

test("stale windows start exactly one refresh however often snapshots are built", async () => {
  const h = harness();
  try {
    for (let i = 0; i < 50; i++) h.refresher.observe("acct", "claude", true);
    assert.equal(h.calls.length, 1);
    assert.deepEqual([h.calls[0]!.scope, h.calls[0]!.provider], ["acct", "claude"]);
    assert.ok(h.refresher.running("acct"));
    // Settled, and the windows came back fresh.
    h.calls[0]!.settle({ via: "live" });
    await h.flush();
    h.refresher.observe("acct", "claude", false);
    for (let i = 0; i < 50; i++) h.refresher.observe("acct", "claude", false);
    assert.equal(h.calls.length, 1);
  } finally {
    await h.refresher.close();
  }
});

test("fresh windows never refresh", async () => {
  const h = harness();
  try {
    for (let i = 0; i < 10; i++) {
      h.refresher.observe("acct", "claude", false);
      h.advance(10 * MIN);
    }
    assert.equal(h.calls.length, 0);
  } finally {
    await h.refresher.close();
  }
});

test("one account's refresh is throttled; another account refreshes independently", async () => {
  const h = harness();
  try {
    h.refresher.observe("a", "claude", true);
    h.refresher.observe("b", "codex", true);
    assert.deepEqual(
      h.calls.map((c) => c.scope),
      ["a", "b"],
    );
    h.calls[0]!.settle({ via: "probe", windows: 2 });
    await h.flush();
    // Fresh again: the backoff clears, but the gap since the last start holds.
    h.refresher.observe("a", "claude", false);
    h.advance(PLAN_USAGE_MIN_GAP_MS - 1);
    h.refresher.observe("a", "claude", true);
    assert.equal(h.calls.length, 2);
    h.advance(1);
    h.refresher.observe("a", "claude", true);
    assert.equal(h.calls.length, 3);
  } finally {
    h.calls[1]!.settle({ via: "live" });
    h.calls[2]!.settle({ via: "live" });
    await h.refresher.close();
  }
});

test("failures back off, doubling up to the ceiling, and a fresh reading resets them", async () => {
  const h = harness();
  try {
    const fail = async () => {
      h.calls.at(-1)!.settle(new Error("probe failed"));
      await h.flush();
    };
    h.refresher.observe("acct", "claude", true);
    await fail();
    const gaps: number[] = [];
    let at = 0;
    for (let round = 0; round < 7; round++) {
      const before = h.calls.length;
      while (h.calls.length === before) {
        h.advance(MIN);
        at += MIN;
        h.refresher.observe("acct", "claude", true);
      }
      gaps.push(at / MIN);
      at = 0;
      await fail();
    }
    assert.deepEqual(gaps, [4, 8, 16, 32, 60, 60, 60]);
    assert.equal(PLAN_USAGE_MAX_GAP_MS, 60 * MIN);
    // The account recovers through another route; the next expiry is prompt again.
    h.refresher.observe("acct", "claude", false);
    h.advance(PLAN_USAGE_MIN_GAP_MS);
    const before = h.calls.length;
    h.refresher.observe("acct", "claude", true);
    assert.equal(h.calls.length, before + 1);
    h.calls.at(-1)!.settle({ via: "live" });
  } finally {
    await h.refresher.close();
  }
});

test("a refresh that leaves the windows stale counts as a failure", async () => {
  const h = harness();
  try {
    h.refresher.observe("acct", "claude", true);
    h.calls[0]!.settle({ via: "live" });
    await h.flush();
    // Two minutes on, still stale: the live poll did not help, so wait longer.
    h.advance(PLAN_USAGE_MIN_GAP_MS);
    h.refresher.observe("acct", "claude", true);
    assert.equal(h.calls.length, 1);
    h.advance(PLAN_USAGE_MIN_GAP_MS);
    h.refresher.observe("acct", "claude", true);
    assert.equal(h.calls.length, 2);
    h.calls[1]!.settle({ via: "live" });
  } finally {
    await h.refresher.close();
  }
});

test("a probe that finds no plan checks back only at the ceiling", async () => {
  const h = harness();
  try {
    h.refresher.observe("acct", "claude", true);
    h.calls[0]!.settle({ via: "probe", windows: 0 });
    await h.flush();
    h.advance(PLAN_USAGE_MAX_GAP_MS - 1);
    h.refresher.observe("acct", "claude", true);
    assert.equal(h.calls.length, 1);
    h.advance(1);
    h.refresher.observe("acct", "claude", true);
    assert.equal(h.calls.length, 2);
    h.calls[1]!.settle({ via: "live" });
  } finally {
    await h.refresher.close();
  }
});

test("a refresh that hangs is cut off at the ceiling and backs off", async () => {
  let calls = 0;
  const refresher = new PlanUsageRefresher({
    timeoutMs: 20,
    refresh: () => {
      calls++;
      return new Promise(() => {});
    },
  });
  try {
    refresher.observe("acct", "claude", true);
    assert.ok(refresher.running("acct"));
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(!refresher.running("acct"));
    refresher.observe("acct", "claude", true);
    assert.equal(calls, 1);
  } finally {
    await Promise.race([refresher.close(), new Promise((r) => setTimeout(r, 50))]);
  }
});

const windows: PlanWindow[] = [
  { ts: 1, status: "allowed", window: "five_hour", utilization: 10, resetsAt: 9_999_999_999_999 },
];

/** A route whose every call is recorded. */
const route = (opts: {
  live?: Record<string, boolean | Error>;
  probe?: PlanWindow[] | Error | null;
}) => {
  const log: string[] = [];
  const recorded: PlanWindow[] = [];
  const r: PlanUsageRoute = {
    live: Object.keys(opts.live ?? {}),
    refreshLive: async (id) => {
      log.push(`live:${id}`);
      const answer = opts.live![id]!;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    ...(opts.probe === null
      ? {}
      : {
          probe: async () => {
            log.push("probe");
            if (opts.probe instanceof Error) throw opts.probe;
            return opts.probe ?? [];
          },
        }),
    record: (w) => {
      recorded.push(...w);
    },
  };
  return { r, log, recorded };
};

test("a live session on the account is asked first, and no probe runs", async () => {
  const t = route({ live: { s1: true }, probe: windows });
  assert.deepEqual(await refreshPlanUsage(t.r, new AbortController().signal), { via: "live" });
  assert.deepEqual(t.log, ["live:s1"]);
  assert.deepEqual(t.recorded, []);
});

test("live sessions that can't poll fall through to the next, then to the probe", async () => {
  const t = route({ live: { s1: false, s2: new Error("worker gone") }, probe: windows });
  assert.deepEqual(await refreshPlanUsage(t.r, new AbortController().signal), {
    via: "probe",
    windows: 1,
  });
  assert.deepEqual(t.log, ["live:s1", "live:s2", "probe"]);
  assert.deepEqual(t.recorded, windows);
});

test("with no live session the probe's windows are recorded", async () => {
  const t = route({ probe: windows });
  assert.deepEqual(await refreshPlanUsage(t.r, new AbortController().signal), {
    via: "probe",
    windows: 1,
  });
  assert.deepEqual(t.recorded, windows);
  const empty = route({ probe: [] });
  assert.deepEqual(await refreshPlanUsage(empty.r, new AbortController().signal), {
    via: "probe",
    windows: 0,
  });
});

test("a failed probe, or no source at all, rejects", async () => {
  await assert.rejects(
    refreshPlanUsage(route({ probe: new Error("cli failed") }).r, new AbortController().signal),
    /cli failed/,
  );
  await assert.rejects(
    refreshPlanUsage(route({ live: { s1: false }, probe: null }).r, new AbortController().signal),
    /No live session or probe/,
  );
});

test("the store calls windows stale when missing, expired, untimed and aged, or unknown", () => {
  const db = openDb(":memory:");
  try {
    const s = new SessionStore(db);
    const at = 1_000_000;
    const read = (scope: string, w: Partial<PlanWindow> & { ts: number }) =>
      s.recordAccountUsage(scope, { status: "allowed", window: "five_hour", ...w });
    // Missing: never read.
    assert.equal(s.accountUsageStale("none", at), true);
    // Fresh: a utilization and a reset still ahead.
    read("fresh", { ts: at, utilization: 10, resetsAt: at + 60 * MIN });
    read("fresh", { ts: at, window: "seven_day", utilization: 5, resetsAt: at + 600 * MIN });
    assert.equal(s.accountUsageStale("fresh", at + MIN), false);
    // Expired: the reset passed since the reading.
    assert.equal(s.accountUsageStale("fresh", at + 61 * MIN), true);
    // Unknown: a streamed reading with no utilization.
    read("unknown", { ts: at, resetsAt: at + 60 * MIN });
    assert.equal(s.accountUsageStale("unknown", at + MIN), true);
    // Untimed: fresh for five minutes, then due again.
    read("untimed", { ts: at, utilization: 0 });
    assert.equal(s.accountUsageStale("untimed", at + MIN), false);
    assert.equal(s.accountUsageStale("untimed", at + 6 * MIN), true);
  } finally {
    db.close();
  }
});

test("a full reading of a window that has not restarted replaces the passed reset", () => {
  const db = openDb(":memory:");
  try {
    const s = new SessionStore(db);
    const at = 1_000_000;
    s.recordAccountUsage("acct", {
      ts: at,
      status: "allowed",
      window: "five_hour",
      utilization: 70,
      resetsAt: at + 60 * MIN,
    });
    // After the reset, an idle five-hour window reads 0% with no reset time.
    const later = at + 90 * MIN;
    s.recordAccountUsage("acct", {
      ts: later,
      status: "allowed",
      window: "five_hour",
      utilization: 0,
    });
    assert.deepEqual(s.accountUsage("acct", later + MIN).five_hour, {
      status: "allowed",
      utilization: 0,
      observedAt: later,
    });
    assert.equal(s.accountUsageStale("acct", later + MIN), false);
  } finally {
    db.close();
  }
});
