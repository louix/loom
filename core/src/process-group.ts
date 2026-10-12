/**
 * Ending a process group that may be running the agent's tools.
 *
 * SIGKILL gives a `git` in the group no chance to remove the `index.lock` it
 * holds: the worktree is then locked until someone deletes the file by hand.
 * SIGTERM first lets Git (and anything else with cleanup handlers) unwind;
 * only what is still running after the grace is killed.
 *
 * Every escalation in flight is tracked: a process that exits before a grace
 * ends would otherwise drop the SIGKILL, and a group that ignores SIGTERM
 * (`trap '' TERM; sleep 1000`) would outlive it. Exit paths await
 * {@link settleProcessGroups}; any other `Deno.exit` SIGKILLs what is pending.
 */
import { setTimeout as delay } from "node:timers/promises";

export const PROCESS_GROUP_GRACE_MS = 2_000;
/** `kill(-pgid, 0)` is one syscall: cheap enough to poll often. */
const SIGNAL_POLL_MS = 50;
/** Listing processes (only for this process's own group) costs a full scan. */
const SCAN_POLL_MS = 200;

/** Signal every member of `pgid` (0: only check); false once the group has gone. */
const signalGroup = (pgid: number, signal: Deno.Signal | 0): boolean => {
  try {
    Deno.kill(-pgid, signal as Deno.Signal);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    // Darwin reports EPERM for a group whose last members are exiting.
    if (error instanceof Deno.errors.PermissionDenied) return false;
    throw error;
  }
};

/** Live members of `pgid` from /proc, other than this process and zombies. */
const procPeers = async (pgid: number): Promise<boolean> => {
  for await (const entry of Deno.readDir("/proc")) {
    if (!/^\d+$/.test(entry.name) || Number(entry.name) === Deno.pid) continue;
    let stat: string;
    try {
      stat = await Deno.readTextFile(`/proc/${entry.name}/stat`);
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
 * Whether a process other than this one, and not a zombie, is still in this
 * process's own group; "unknown" where neither /proc nor `ps` is available to
 * this process (a permission-restricted worker).
 */
const ownGroupHasLivePeers = async (pgid: number): Promise<boolean | "unknown"> => {
  try {
    return await procPeers(pgid);
  } catch {
    // No /proc, or no read permission for it: try ps.
  }
  try {
    // `-g` means a process group on BSD but a session on procps; filter by hand.
    const child = new Deno.Command("ps", {
      args: ["-A", "-o", "pid=,pgid=,stat="],
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const ps = await child.output();
    if (!ps.success) return "unknown";
    // ps lists itself, a member of this group while it runs.
    return new TextDecoder()
      .decode(ps.stdout)
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .some(
        ([pid, group, state]) =>
          Number(group) === pgid &&
          Number(pid) !== Deno.pid &&
          Number(pid) !== child.pid &&
          !state?.startsWith("Z"),
      );
  } catch {
    return "unknown";
  }
};

/**
 * Whether anything is still in `pgid`. Only the group this process leads (a
 * worker ending its own descendants) needs a process listing: for any other
 * group, `kill(-pgid, 0)` failing with ESRCH means it has gone. A member that
 * has exited but is not yet reaped still counts; that only delays the answer
 * until its parent reaps it, or until the grace ends with a harmless SIGKILL.
 */
const groupIsLive = async (pgid: number): Promise<boolean | "unknown"> => {
  if (pgid === Deno.pid) return await ownGroupHasLivePeers(pgid);
  try {
    return signalGroup(pgid, 0);
  } catch {
    return "unknown";
  }
};

/** Without a way to watch the group, wait this long: Git drops its lock at once on SIGTERM. */
const UNOBSERVED_GRACE_MS = 250;

/** Groups SIGTERMed whose escalation has not finished yet. */
const pending = new Map<number, Promise<void>>();

/** At exit, SIGKILL what an unfinished escalation would have, except this process's own group. */
const killPending = (): void => {
  for (const pgid of pending.keys()) {
    if (pgid === Deno.pid) continue;
    try {
      signalGroup(pgid, "SIGKILL");
    } catch {
      // Not ours to end.
    }
  }
};
let exitHookInstalled = false;

const escalate = async (pgid: number, graceMs: number): Promise<void> => {
  const started = Date.now();
  const pollMs = pgid === Deno.pid ? SCAN_POLL_MS : SIGNAL_POLL_MS;
  while (Date.now() - started < graceMs) {
    await delay(Math.min(pollMs, Math.max(0, graceMs - (Date.now() - started))));
    const live = await groupIsLive(pgid);
    if (!live) return;
    if (live === "unknown" && Date.now() - started >= Math.min(graceMs, UNOBSERVED_GRACE_MS)) break;
  }
  try {
    signalGroup(pgid, "SIGKILL");
  } catch {
    // A group we cannot signal is not ours to end.
  }
};

/**
 * After a SIGTERM already sent to `pgid`: SIGKILL whatever is still running after
 * the grace. Safe to fire and forget: it stays tracked until it finishes, so
 * {@link settleProcessGroups} can wait for it, and a `Deno.exit` before then
 * SIGKILLs the group at once.
 */
export const escalateProcessGroup = (
  pgid: number,
  graceMs: number = PROCESS_GROUP_GRACE_MS,
): Promise<void> => {
  const running = pending.get(pgid);
  if (running) return running;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // Deno dispatches `unload` on `Deno.exit` and when the event loop runs dry.
    globalThis.addEventListener("unload", killPending);
  }
  const escalation = escalate(pgid, graceMs).finally(() => pending.delete(pgid));
  pending.set(pgid, escalation);
  return escalation;
};

/** Wait for every escalation in flight, including any started meanwhile. */
export const settleProcessGroups = async (): Promise<void> => {
  while (pending.size > 0) await Promise.all(pending.values());
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
