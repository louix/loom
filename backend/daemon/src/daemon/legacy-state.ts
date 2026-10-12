/**
 * The one-time move of a repository's Loom state out of `<repo>/.loom`, where
 * versions before the XDG layout kept it, run by a daemon that owns the
 * repository (no older daemon still serving from there). Each piece moves on
 * its own; the database stays where it is on any doubt. `.loom` itself goes
 * once nothing is left in it — anything Loom does not know stays, and is logged.
 */
import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import type { Logger } from "@loom/core/logger";
import type { LoomPaths } from "@loom/core/paths";
import { legacyDaemonPid } from "@loom/core/daemon-endpoint";
import type { WorktreeManager } from "./worktrees.ts";

/** Why a leftover in `.loom` stays, for the ones Loom knows. */
const LEFTOVERS: Record<string, string> = {
  "loom.db": "the new location already has a database; this older one is kept, not merged",
  trees: "session worktrees from an older version still live there",
  "LOOM.md": "Loom no longer reads it; agents see the repository's AGENTS.md instead",
  "models.toml": "Loom no longer reads it; providers' reported and advertised prices apply",
  "config.jsonc": "Loom never read a repository-local config; use ~/.config/loom/config.jsonc",
};

const legacyFile = (paths: LoomPaths, name: string): string => join(paths.legacy.dir, name);

/** Rename `from` to `to` unless `to` exists; true when `from` is gone afterwards. */
const moveIfAbsent = (from: string, to: string): boolean => {
  if (!existsSync(from)) return true;
  if (existsSync(to)) return false;
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    if (statSync(from).isDirectory()) return false;
    copyFileSync(from, to);
    rmSync(from);
  }
  return true;
};

/** Logs and the theme: the new location wins when both exist. */
const moveOrDrop = (from: string, to: string): void => {
  if (!moveIfAbsent(from, to)) rmSync(from, { force: true });
};

/** Move the old daemon log into place before the logger opens the new one. */
export const adoptLegacyLog = (paths: LoomPaths): void => {
  if (legacyDaemonPid(paths) !== null) return;
  try {
    moveIfAbsent(legacyFile(paths, "daemon.log"), paths.log);
  } catch {
    // The rest of the migration logs whatever is still in the way.
  }
};

/** Session rows, or 0 for a database no daemon has migrated yet. */
const sessionCount = (db: DatabaseSync): number => {
  const table = db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
    .get() as { n: number };
  if (table.n === 0) return 0;
  return (db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n;
};

const removeDatabaseFiles = (path: string): void => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(path + suffix, { force: true });
};

/**
 * Copy the legacy database to `to` and verify the copy before removing the old
 * files. Returns the database the daemon should open: the old one when any step
 * fails, so a failed migration loses nothing and is retried on the next start.
 */
const migrateDatabase = (from: string, to: string, log: Logger): string => {
  if (!existsSync(from)) return to;
  if (existsSync(to)) {
    // A verified copy is only ever renamed into place, so this one is complete.
    log.warn("a database exists in both locations; using the new one", { legacy: from, db: to });
    return to;
  }
  const staging = `${to}.migrating`;
  try {
    const old = new DatabaseSync(from);
    let sessions: number;
    try {
      // Nothing else holds the file: the WAL folds into it completely.
      const { busy } = old.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
      if (busy !== 0) throw new Error("the database is busy");
      sessions = sessionCount(old);
    } finally {
      old.close();
    }
    if (existsSync(`${from}-wal`) && statSync(`${from}-wal`).size > 0)
      throw new Error("the write-ahead log was not checkpointed");
    removeDatabaseFiles(staging);
    copyFileSync(from, staging);
    const copy = new DatabaseSync(staging);
    try {
      const check = copy.prepare("PRAGMA quick_check").get() as { quick_check: string };
      if (check.quick_check !== "ok")
        throw new Error(`the copy fails quick_check: ${check.quick_check}`);
      const copied = sessionCount(copy);
      if (copied !== sessions)
        throw new Error(`the copy has ${copied} sessions, the original ${sessions}`);
    } finally {
      copy.close();
    }
    renameSync(staging, to);
    log.info("moved the database", { from, to, sessions });
  } catch (error) {
    try {
      removeDatabaseFiles(staging);
    } catch {
      // A leftover staging copy is replaced on the next attempt.
    }
    log.warn("keeping the database in its old location", { db: from, error: String(error) });
    return from;
  }
  try {
    removeDatabaseFiles(from);
  } catch (error) {
    log.warn("could not remove the old database", { db: from, error: String(error) });
  }
  return to;
};

