import { DatabaseSync } from "node:sqlite";
import { makeLogger } from "@loom/core/logger";
import { MIGRATIONS } from "./migrations.ts";

const log = makeLogger("store");

export type Db = DatabaseSync;

/**
 * Open (creating if needed) the Loom SQLite database, apply pending migrations,
 * and return the handle. Safe to call once per daemon process.
 */
export const openDb = (path: string): Db => {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);
  return db;
};

/** Databases with a `withTransaction` frame currently on the stack — guards
 *  against a nested call (SQLite has no nested `BEGIN`; no caller needs one). */
const inTransaction = new WeakSet<Db>();

/**
 * Run `fn` inside a single `BEGIN IMMEDIATE` … `COMMIT`, rolling back and
 * re-throwing if it throws. `IMMEDIATE` takes the write lock up front so two
 * daemons racing the same file serialise here instead of one hitting
 * `SQLITE_BUSY` mid-statement. Not re-entrant.
 */
export const withTransaction = <T>(db: Db, fn: () => T): T => {
  if (inTransaction.has(db)) {
    throw new Error("withTransaction is not re-entrant");
  }
  inTransaction.add(db);
  try {
    // Inside the try so a throwing BEGIN (e.g. SQLITE_BUSY past the busy_timeout)
    // still hits the `finally` that clears the re-entrancy guard.
    db.exec("BEGIN IMMEDIATE");
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // BEGIN never took, or SQLite already rolled back — nothing to undo
    }
    throw err;
  } finally {
    inTransaction.delete(db);
  }
};

const currentVersion = (db: Db): number => {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
};

const setVersion = (db: Db, v: number): void => {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(v));
};

export const migrate = (db: Db): void => {
  const from = currentVersion(db);
  if (from > MIGRATIONS.length) {
    // A newer build already migrated this file (a stale daemon racing a fresh
    // install, a downgrade, an older checkout). Running against a schema we
    // don't understand silently mis-reads every row — refuse instead.
    throw new Error(
      `loom.db is schema v${from} but this build only understands v${MIGRATIONS.length} — upgrade loom`,
    );
  }
  if (from === MIGRATIONS.length) return;
  for (let v = from; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v];
    if (sql === undefined) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-check under the write lock: another daemon opening the same file
      // could have applied this step between the read above and this BEGIN.
      if (currentVersion(db) !== v) {
        db.exec("ROLLBACK");
        continue;
      }
      db.exec(sql);
      setVersion(db, v + 1);
      db.exec("COMMIT");
      log.info("migration applied", { to: v + 1 });
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // SQLite may have already aborted the transaction
      }
      throw new Error(`migration ${v + 1} failed: ${(err as Error).message}`);
    }
  }
};

/** Flush the WAL back into the main db file. Called on clean shutdown. */
export const checkpoint = (db: Db): void => {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (err) {
    log.warn("wal checkpoint failed", { err: (err as Error).message });
  }
};
