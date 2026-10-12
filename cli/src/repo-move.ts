/**
 * `loom repo move <old> <new>`: after a checkout moved, carry Loom's per-user
 * state from the old path's keys to the new one's — the state directory
 * (database, logs, hooks), the package cache, session VM state and prepared
 * environments — and fix what records the old paths: session rows, Git's
 * worktree links and every worktree's `core.hooksPath`.
 *
 * Not fixable here, and reported instead: conversation history a provider keys
 * by working directory (Claude Code's `~/.claude/projects/<path>`) for sessions
 * that ran in the old checkout itself, old paths quoted in session history, and
 * `repos[].path` entries in the user config.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import {
  findRepoRoot,
  loomPaths,
  loomPathsOfState,
  readRepoRecord,
  repoStateDirectory,
  worktreeDirectory,
  writeRepoRecord,
} from "@loom/core/paths";
import { runningDaemonPid } from "@loom/core/daemon-endpoint";
import { userDirectory } from "@loom/core/user-dirs";
import { makeLogger } from "@loom/core/logger";
import { listVms } from "../../runtime/src/session-vm/inventory.ts";
import { repoBaseDirectory } from "../../runtime/src/session-vm/repo-base.ts";
import { sessionCloneRoot } from "../../backend/daemon/src/daemon/session-vm-state.ts";
import { WorktreeManager } from "../../backend/daemon/src/daemon/worktrees.ts";
import { sessionCount } from "../../backend/daemon/src/store/db.ts";
import { loadConfig } from "../../backend/daemon/src/config/config.ts";
import { userConfigPath } from "../../backend/daemon/src/config-path.ts";
import { rememberRepository } from "./recent-repositories.ts";

export interface RepoMoveReport {
  from: string;
  to: string;
  /** Directories carried to the new repository's keys, as `old -> new`. */
  moved: string[];
  /** Session rows whose stored workspace path changed. */
  sessionsUpdated: number;
  /** Worktrees whose Git links were repaired. */
  worktreesRepaired: number;
  /** What could not be fixed, for the user to act on. */
  notes: string[];
}

/**
 * The repository whose state `old` names, and that state directory: by its
 * key when that records `old`, else by a `repo.json` that records it. The key
 * hashes the real path, so a symlinked `old` can key another checkout's state.
 */
const recordedRepository = (old: string): { repo: string; state: string } => {
  const keyedState = repoStateDirectory(old);
  const keyed = readRepoRecord(join(keyedState, "repo.json"));
  if (keyed === old) return { repo: keyed, state: keyedState };
  const repos = join(userDirectory("state"), "loom", "repos");
  const entries = existsSync(repos) ? readdirSync(repos) : [];
  for (const name of entries) {
    const recorded = readRepoRecord(join(repos, name, "repo.json"));
    if (recorded === old) return { repo: recorded, state: join(repos, name) };
  }
  if (keyed === null && existsSync(keyedState)) return { repo: old, state: keyedState };
  throw new Error(`no Loom state is recorded for ${old}`);
};

const sessionsIn = (db: string): number => {
  const handle = new DatabaseSync(db, { readOnly: true });
  try {
    return sessionCount(handle);
  } finally {
    handle.close();
  }
};

/** Rewrite `from`-prefixed workspace paths to `to`; returns the rows changed. */
const rewritePrefix = (db: DatabaseSync, from: string, to: string): number =>
  Number(
    db
      .prepare(
        "UPDATE sessions SET worktree = ?1 || substr(worktree, ?3) " +
          "WHERE worktree = ?2 OR substr(worktree, 1, ?3) = ?2 || '/'",
      )
      .run(to, from, from.length + 1).changes,
  );