/** A cache: moved when it can be renamed, otherwise dropped and rebuilt on demand. */
const migratePackageCache = (paths: LoomPaths, log: Logger): void => {
  const from = legacyFile(paths, "package-cache");
  if (!existsSync(from)) return;
  if (moveIfAbsent(from, paths.packageCache)) {
    log.info("moved the package cache", { from, to: paths.packageCache });
    return;
  }
  // Package managers leave read-only directories behind.
  spawnSync("chmod", ["-R", "u+w", from]);
  rmSync(from, { recursive: true, force: true });
  log.info("dropped the old package cache; it refills on demand", { from });
};

/** Session state beside the database. Returns the database path to open. */
export const migrateLegacyState = (paths: LoomPaths, log: Logger): string => {
  if (!existsSync(paths.legacy.dir)) return paths.db;
  const db = legacyFile(paths, "loom.db");
  if (legacyDaemonPid(paths) !== null) {
    log.warn("an older daemon still runs from the repository; not migrating", {
      dir: paths.legacy.dir,
    });
    return !existsSync(paths.db) && existsSync(db) ? db : paths.db;
  }
  const opened = migrateDatabase(db, paths.db, log);
  const steps: Array<[string, () => void]> = [
    // No daemon runs from there: these name nobody.
    ["daemon.sock", () => rmSync(paths.legacy.sock, { force: true })],
    ["daemon.pid", () => rmSync(paths.legacy.pid, { force: true })],
    ["daemon-startup.log", () => rmSync(legacyFile(paths, "daemon-startup.log"), { force: true })],
    ["daemon.log", () => moveOrDrop(legacyFile(paths, "daemon.log"), paths.log)],
    ["tui.log", () => moveOrDrop(legacyFile(paths, "tui.log"), paths.tuiLog)],
    ["tui.json", () => moveOrDrop(legacyFile(paths, "tui.json"), paths.tuiState)],
    ["package-cache", () => migratePackageCache(paths, log)],
  ];
  for (const [name, step] of steps) {
    try {
      step();
    } catch (error) {
      log.warn("could not migrate legacy state", {
        path: legacyFile(paths, name),
        error: String(error),
      });
    }
  }
  return opened;
};

/**
 * Regenerate the push-blocking hooks in the state directory, repoint the
 * worktrees that name the old ones, and remove `.loom` if nothing is left.
 * The old hooks stay until every worktree has moved off them.
 */
export const finishLegacyMigration = (
  paths: LoomPaths,
  worktrees: WorktreeManager,
  log: Logger,
): void => {
  if (!existsSync(paths.legacy.dir) || legacyDaemonPid(paths) !== null) return;
  const hooks = legacyFile(paths, "hooks");
  if (existsSync(hooks)) {
    try {
      worktrees.ensureSetup();
      const failed = worktrees.repointHooks(hooks);
      if (failed.length === 0) {
        rmSync(hooks, { recursive: true, force: true });
        log.info("moved the session hooks", { from: hooks, to: paths.hooks });
      } else log.warn("some worktrees still use the old hooks; keeping them", { hooks, failed });
    } catch (error) {
      log.warn("could not move the session hooks", { hooks, error: String(error) });
    }
  }
  const trees = legacyFile(paths, "trees");
  try {
    if (existsSync(trees) && readdirSync(trees).length === 0) rmdirSync(trees);
  } catch (error) {
    log.warn("could not remove the old worktree directory", { trees, error: String(error) });
  }
  let left: string[];
  try {
    left = readdirSync(paths.legacy.dir);
  } catch {
    return;
  }
  if (left.length === 0) {
    try {
      rmdirSync(paths.legacy.dir);
      log.info("removed the repository's .loom directory", { dir: paths.legacy.dir });
    } catch (error) {
      log.warn("could not remove .loom", { dir: paths.legacy.dir, error: String(error) });
    }
    return;
  }
  for (const name of left)
    log.warn("left in .loom", {
      path: legacyFile(paths, name),
      reason: LEFTOVERS[name] ?? "Loom does not know it",
    });
};
