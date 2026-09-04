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
