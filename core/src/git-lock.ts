/**
 * Recovering a worktree whose `index.lock` was left behind by a killed `git`.
 *
 * Git removes the lock when it exits or is signalled, so a lock nobody holds is
 * one whose owner died by SIGKILL (or with its VM). Git never ages it out, and
 * every later `git add`/`commit` fails until it is deleted. The lock is removed
 * only when it is old and no live `git` (or process holding the file) is using
 * the worktree; anything Loom cannot rule out is reported instead.
 *
 * That check sees only this machine's processes, so removal also needs every
 * possible holder to be on this machine:
 * - a local session's worker runs on the host, beside any `git` a person runs;
 * - a private-clone VM session's checkout is opened only by its guest (host Git
 *   never runs in an agent-controlled clone).
 * A mount-mode VM session shares the worktree and Git directory with the host,
 * where a person's `git commit` holds the lock for as long as its editor is
 * open. Its worker sets {@link GIT_DIR_SHARED_ENV}; an old lock no process in the
 * VM explains is then reported with the command that removes it, never removed.
 *
 * The check runs as a shell script: the commit tool runs in a connector worker
 * that may run subprocesses but may not read `/proc` or the Git directory.
 */
import { spawnSync } from "node:child_process";
import process from "node:process";
import { READ_ONLY_GIT_OPTIONS } from "./git-read.ts";

/** Longer than any Git command Loom runs itself (90 s rebase) and than Git normally holds a lock. */
export const STALE_INDEX_LOCK_AGE_MS = 120_000;

/**
 * "1" in a session VM worker whose worktree and Git directory are mounted from
 * the host (set by guest-worker.ts): a `git` this machine cannot see may hold
 * the lock.
 */
export const GIT_DIR_SHARED_ENV = "LOOM_GIT_DIR_SHARED";

/** Whether a `git` outside this machine can hold this worker's locks; unreadable means it can. */
const gitDirShared = (): boolean => {
  try {
    return process.env[GIT_DIR_SHARED_ENV] === "1";
  } catch {
    return true;
  }
};

export const INDEX_LOCK_ERROR = /Unable to create '[^']*index\.lock': File exists/;

export type IndexLockCheck =
  | { kind: "absent" }
  | { kind: "removed"; path: string; ageMs: number }
  | { kind: "recent"; path: string; ageMs: number }
  | { kind: "held"; path: string; ageMs: number; pids: number[] }
  /** Old and unused in this machine, where a holder on the host would be invisible. */
  | { kind: "shared"; path: string; ageMs: number }
  | { kind: "unknown"; path: string; reason: string };

/**
 * `$1` the lock, then the worktree's roots. Prints `age <s>`, then `pid <n>` for
 * every git whose cwd is under a root and every process with the lock open, or
 * `unknown <reason>`. Exit 3: no lock.
 */
const PROBE = `
lock=$1; shift
[ -e "$lock" ] || exit 3
mtime=$(stat -c %Y "$lock" 2>/dev/null || stat -f %m "$lock" 2>/dev/null) || { echo "unknown stat failed"; exit 0; }
echo "age $(( $(date +%s) - mtime ))"
under() { for r in "$@"; do case "$cwd" in "$r"|"$r"/*) return 0;; esac; done; return 1; }
if [ -r /proc/self/comm ]; then
  for c in $(grep -lx git /proc/[0-9]*/comm 2>/dev/null); do
    p=\${c%/comm}
    cwd=$(readlink "$p/cwd" 2>/dev/null) || continue
    under "$@" && echo "pid \${p#/proc/}"
  done
  find /proc/[0-9]*/fd -lname "$lock" 2>/dev/null | sed 's#^/proc/\\([0-9]*\\)/.*#pid \\1#'
elif command -v lsof >/dev/null 2>&1 && command -v pgrep >/dev/null 2>&1; then
  for pid in $(pgrep -x git); do
    cwd=$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p')
    under "$@" && echo "pid $pid"
  done
  lsof -t -- "$lock" 2>/dev/null | sed 's/^/pid /'
else
  echo "unknown no process listing (lsof/pgrep)"
fi
`;

const gitOut = (cwd: string, args: string[]): string | null => {
  const r = spawnSync("git", [...READ_ONLY_GIT_OPTIONS, "-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return r.status === 0 ? r.stdout.trim() : null;
};

/**
 * Remove the worktree's `index.lock` if it is stale. `minAgeMs` is for tests;
 * `shared` defaults to {@link GIT_DIR_SHARED_ENV}.
 */
export const clearStaleIndexLock = (
  cwd: string,
  opts: { minAgeMs?: number; shared?: boolean } = {},
): IndexLockCheck => {
  const lock = gitOut(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index.lock"]);
  if (!lock) return { kind: "absent" };
  const roots = [
    gitOut(cwd, ["rev-parse", "--show-toplevel"]),
    gitOut(cwd, ["rev-parse", "--absolute-git-dir"]),
  ].filter((root): root is string => !!root);
  const probe = spawnSync("sh", ["-c", PROBE, "sh", lock, ...roots], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (probe.status === 3) return { kind: "absent" };
  if (probe.status !== 0) return { kind: "unknown", path: lock, reason: "process check failed" };
  const lines = probe.stdout.trim().split("\n");
  const unknown = lines.find((line) => line.startsWith("unknown "));
  if (unknown) return { kind: "unknown", path: lock, reason: unknown.slice("unknown ".length) };
  const ageMs = Number(lines.find((line) => line.startsWith("age "))?.slice(4)) * 1000;
  if (!Number.isFinite(ageMs)) return { kind: "unknown", path: lock, reason: "no lock age" };
  if (ageMs < (opts.minAgeMs ?? STALE_INDEX_LOCK_AGE_MS))
    return { kind: "recent", path: lock, ageMs };
  const pids = [
    ...new Set(
      lines.filter((line) => line.startsWith("pid ")).map((line) => Number(line.slice(4))),
    ),
  ];
  if (pids.length > 0) return { kind: "held", path: lock, ageMs, pids };
  if (opts.shared ?? gitDirShared()) return { kind: "shared", path: lock, ageMs };
  const rm = spawnSync("rm", ["-f", "--", lock]);
  if (rm.status !== 0) return { kind: "unknown", path: lock, reason: "could not remove it" };
  return { kind: "removed", path: lock, ageMs };
};

const showAge = (ms: number): string =>
  ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

/** One line for a person or a model: what Loom found, and the fix when it did not apply it. */
export const showIndexLockCheck = (check: IndexLockCheck): string => {
  switch (check.kind) {
    case "absent":
      return "";
    case "removed":
      return `Loom removed a stale ${check.path} (${showAge(check.ageMs)} old; no git process was using this worktree).`;
    case "recent":
      return `${check.path} is ${showAge(check.ageMs)} old: another git command is probably still running here. Retry shortly.`;
    case "held":
      return `${check.path} (${showAge(check.ageMs)} old) is in use by process ${check.pids.join(", ")}; wait for it to finish.`;
    case "shared":
      return `${check.path} is ${showAge(check.ageMs)} old and no git in this VM is using it, but this worktree is shared with the host, where a git (such as a commit waiting on its editor) can hold it unseen. If no git is running in this worktree on the host, remove it: rm '${check.path}'`;
    case "unknown":
      return `Loom could not tell whether ${check.path} is stale (${check.reason}). If no git process is running in this worktree, remove it: rm '${check.path}'`;
  }
};
