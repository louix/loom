// test-run: own-process — retakes flocks right after releasing them; a subprocess another file's thread forks meanwhile holds the lock until its exec.
/**
 * One daemon per repository, decided by an exclusive `flock` on the state
 * directory's `daemon.lock` and nothing else: the pid recorded inside may be
 * stale, reused after a reboot, or not written yet.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonEndpoint, daemonLock, runningDaemon } from "@loom/core/daemon-endpoint";
import { ensureLoomDirectories, loomPaths } from "@loom/core/paths";
import { DaemonAlreadyRunning, lockRepository } from "@loom/daemon/daemon/lifecycle";

test("lockRepository refuses while another daemon holds the lock, and takes it once released", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-lock-"));
  const lock = join(dir, "daemon.lock");
  try {
    // given
    const first = await lockRepository(lock, "first");
    // then
    await assert.rejects(
      lockRepository(lock, "second"),
      (error) => error instanceof DaemonAlreadyRunning && error.message.includes(`pid ${Deno.pid}`),
    );
    assert.deepEqual(daemonLock(lock), { kind: "held", record: first.record });
    // when
    first.release();
    // then
    assert.deepEqual(daemonLock(lock), { kind: "free" });
    const second = await lockRepository(lock, "second");
    assert.equal(second.record.epoch, "second");
    second.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lockRepository takes a lock nobody holds, whatever live pid it records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-lock-"));
  const lock = join(dir, "daemon.lock");
  try {
    // given: a record naming a live process, written just now — a pid reused after a reboot
    writeFileSync(lock, JSON.stringify({ pid: Deno.pid, epoch: "old", startedAt: Date.now() }));
    assert.deepEqual(daemonLock(lock), { kind: "free" });
    // when
    const claimed = await lockRepository(lock, "next");
    // then
    assert.equal(claimed.record.epoch, "next");
    claimed.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a held lock is a running daemon before its holder records itself", async () => {
  const repo = realpathSync(mkdtempSync("/tmp/loom-lock-"));
  execFileSync("git", ["init", "-q", repo]);
  const paths = loomPaths(repo);
  try {
    // given: the lock taken, nothing written into it yet
    ensureLoomDirectories(paths);
    const holder = await Deno.open(paths.lock, { read: true, write: true, create: true });
    assert.ok(await holder.tryLock(true));
    try {
      // then
      assert.deepEqual(daemonLock(paths.lock), { kind: "held", record: null });
      assert.deepEqual(runningDaemon(paths), { pid: null });
      assert.equal(daemonEndpoint(paths).kind, "current");
    } finally {
      holder.close();
    }
    assert.equal(runningDaemon(paths), null);
  } finally {
    rmSync(paths.runtime, { recursive: true, force: true });
    rmSync(paths.state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
