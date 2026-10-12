// The pidfile guarding one daemon per repository lives in the state directory,
// which outlives a reboot: a pidfile from before one names whatever process now
// has its pid.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonAlreadyRunning, acquirePidfile } from "@loom/daemon/daemon/lifecycle";

test("acquirePidfile refuses a live daemon's pidfile, and takes over one from before the last boot", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-pidfile-"));
  const path = join(dir, "daemon.pid");
  try {
    // given: a live pid, written now
    writeFileSync(path, JSON.stringify({ pid: Deno.pid, epoch: "live", startedAt: Date.now() }));
    // then
    assert.throws(() => acquirePidfile(path, "next"), DaemonAlreadyRunning);
    // given: the same pid, written before this boot
    writeFileSync(path, JSON.stringify({ pid: Deno.pid, epoch: "old", startedAt: 0 }));
    // when
    const claimed = acquirePidfile(path, "next");
    // then
    assert.equal(claimed.epoch, "next");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).epoch, "next");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
