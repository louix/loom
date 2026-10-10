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

/** Whether a process other than this one, and not a zombie, is still in `pgid`. */
const groupHasLivePeers = async (pgid: number): Promise<boolean> => {
  if (existsSync("/proc/self/stat")) {
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
  }
  const ps = await new Deno.Command("/bin/ps", {
    args: ["-o", "pid=,stat=", "-g", String(pgid)],
    stdout: "piped",
    stderr: "null",
  })
    .output()
    .catch(() => undefined);
  // Unknown is treated as alive: the caller then kills at the deadline, as before.
  if (!ps) return true;
  return new TextDecoder()
    .decode(ps.stdout)
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .some(([pid, state]) => !!pid && Number(pid) !== Deno.pid && !state?.startsWith("Z"));
};

/** After a SIGTERM already sent to `pgid`: SIGKILL whatever is still running after the grace. */
export const escalateProcessGroup = async (
  pgid: number,
  graceMs: number = PROCESS_GROUP_GRACE_MS,
): Promise<void> => {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await delay(POLL_MS);
    if (!(await groupHasLivePeers(pgid))) return;
  }
  signalGroup(pgid, "SIGKILL");
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
