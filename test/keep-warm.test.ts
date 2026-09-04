import assert from "node:assert/strict";
import { test } from "node:test";
import { keepWarmMove } from "@loom/daemon/daemon/daemon";
import { type SessionState, stateIdle, stateRunning } from "@loom/core/session-state";

const NOW = 10_000_000;
const TTL_MIN = 60;
const TTL_MS = TTL_MIN * 60_000;

/** A session whose cache has `fracLeft` of its TTL remaining at {@link NOW}. */
const at = (fracLeft: number, status: SessionState = stateIdle) => ({
  status,
  cache: {
    ttlMinutes: TTL_MIN,
    ttlSource: "observed" as const,
    lastTurnAt: NOW - Math.round(TTL_MS * (1 - fracLeft)),
    lastRead: 1,
    lastWrite: 0,
  },
});

test("skips unless the session is idle", () => {
  assert.equal(keepWarmMove(at(0.02, stateRunning), NOW, 0), "skip");
  assert.equal(keepWarmMove(at(0.02, stateIdle), NOW, 0), "ping");
});

test("skips without a known TTL", () => {
  assert.equal(
    keepWarmMove(
      {
        status: stateIdle,
        cache: {
          ttlMinutes: 0,
          ttlSource: "none" as const,
          lastTurnAt: NOW,
          lastRead: 0,
          lastWrite: 0,
        },
      },
      NOW,
      0,
    ),
    "skip",
  );
  assert.equal(
    keepWarmMove(
      {
        status: stateIdle,
        cache: {
          ttlMinutes: 60,
          ttlSource: "observed" as const,
          lastTurnAt: 0,
          lastRead: 0,
          lastWrite: 0,
        },
      },
      NOW,
      0,
    ),
    "skip",
  );
});

test("skips while comfortably warm, pings once in the red band", () => {
  assert.equal(keepWarmMove(at(0.5), NOW, 0), "skip");
  assert.equal(keepWarmMove(at(0.1), NOW, 0), "skip"); // 10% left — still above the red line
  assert.equal(keepWarmMove(at(0.05), NOW, 0), "ping"); // dropped below 8%
});

test("skips once the cache is already cold", () => {
  assert.equal(keepWarmMove(at(-0.01), NOW, 0), "skip");
});

test("gives up after the ping cap is reached", () => {
  assert.equal(keepWarmMove(at(0.05), NOW, 5), "ping");
  assert.equal(keepWarmMove(at(0.05), NOW, 6), "giveup");
});

/** A keep-warm candidate whose cache has `remainingMs` of a `ttlMinutes` TTL left. */
const withTtl = (ttlMinutes: number, lastTurnAt: number) => ({
  status: stateIdle,
  cache: {
    ttlMinutes,
    ttlSource: "observed" as const,
    lastTurnAt,
    lastRead: 1,
    lastWrite: 0,
  },
});

test("the sweep catches the red band at every phase, on a short TTL too", () => {
  // The 8% band was sized for the 1h TTL Loom used to pin. A measured 5m TTL is
  // now the common case (an API key, an aisdk Anthropic session), and 8% of it
  // is 24s — narrower than the 30s sweep, which could then step from "still
  // warm" straight to "already cold" and silently never re-prime. Before the
  // band floor this missed in 7 of the 30 possible sweep phases.
  const SWEEP_MS = 30_000;
  const TURN_AT = 1_000_000;
  const missedPhases = (ttlMinutes: number): number => {
    const ttlMs = ttlMinutes * 60_000;
    let missed = 0;
    for (let phase = 0; phase < SWEEP_MS; phase += 1000) {
      let pinged = false;
      for (let t = TURN_AT + phase; t < TURN_AT + ttlMs + SWEEP_MS; t += SWEEP_MS) {
        if (keepWarmMove(withTtl(ttlMinutes, TURN_AT), t, 0) === "ping") {
          pinged = true;
          break;
        }
      }
      if (!pinged) missed += 1;
    }
    return missed;
  };
  assert.equal(missedPhases(60), 0);
  assert.equal(missedPhases(5), 0);
  // Below ~4 sweeps of TTL the two constraints collide — a band cannot be both
  // two sweeps wide and under half the window — and the sampling rate wins.
  // No provider offers a TTL that short (Anthropic has 5m and 1h), so this is
  // the documented limit rather than a case worth engineering for.
  assert.ok(missedPhases(1) <= 1);
});

test("a short TTL widens the band, but never past half the window", () => {
  const TURN_AT = 1_000_000;
  const at = (ttlMinutes: number, remainingMs: number) =>
    keepWarmMove(withTtl(ttlMinutes, TURN_AT), TURN_AT + ttlMinutes * 60_000 - remainingMs, 0);
  // 5m: floored to 60s rather than the 24s that 8% would give.
  assert.equal(at(5, 70_000), "skip");
  assert.equal(at(5, 50_000), "ping");
  // 1h: 8% is 288s, already far past the floor, so it is unchanged.
  assert.equal(at(60, 300_000), "skip");
  assert.equal(at(60, 280_000), "ping");
  // 1m: the floor would swallow the whole window, so it is capped at half.
  assert.equal(at(1, 40_000), "skip");
  assert.equal(at(1, 20_000), "ping");
});
