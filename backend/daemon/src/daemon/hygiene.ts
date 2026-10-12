import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Logger } from "@loom/core/logger";
import type { LoomPaths } from "@loom/core/paths";
import { pidAlive } from "@loom/core/daemon-endpoint";
import { clearStaleIndexLock, showIndexLockCheck } from "@loom/core/git-lock";
import type { ChildStore, MidRunSession } from "../store/sessions.ts";
import type { Registry } from "./registry.ts";

export interface HygieneInput {
  paths: LoomPaths;
  registry: Registry;
  children: ChildStore;
  /** Identifier for this daemon run; children tagged with a different one are stale. */
  epoch: string;
  /**
   * Worktrees mounted into a session VM that recovery left possibly running: a
   * `git` in its guest is invisible to the host's lock check. `unknown` when
   * recovery could not list every session: no lock is cleared then.
   */
  vmWorktrees: ReadonlySet<string> | "unknown";
  log: Logger;
}

export interface HygieneReport {
  /** Sessions the previous daemon left mid-run, with the status each held. */
  interruptedSessions: MidRunSession[];
  reapedChildren: number;
  clearedLocks: string[];
  worktreePruned: boolean;
}

/**
 * Bring a freshly-started daemon into a clean state after a previous instance
 * exited (cleanly or not). Design spec §11, milestone 1:
 *
 *   - sessions left mid-run become `interrupted`; `[auto_resume]` then
 *     re-drives the actively-working ones (blocked ones stay parked)
 *   - child processes (Claude CLI, MCP servers) from a prior daemon epoch are
 *     signalled to exit and their bookkeeping rows dropped
 *   - each worktree's `index.lock`, in its own gitdir, is removed when old and
 *     unused (core/src/git-lock.ts), in the worktree directory and the legacy
 *     `.loom/trees`, but not in one a session VM may still have mounted; then
 *     `git worktree prune` drops vanished worktrees
 */
export const runStartupHygiene = (input: HygieneInput): HygieneReport => {
  const { paths, registry, children, epoch, vmWorktrees, log } = input;

  const interruptedSessions = registry.markMidRunInterrupted();
  if (interruptedSessions.length > 0) {
    log.warn("marked mid-run sessions interrupted", {
      ids: interruptedSessions.map((s) => s.id),
    });
  }

  const reapedChildren = reapChildren(children, epoch, log);
  const { clearedLocks, worktreePruned } = tidyWorktrees(paths, vmWorktrees, log);

  return { interruptedSessions, reapedChildren, clearedLocks, worktreePruned };
};

const reapChildren = (children: ChildStore, epoch: string, log: Logger): number => {
  let reaped = 0;
  for (const row of children.all()) {
    const stale = row.daemon_epoch !== epoch;
    const alive = pidAlive(row.pid);

    if (!alive) {
      children.forget(row.pid);
      continue;
    }
    if (!stale) {
      // Belongs to us already (e.g. a restart-in-place test); leave it.
      continue;
    }

    log.warn("terminating stale child", { pid: row.pid, kind: row.kind });
    try {
      Deno.kill(row.pid, "SIGTERM");
    } catch {
      // already gone between the alive check and here
    }
    // Escalate shortly if it ignores SIGTERM. Fire-and-forget; the row is
    // dropped now so it never lingers across another restart.
    const pid = row.pid;
    setTimeout(() => {
      if (pidAlive(pid)) {
        try {
          Deno.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }, 2000).unref();

    children.forget(row.pid);
    reaped++;
  }
  return reaped;
};

/** Paths of the stale `index.lock`s removed from the session worktrees. */
const clearWorktreeLocks = (
  paths: LoomPaths,
  vmWorktrees: ReadonlySet<string> | "unknown",
  log: Logger,
): string[] => {
  if (vmWorktrees === "unknown") {
    log.warn("left every worktree lock alone: a session VM may still run in any of them");
    return [];
  }
  const mounted = new Set([...vmWorktrees].map((tree) => resolve(tree)));
  const clearedLocks: string[] = [];
  for (const trees of new Set([paths.trees, join(paths.legacy.dir, "trees")])) {
    let entries: string[];
    try {
      entries = readdirSync(trees);
    } catch {
      continue;
    }
    for (const name of entries) {
      const treeDir = join(trees, name);
      // Without its own `.git`, git would walk up to the repository holding a
      // legacy `.loom/trees` and judge the main checkout's lock instead.
      if (!existsSync(join(treeDir, ".git"))) continue;
      if (mounted.has(resolve(treeDir))) {
        log.warn("left a session VM's worktree locks alone: the VM may still run", { treeDir });
        continue;
      }
      const check = clearStaleIndexLock(treeDir);
      if (check.kind === "removed") {
        clearedLocks.push(check.path);
        log.warn("cleared stale git lock", { lock: check.path });
      } else if (check.kind !== "absent") {
        log.warn("left a git lock in place", { treeDir, detail: showIndexLockCheck(check) });
      }
    }
  }
  return clearedLocks;
};

const tidyWorktrees = (
  paths: LoomPaths,
  vmWorktrees: ReadonlySet<string> | "unknown",
  log: Logger,
): { clearedLocks: string[]; worktreePruned: boolean } => {
  const clearedLocks = clearWorktreeLocks(paths, vmWorktrees, log);
  let worktreePruned = false;
  const res = spawnSync("git", ["-C", paths.repoRoot, "worktree", "prune"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (res.status === 0) {
    worktreePruned = true;
  } else if (res.error) {
    log.debug("git worktree prune skipped", { err: String(res.error) });
  }
  return { clearedLocks, worktreePruned };
};
