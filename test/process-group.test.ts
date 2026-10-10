// A `git` killed while it holds `index.lock` leaves the worktree locked for every
// later write. SIGKILL does that; SIGTERM lets Git remove the lock, so Loom ends
// process groups with SIGTERM and kills only what outlives the grace.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  escalateProcessGroup,
  settleProcessGroups,
  terminateProcessGroup,
} from "@loom/core/process-group";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "loom-index-lock-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const lock = join(root, ".git", "index.lock");
  return { root, lock, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

/** `git commit -a` holds index.lock while its pre-commit hook runs: a slow hook is a git mid-write. */
const commitInHook = async (root: string, lock: string): Promise<ChildProcess> => {
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nsleep 30\n");
  chmodSync(hook, 0o755);
  writeFileSync(join(root, "a.txt"), "changed\n");
  const child = spawn("git", ["-C", root, "commit", "-q", "-a", "-m", "work"], {
    detached: true,
    stdio: "ignore",
  });
  for (let i = 0; i < 500 && !existsSync(lock); i++) await delay(10);
  assert.ok(existsSync(lock), "git holds index.lock while its hook runs");
  return child;
};

const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) =>
    child.exitCode !== null || child.signalCode !== null
      ? resolve()
      : child.once("exit", () => resolve()),
  );

test("SIGKILL leaves a git's index.lock behind; terminating the group with SIGTERM does not", async () => {
  const killed = repo();
  const terminated = repo();
  try {
    const a = await commitInHook(killed.root, killed.lock);
    Deno.kill(-a.pid!, "SIGKILL");
    await exited(a);
    assert.ok(existsSync(killed.lock), "the SIGKILLed git's lock is left behind");

    const b = await commitInHook(terminated.root, terminated.lock);
    await terminateProcessGroup(b.pid!, 5_000);
    await exited(b);
    assert.ok(!existsSync(terminated.lock), "a SIGTERMed git removes its lock");
  } finally {
    killed.cleanup();
    terminated.cleanup();
  }
});

test("terminating a process group kills what ignores SIGTERM once the grace is over", async () => {
  const child = spawn("sh", ["-c", "trap '' TERM; sleep 30"], { detached: true, stdio: "ignore" });
  await delay(50);
  await terminateProcessGroup(child.pid!, 200);
  await exited(child);
  assert.equal(child.signalCode, "SIGKILL");
});

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const config = fileURLToPath(new URL("../deno.json", import.meta.url));

/** Whether any process (zombies included) is still in `pgid`. */
const groupExists = (pgid: number): boolean => {
  try {
    Deno.kill(-pgid, 0 as unknown as Deno.Signal);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

for (const exit of ["worker", "abrupt"] as const) {
  test(`a worker's ${exit} exit does not leave a Bash group that ignores SIGTERM running`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-tool-group-"));
    const pidFile = join(dir, "pgid");
    let pgid = 0;
    try {
      const worker = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", config, fixture("tool-group-exit.ts"), pidFile, exit],
        cwd: dir,
        stdout: "null",
        stderr: "piped",
      }).output();
      assert.equal(worker.code, 0, new TextDecoder().decode(worker.stderr));
      pgid = Number(readFileSync(pidFile, "utf8").trim());
      assert.ok(pgid > 0);
      // Killed members are reparented and reaped by init: allow for that.
      for (let i = 0; i < 100 && groupExists(pgid); i++) await delay(20);
      assert.equal(groupExists(pgid), false, "the TERM-proof group was killed before the exit");
    } finally {
      if (pgid > 0 && groupExists(pgid)) Deno.kill(-pgid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a group is watched with kill(-pgid, 0) where /proc and ps are unavailable", async () => {
  const watch = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-run", "--allow-env", "--deny-run=ps", fixture("group-watch.ts")],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.equal(watch.code, 0, new TextDecoder().decode(watch.stderr));
  // Blind, the group would be SIGKILLed after 250 ms, before its trap finished.
  assert.deepEqual(JSON.parse(new TextDecoder().decode(watch.stdout)), { code: 7, signal: null });
});

test("settling waits for a fire-and-forget escalation to kill a TERM-proof group", async () => {
  const child = spawn("sh", ["-c", "trap '' TERM; sleep 30"], { detached: true, stdio: "ignore" });
  await delay(50);
  Deno.kill(-child.pid!, "SIGTERM");
  void escalateProcessGroup(child.pid!, 200);
  await settleProcessGroups();
  await exited(child);
  assert.equal(child.signalCode, "SIGKILL");
});

test("terminating a process group returns as soon as the group has gone", async () => {
  const child = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  await delay(50);
  const started = Date.now();
  await terminateProcessGroup(child.pid!, 60_000);
  await exited(child);
  assert.equal(child.signalCode, "SIGTERM");
  assert.ok(Date.now() - started < 30_000, "did not wait out the grace");
});
