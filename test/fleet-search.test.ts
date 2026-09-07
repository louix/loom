import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSnapshot, SearchResult } from "@loom/core/wire";
import { initialState, reduce, fleetSessions, type TuiState } from "@loom/tui/model";
import { buffer } from "@loom/tui/editor";
import {
  fleetFilterStatus,
  mkSearchControl,
  searchMatches,
  searchStale,
  type Find,
} from "@loom/tui/fleet-search";
import { snap, fleet } from "./tui-fixtures.ts";

// ---------------------------------------------------------------------------
// fleet search (`/`) — the query's lifetime
// ---------------------------------------------------------------------------
//
// Matching and ranking are the daemon's now, and tested against a real
// database in `session-search.test.ts`. What is left here is what the TUI
// still owns: one search per settled query, results that can't outlive the
// query that asked for them, and the fleet as the only source of sessions.

/** A complete ranked search response. */
const result = (query: string, ids: string[]): SearchResult => ({ query, ids });

/** Direct feature inputs, with UI selection coordinated as in the app. */
const mkSearch = (sessions: SessionSnapshot[], opts: { debounceMs?: number } = {}) => {
  let s = reduce(initialState(), fleet(sessions));
  let live = true;
  const calls: Array<{
    query: string;
    ok: (p: SearchResult) => void;
    fail: (e: unknown) => void;
  }> = [];
  const ctl = mkSearchControl({
    search: (query) => new Promise<SearchResult>((ok, fail) => calls.push({ query, ok, fail })),
    connected: () => live,
    debounceMs: opts.debounceMs ?? 5,
  });
  ctl.open();
  ctl.subscribe(() => {
    const find = ctl.get();
    const matches = searchMatches(find, fleetSessions(s));
    if (
      find?.results.tag === "data" &&
      matches.length &&
      !matches.some((x) => x.id === s.selectedId)
    )
      s = reduce(s, { t: "select", id: matches[0]!.id });
  });
  const after = <T>(x: T): T => {
    ctl.settle();
    return x;
  };
  return {
    ctl,
    calls,
    /** Every query the handle has actually sent, in order. */
    sent: (): string[] => calls.map((c) => c.query),
    type: (text: string): void => {
      ctl.setBuffer(buffer(text));
      after(null);
    },
    select: (id: string): void => after((s = reduce(s, { t: "select", id }))) && undefined,
    move: (delta: number): void =>
      after(
        (s = reduce(s, {
          t: "move",
          delta,
          ids: searchMatches(ctl.get(), fleetSessions(s)).map((x) => x.id),
        })),
      ) && undefined,
    disconnect: (): void => {
      live = false;
      after(null);
    },
    reconnect: (): void => {
      live = true;
      after(null);
    },
    rows: (): string[] => searchMatches(ctl.get(), fleetSessions(s)).map((x) => x.id),
    state: (): TuiState => s,
    find: (): Find => {
      const find = ctl.get();
      assert.ok(find);
      return find;
    },
    /** Long enough for a debounce that is set to 5ms to have fired. */
    wait: (): Promise<void> => new Promise((r) => setTimeout(r, 25)) as Promise<void>,
  };
};

const two = (): SessionSnapshot[] => [
  snap({ id: "best", title: "mobile access" }),
  snap({ id: "weak", title: "another chat" }),
];

test("fleet search: a burst of keystrokes is one search, for the query it settles on", async () => {
  const m = mkSearch(two());
  m.type("m");
  m.type("mo");
  m.type("mob");
  assert.deepEqual(m.sent(), [], "nothing goes out mid-word");
  // Typing is visible immediately even though the answer isn't.
  assert.equal(m.find().buffer.text, "mob");
  assert.ok(searchStale(m.find()), "and it reads as unanswered, not as no matches");

  await m.wait();
  assert.deepEqual(m.sent(), ["mob"]);
  m.calls[0]!.ok(result("mob", ["best"]));
  await m.wait();
  assert.deepEqual(m.rows(), ["best"]);
  assert.equal(searchStale(m.find()), false);
});

test("fleet search: an answer for a query you have typed past is not an answer to this one", async () => {
  const m = mkSearch(two());
  m.type("mobile");
  await m.wait();
  m.type("another");
  await m.wait();
  assert.deepEqual(m.sent(), ["mobile", "another"]);

  // The first search finally answers — after the query moved on. Its rows are
  // a correct answer to a question nobody is asking any more.
  m.calls[0]!.ok(result("mobile", ["best"]));
  await m.wait();
  assert.ok(searchStale(m.find()), "still waiting on `another`");
  assert.deepEqual(m.rows(), [], "and showing nothing rather than the wrong thing");

  m.calls[1]!.ok(result("another", ["weak"]));
  await m.wait();
  assert.deepEqual(m.rows(), ["weak"]);
});