export const moveRepository = async (oldArg: string, newArg: string): Promise<RepoMoveReport> => {
  const to = findRepoRoot(newArg);
  const { repo: from, state } = recordedRepository(resolve(oldArg));
  if (from === to) throw new Error(`${to} already owns this state`);
  // Not loomPaths(from): its key need no longer name the state recorded for it.
  const oldPaths = loomPathsOfState(from, state);
  const newPaths = loomPaths(to);
  if (oldPaths.state === newPaths.state)
    throw new Error(`${from} and ${to} name the same Loom state directory, ${state}`);
  if (!existsSync(oldPaths.state)) throw new Error(`${oldPaths.state} is gone; nothing was moved`);

  for (const paths of [oldPaths, newPaths]) {
    const pid = runningDaemonPid(paths);
    if (pid !== null)
      throw new Error(
        `a Loom daemon (pid ${pid}) is running for ${paths.repoRoot}; stop it with \`loom --repo ${paths.repoRoot} stop\` first`,
      );
  }
  const { vms } = await listVms(from);
  if (vms.length > 0)
    throw new Error(
      `${vms.length} session VM(s) of ${from} are still registered; stop them first (\`loom vm list\`, \`loom vm stop <id>\`)`,
    );
  if (existsSync(newPaths.db) && sessionsIn(newPaths.db) > 0)
    throw new Error(
      `${to} already has Loom sessions in ${newPaths.state}; move or remove that directory first`,
    );
  const moves: Array<[string, string]> = [
    [oldPaths.state, newPaths.state],
    [dirname(oldPaths.packageCache), dirname(newPaths.packageCache)],
    [sessionCloneRoot(from), sessionCloneRoot(to)],
    [repoBaseDirectory(from), repoBaseDirectory(to)],
  ];
  for (const [source, target] of moves.slice(2))
    if (existsSync(source) && existsSync(target) && readdirSync(target).length > 0)
      throw new Error(`${target} already exists; move or remove it first`);

  // A fresh state directory a client created at the new path holds no sessions.
  rmSync(newPaths.state, { recursive: true, force: true });
  rmSync(dirname(newPaths.packageCache), { recursive: true, force: true });
  const moved: string[] = [];
  for (const [source, target] of moves) {
    if (!existsSync(source)) continue;
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    renameSync(source, target);
    moved.push(`${source} -> ${target}`);
  }
  rmSync(oldPaths.runtime, { recursive: true, force: true });
  mkdirSync(newPaths.state, { recursive: true, mode: 0o700 });
  writeRepoRecord(newPaths.record, to);

  const worktrees: string[] = [];
  let sessionsUpdated = 0;
  if (existsSync(newPaths.db)) {
    const db = new DatabaseSync(newPaths.db);
    try {
      sessionsUpdated =
        rewritePrefix(db, from, to) +
        rewritePrefix(db, sessionCloneRoot(from), sessionCloneRoot(to));
      const rows = db.prepare("SELECT worktree FROM sessions WHERE worktree IS NOT NULL").all();
      for (const row of rows) {
        const path = String(row["worktree"]);
        // Session clones are no Git worktrees of the repository.
        if (existsSync(path) && !path.startsWith(sessionCloneRoot(to) + "/")) worktrees.push(path);
      }
    } finally {
      db.close();
    }
  }
  const notes: string[] = [];
  if (worktrees.length > 0) {
    const repair = spawnSync("git", ["-C", to, "worktree", "repair", ...worktrees], {
      encoding: "utf8",
    });
    if (repair.status !== 0)
      notes.push(`git worktree repair failed: ${repair.stderr.trim()}; run it in ${to}`);
  }

  // The moved hooks chain to the old checkout's own hooks: write them afresh.
  rmSync(newPaths.hooks, { recursive: true, force: true });
  const configured = (() => {
    try {
      return loadConfig(to).worktreeDir;
    } catch {
      return "";
    }
  })();
  const manager = new WorktreeManager({
    repoRoot: to,
    treesDir: worktreeDirectory(to, configured),
    hooksDir: newPaths.hooks,
    baseBranch: "",
    cloneRoot: sessionCloneRoot(to),
    log: makeLogger("repo-move"),
  });
  try {
    manager.ensureSetup();
    const stale = [
      ...manager.repointHooks(oldPaths.hooks),
      ...manager.repointHooks(join(oldPaths.legacy.dir, "hooks")),
    ];
    if (stale.length > 0)
      notes.push(
        `these worktrees still name the old hooks; set core.hooksPath to ${newPaths.hooks} in each: ${stale.join(", ")}`,
      );
  } catch (error) {
    notes.push(`could not regenerate the session hooks: ${String(error)}`);
  }
  rememberRepository(to);

  if (readConfigText().includes(from))
    notes.push(`${userConfigPath()} still names ${from} (repos[].path); update it to ${to}`);
  notes.push(
    `sessions that ran in ${from} itself (in place) may not resume their provider conversation: providers such as Claude Code key their history by working directory`,
    `session history keeps quoting ${from} where it did`,
  );
  return { from, to, moved, sessionsUpdated, worktreesRepaired: worktrees.length, notes };
};

const readConfigText = (): string => {
  try {
    return readFileSync(userConfigPath(), "utf8");
  } catch {
    return "";
  }
};

export const showRepoMoveReport = (r: RepoMoveReport): string =>
  [
    `moved Loom state from ${r.from} to ${r.to}`,
    ...r.moved.map((line) => `  ${line}`),
    `  ${r.sessionsUpdated} session path(s) updated, ${r.worktreesRepaired} worktree(s) repaired`,
    ...r.notes.map((note) => `note: ${note}`),
  ].join("\n") + "\n";
