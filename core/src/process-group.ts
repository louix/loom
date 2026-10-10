/**
 * Ending a process group that may be running the agent's tools.
 *
 * SIGKILL gives a `git` in the group no chance to remove the `index.lock` it
 * holds: the worktree is then locked until someone deletes the file by hand.
 * SIGTERM first lets Git (and anything else with cleanup handlers) unwind;
 * only what is still running after the grace is killed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export const PROCESS_GROUP_GRACE_MS = 2_000;
const POLL_MS = 25;

/** Signal every member of `pgid`; false once the group has gone. */
const signalGroup = (pgid: number, signal: Deno.Signal): boolean => {
  try {
    Deno.kill(-pgid, signal);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    // Darwin reports EPERM for a group whose last members are exiting.
    if (error instanceof Deno.errors.PermissionDenied) return false;
    throw error;
  }
};

/** Live members of `pgid` from /proc, other than this process and zombies. */
const procPeers = (pgid: number): boolean => {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === Deno.pid) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue; // exited while we looked
    }
    // `comm` may hold spaces and parentheses; the fields after it start at the last ")".
    const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(pgrp) === pgid && state !== "Z" && state !== "X") return true;
  }
  return false;
};

/**
 * Whether a process other than this one, and not a zombie, is still in `pgid`;
 * "unknown" where neither /proc nor `ps` is available to this process (a
 * permission-restricted worker).
 */
const groupHasLivePeers = async (pgid: number): Promise<boolean | "unknown"> => {
  try {
    if (existsSync("/proc/self/stat")) return procPeers(pgid);
  } catch {
    // No read permission for /proc: try ps.
  }
  try {
    // `-g` means a process group on BSD but a session on procps; filter by hand.
    const ps = await new Deno.Command("ps", {
      args: ["-A", "-o", "pid=,pgid=,stat="],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!ps.success) return "unknown";
    return new TextDecoder()
      .decode(ps.stdout)
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .some(
        ([pid, group, state]) =>
          Number(group) === pgid && Number(pid) !== Deno.pid && !state?.startsWith("Z"),
      );
  } catch {
    return "unknown";
  }
};

/** Without a way to watch the group, wait this long: Git drops its lock at once on SIGTERM. */
const UNOBSERVED_GRACE_MS = 250;

/** After a SIGTERM already sent to `pgid`: SIGKILL whatever is still running after the grace. */
export const escalateProcessGroup = async (
  pgid: number,
  graceMs: number = PROCESS_GROUP_GRACE_MS,
): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < graceMs) {
    await delay(POLL_MS);
    const live = await groupHasLivePeers(pgid);
    if (!live) return;
    if (live === "unknown" && Date.now() - started >= Math.min(graceMs, UNOBSERVED_GRACE_MS)) break;
  }
  try {
    signalGroup(pgid, "SIGKILL");
  } catch {
    // Callers fire and forget; a group we cannot signal is not ours to end.
  }
};

/**
 * SIGTERM `pgid`, then SIGKILL it if anything is still running after the grace.
 * Ending this process's own group needs a SIGTERM listener installed first.
 */
export const terminateProcessGroup = async (
  pgid: number,
  graceMs: number = PROCESS_GROUP_GRACE_MS,
): Promise<void> => {
  if (signalGroup(pgid, "SIGTERM")) await escalateProcessGroup(pgid, graceMs);
};