test("fleet search: clearing the query is the whole fleet, with no round trip", async () => {
  const m = mkSearch(two());
  m.type("mobile");
  await m.wait();
  m.calls[0]!.ok(result("mobile", ["best"]));
  await m.wait();
  assert.deepEqual(m.rows(), ["best"]);

  m.type("");
  assert.deepEqual(m.rows(), ["weak", "best"], "immediately, and in the fleet's own order");
  assert.equal(searchStale(m.find()), false);
  await m.wait();
  assert.deepEqual(m.sent(), ["mobile"], "the empty query is not a search");
});

test("fleet search: the selection rides onto the best match, but only on its own results", async () => {
  const m = mkSearch(two());
  assert.equal(m.state().selectedId, "weak", "fixture: the fleet head is not the best match");

  m.type("chat");
  await m.wait();
  assert.equal(m.state().selectedId, "weak", "typing alone does not move the selection");
  m.calls[0]!.ok(result("chat", ["weak", "best"]));
  await m.wait();
  assert.equal(m.state().selectedId, "weak", "a selection that still matches stays put");

  m.type("mobile");
  await m.wait();
  assert.equal(m.state().selectedId, "weak", "still not — `mobile` has not answered yet");
  m.calls[1]!.ok(result("mobile", ["best"]));
  await m.wait();
  assert.equal(m.state().selectedId, "best", "one that no longer matches rides onto the top row");
});

test("fleet search: ids the fleet doesn't have are not rows", async () => {
  const m = mkSearch(two());
  m.type("mobile");
  await m.wait();
  // The daemon ranks over its own sessions; this client's snapshot can be a
  // beat behind (or a session can end between the search and the frame).
  m.calls[0]!.ok(result("mobile", ["best", "ended", "weak"]));
  await m.wait();
  assert.deepEqual(m.rows(), ["best", "weak"]);
  const results = m.find().results;
  assert.ok(results.tag === "data");
  assert.deepEqual(
    [...results.value.ids],
    ["best", "ended", "weak"],
    "the page is kept as it came — the intersection is a display decision",
  );
});

test("fleet search: losing the daemon drops the results; coming back re-runs the query once", async () => {
  const m = mkSearch(two());
  m.type("mobile");
  await m.wait();
  m.calls[0]!.ok(result("mobile", ["best"]));
  await m.wait();
  assert.deepEqual(m.rows(), ["best"]);

  m.disconnect();
  assert.deepEqual(m.rows(), [], "the fleet it described is one we're no longer told about");
  assert.ok(searchStale(m.find()));
  m.disconnect(); // a second dispatch while still down must not re-arm anything

  m.reconnect();
  await m.wait();
  assert.deepEqual(m.sent(), ["mobile", "mobile"], "re-run once, not per frame");
  m.reconnect();
  await m.wait();
  assert.deepEqual(m.sent(), ["mobile", "mobile"]);
});

test("fleet search: a failed search says so, and refresh is what retries it", async () => {
  const m = mkSearch(two());
  m.type("mobile");
  await m.wait();
  m.calls[0]!.fail(new Error("daemon said no"));
  await m.wait();
  assert.equal(m.find().results.tag, "error");
  assert.deepEqual(m.rows(), [], "a failure is not an empty result set");
  assert.match(
    fleetFilterStatus(m.find(), fleetSessions(m.state())),
    /search failed: daemon said no/,
  );
  assert.deepEqual(m.sent(), ["mobile"], "and it does not retry itself");

  m.ctl.refresh();
  await m.wait();
  assert.deepEqual(m.sent(), ["mobile", "mobile"]);
});

test("fleet search: the header separates 'still counting' from 'nothing matched'", async () => {
  const m = mkSearch(two());
  const header = (): string => fleetFilterStatus(m.find(), fleetSessions(m.state()));
  assert.equal(header(), "2 sessions", "no query yet — a count, not a search");

  m.type("mobile");
  assert.equal(header(), "searching…");
  await m.wait();
  m.calls[0]!.ok(result("mobile", []));
  await m.wait();
  assert.equal(header(), "0/2 matches");

  m.type("chat");
  await m.wait();
  m.calls[1]!.ok(result("chat", ["best"]));
  await m.wait();
  assert.equal(header(), "1/2 match", "the result contains every match");
});

test("fleet search: ↑↓ walk the ranked rows, not the fleet's", async () => {
  const m = mkSearch(two());
  m.type("mobile");
  await m.wait();
  // Ranked best-first, which is the reverse of the fleet's own order here.
  m.calls[0]!.ok(result("mobile", ["best", "weak"]));
  await m.wait();
  assert.equal(m.state().selectedId, "weak", "the selection still matches, so it stays");
  m.move(-1);
  assert.equal(m.state().selectedId, "best", "↑ walks up the ranked list");
  m.move(1);
  assert.equal(m.state().selectedId, "weak");
});
