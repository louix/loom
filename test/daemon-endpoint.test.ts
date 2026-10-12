/**
 * Finding a repository's daemon across the move of its socket from
 * `<repo>/.loom` to the runtime directory: a daemon an older Loom started keeps
 * the repository until it is restarted, and nothing starts a second one beside it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { daemonEndpoint, daemonLock, legacyDaemonPid } from "@loom/core/daemon-endpoint";
import { ensureLoomDirectories, loomPaths, type LoomPaths } from "@loom/core/paths";
import { Daemon } from "@loom/daemon/daemon/daemon";
import { removeLoomDirectories } from "../harness/src/loom-directories.ts";
import { LegacyDaemonRunning, lockRepository } from "@loom/daemon/daemon/lifecycle";

interface Fixture {
  repo: string;
  paths: LoomPaths;
  remove: () => void;
}

const mkFixture = (): Fixture => {
  const repo = realpathSync(mkdtempSync("/tmp/loom-endpoint-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "base"]);
  const paths = loomPaths(repo);
  ensureLoomDirectories(paths);
  return {
    repo,
    paths,
    remove: () => {
      removeLoomDirectories(paths);
      rmSync(repo, { recursive: true, force: true });
    },
  };
};

/** A live process whose command line names `loomd`, as an older daemon's does. */
const mkFakeLoomd = (): Deno.ChildProcess =>
  new Deno.Command("sh", { args: ["-c", "sleep 60; :", "loomd"], stdin: "null" }).spawn();

const writeLegacyDaemon = (paths: LoomPaths, pid: number): void => {
  mkdirSync(paths.legacy.dir, { recursive: true });
  writeFileSync(paths.legacy.pid, JSON.stringify({ pid, epoch: "old", startedAt: 0 }));
  writeFileSync(paths.legacy.sock, ""); // A file stands in for the socket node.
};

test("daemonEndpoint dials the runtime directory when no older daemon runs", () => {
  const f = mkFixture();
  try {
    assert.deepEqual(daemonEndpoint(f.paths), {
      kind: "current",
      sock: f.paths.sock,
      lock: f.paths.lock,
    });
  } finally {
    f.remove();
  }
});

test("daemonEndpoint dials an older daemon still serving from <repo>/.loom", async () => {
  const f = mkFixture();
  const old = mkFakeLoomd();
  try {
    writeLegacyDaemon(f.paths, old.pid);
    assert.equal(legacyDaemonPid(f.paths), old.pid);
    assert.deepEqual(daemonEndpoint(f.paths), {
      kind: "legacy",
      sock: f.paths.legacy.sock,
      pid: f.paths.legacy.pid,
    });
    // A current daemon wins: it only starts once the older one is gone.
    const current = await lockRepository(f.paths.lock, "new");
    assert.equal(daemonEndpoint(f.paths).kind, "current");
    current.release();
  } finally {
    old.kill("SIGKILL");
    await old.status;
    f.remove();
  }
});

test("daemonEndpoint ignores a stale legacy pidfile, even when its pid was reused", async () => {
  const f = mkFixture();
  const other = new Deno.Command("sleep", { args: ["60"], stdin: "null" }).spawn();
  try {
    writeLegacyDaemon(f.paths, other.pid);
    assert.equal(legacyDaemonPid(f.paths), null);
    assert.equal(daemonEndpoint(f.paths).kind, "current");
    other.kill("SIGKILL");
    await other.status;
    assert.equal(legacyDaemonPid(f.paths), null);
  } finally {
    try {
      other.kill("SIGKILL");
    } catch {
      // already reaped
    }
    f.remove();
  }
});

test("a daemon refuses to start beside an older one, and releases its lock", async () => {
  const f = mkFixture();
  const old = mkFakeLoomd();
  const config = join(f.repo, "config.jsonc");
  writeFileSync(config, "{}");
  try {
    writeLegacyDaemon(f.paths, old.pid);
    await assert.rejects(
      Daemon.start({ repoRoot: f.repo, configFile: config, standalone: false, connectors: {} }),
      (error) => error instanceof LegacyDaemonRunning && /older version/.test(error.message),
    );
    assert.deepEqual(daemonLock(f.paths.lock), { kind: "free" });
    assert.throws(() => Deno.statSync(f.paths.sock), Deno.errors.NotFound);
  } finally {
    old.kill("SIGKILL");
    await old.status;
    f.remove();
  }
});
