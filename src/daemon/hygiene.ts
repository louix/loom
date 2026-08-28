import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../util/logger.ts";
import type { LoomPaths } from "../util/paths.ts";
import type { ChildStore } from "../store/sessions.ts";
import type { Registry } from "./registry.ts";

export interface HygieneInput {
  paths: LoomPaths;
  registry: Registry;
  children: ChildStore;
  /** Identifier for this daemon run; children tagged with a different one are stale. */
  epoch: string;
  log: Logger;
}

export interface HygieneReport {
  interruptedSessions: string[];
  reapedChildren: number;
  clearedLocks: string[];
  worktreePruned: boolean;
}

/** Is `pid` a live process (whether or not we can signal it)? */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Bring a freshly-started daemon into a clean state after a previous instance
 * exited (cleanly or not). Design spec §11, milestone 1:
 *
 *   - sessions left mid-run become `interrupted` (never auto-resumed)
 *   - child processes (Claude CLI, MCP servers) from a prior daemon epoch are
 *     signalled to exit and their bookkeeping rows dropped
 *   - stale git index locks under `.loom/trees/` are removed and worktrees pruned
 */
export function runStartupHygiene(input: HygieneInput): HygieneReport {
  const { paths, registry, children, epoch, log } = input;

  const interruptedSessions = registry.markMidRunInterrupted();
  if (interruptedSessions.length > 0) {
    log.warn("marked mid-run sessions interrupted", { ids: interruptedSessions });
  }

  const reapedChildren = reapChildren(children, epoch, log);
  const { clearedLocks, worktreePruned } = tidyWorktrees(paths, log);

  return { interruptedSessions, reapedChildren, clearedLocks, worktreePruned };
}

function reapChildren(children: ChildStore, epoch: string, log: Logger): number {
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
      process.kill(row.pid, "SIGTERM");
    } catch {
      // already gone between the alive check and here
    }
    // Escalate shortly if it ignores SIGTERM. Fire-and-forget; the row is
    // dropped now so it never lingers across another restart.
    const pid = row.pid;
    setTimeout(() => {
      if (pidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }, 2000).unref();

    children.forget(row.pid);
    reaped++;
  }
  return reaped;
}

function tidyWorktrees(
  paths: LoomPaths,
  log: Logger,
): { clearedLocks: string[]; worktreePruned: boolean } {
  const clearedLocks: string[] = [];
  if (existsSync(paths.trees)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(paths.trees);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      const treeDir = join(paths.trees, name);
      try {
        if (!statSync(treeDir).isDirectory()) continue;
      } catch {
        continue;
      }
      // A worktree's .git is a file pointing at the real gitdir; the index.lock
      // that a killed git process leaves behind lives in that gitdir. Check the
      // common in-tree location too.
      for (const lock of [join(treeDir, ".git", "index.lock"), join(treeDir, "index.lock")]) {
        if (existsSync(lock)) {
          try {
            rmSync(lock);
            clearedLocks.push(lock);
            log.warn("cleared stale git lock", { lock });
          } catch {
            /* leave it; git will complain later, loudly */
          }
        }
      }
    }
  }

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
}
