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
import { daemonEndpoint, legacyDaemonPid } from "@loom/core/daemon-endpoint";
import { ensureLoomDirectories, loomPaths, type LoomPaths } from "@loom/core/paths";
import { Daemon } from "@loom/daemon/daemon/daemon";
import { LegacyDaemonRunning } from "@loom/daemon/daemon/lifecycle";

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
      rmSync(paths.runtime, { recursive: true, force: true });
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
      sock: f.paths.sock,
      pid: f.paths.pid,
      legacy: false,
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
      sock: f.paths.legacy.sock,
      pid: f.paths.legacy.pid,
      legacy: true,
    });
    // A current daemon wins: it only starts once the older one is gone.
    writeFileSync(f.paths.pid, JSON.stringify({ pid: Deno.pid, epoch: "new", startedAt: 0 }));
    assert.equal(daemonEndpoint(f.paths).legacy, false);
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
    assert.equal(daemonEndpoint(f.paths).legacy, false);
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

test("a daemon refuses to start beside an older one, and releases its pidfile", async () => {
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
    assert.throws(() => Deno.statSync(f.paths.pid), Deno.errors.NotFound);
    assert.throws(() => Deno.statSync(f.paths.sock), Deno.errors.NotFound);
  } finally {
    old.kill("SIGKILL");
    await old.status;
    f.remove();
  }
});
