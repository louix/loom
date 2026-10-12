/**
 * The move of a repository's state out of `<repo>/.loom` when a daemon starts:
 * the database through a checkpointed, verified copy that falls back to the old
 * file on any failure, the logs, theme and package cache, the session hooks
 * every worktree names, and `.loom` itself once nothing unknown is left.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Logger } from "@loom/core/logger";
import { ensureLoomDirectories, loomPaths, type LoomPaths } from "@loom/core/paths";
import { removeLoomDirectories } from "../harness/src/loom-directories.ts";
import { openDb } from "@loom/daemon/store/db";
import { Daemon } from "@loom/daemon/daemon/daemon";
import { WorktreeManager } from "@loom/daemon/daemon/worktrees";
import { migrateLegacyState } from "../backend/daemon/src/daemon/legacy-state.ts";
import { makeLogger } from "@loom/core/logger";

interface Fixture {
  repo: string;
  paths: LoomPaths;
  config: string;
  remove: () => void;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const mkFixture = (): Fixture => {
  const repo = realpathSync(
    execFileSync("mktemp", ["-d", "/tmp/loom-legacy-XXXXXX"], { encoding: "utf8" }).trim(),
  );
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  const paths = loomPaths(repo);
  mkdirSync(paths.legacy.dir);
  const config = join(repo, ".git", "loom-test-config.jsonc");
  writeFileSync(config, "{}");
  return {
    repo,
    paths,
    config,
    remove: () => {
      removeLoomDirectories(paths);
      rmSync(repo, { recursive: true, force: true });
    },
  };
};

/**
 * A database as a daemon that crashed leaves it: rows only in the WAL. The
 * files are copied while the writer still holds them, before it can checkpoint.
 */
const writeLegacyDatabase = (paths: LoomPaths, sessions: number): void => {
  const scratch = join(paths.repoRoot, ".git", "scratch.db");
  const db = openDb(scratch);
  db.exec("PRAGMA wal_autocheckpoint = 0");
  const insert = db.prepare(
    "INSERT INTO sessions (id, provider, created_at, updated_at) VALUES (?, 'fake', 0, 0)",
  );
  for (let i = 0; i < sessions; i++) insert.run(`legacy-${i}`);
  const target = join(paths.legacy.dir, "loom.db");
  copyFileSync(scratch, target);
  copyFileSync(`${scratch}-wal`, `${target}-wal`);
  db.close();
};

const recordingLogger = (lines: string[]): Logger => {
  const log: Logger = {
    debug: () => {},
    info: (msg, fields) => void lines.push(`info ${msg} ${JSON.stringify(fields ?? {})}`),
    warn: (msg, fields) => void lines.push(`warn ${msg} ${JSON.stringify(fields ?? {})}`),
    error: (msg, fields) => void lines.push(`error ${msg} ${JSON.stringify(fields ?? {})}`),
    child: () => log,
  };
  return log;
};

const start = (f: Fixture): Promise<Daemon> =>
  Daemon.start({ repoRoot: f.repo, configFile: f.config, standalone: true, connectors: {} });

test("a daemon start moves the legacy database, checkpointing its WAL, and the rest of .loom", async () => {
  const f = mkFixture();
  try {
    writeLegacyDatabase(f.paths, 3);
    assert.ok(statSync(join(f.paths.legacy.dir, "loom.db-wal")).size > 0);
    const legacy = (name: string, text: string) =>
      writeFileSync(join(f.paths.legacy.dir, name), text);
    legacy("daemon.log", "old daemon log\n");
    legacy("tui.log", "old tui log\n");
    legacy("tui.json", '{"theme":"light"}');
    legacy("daemon-startup.log", "stale\n");
    legacy("daemon.pid", JSON.stringify({ pid: 999999999, epoch: "old", startedAt: 0 }));
    legacy("daemon.sock", "");
    mkdirSync(join(f.paths.legacy.dir, "package-cache", "deno"), { recursive: true });
    legacy("package-cache/deno/marker", "cached\n");
    mkdirSync(join(f.paths.legacy.dir, "trees"));

    const daemon = await start(f);
    try {
      assert.equal(daemon.registry.list().length, 3);
      assert.ok(existsSync(f.paths.db));
    } finally {
      await daemon.stop("test");
    }
    assert.match(readFileSync(f.paths.log, "utf8"), /^old daemon log\n/);
    assert.match(readFileSync(f.paths.log, "utf8"), /moved the database/);
    assert.equal(readFileSync(f.paths.tuiLog, "utf8"), "old tui log\n");
    assert.equal(readFileSync(f.paths.tuiState, "utf8"), '{"theme":"light"}');
    assert.equal(readFileSync(join(f.paths.packageCache, "deno", "marker"), "utf8"), "cached\n");
    assert.equal(existsSync(f.paths.legacy.dir), false);
  } finally {
    f.remove();
  }
});

test("unknown files keep .loom in place and are logged", async () => {
  const f = mkFixture();
  try {
    writeFileSync(join(f.paths.legacy.dir, "LOOM.md"), "# old instructions\n");
    writeFileSync(join(f.paths.legacy.dir, "notes.txt"), "mine\n");
    const daemon = await start(f);
    await daemon.stop("test");
    assert.ok(existsSync(join(f.paths.legacy.dir, "LOOM.md")));
    assert.ok(existsSync(join(f.paths.legacy.dir, "notes.txt")));
    const log = readFileSync(f.paths.log, "utf8");
    assert.match(log, /left in \.loom.*LOOM\.md.*AGENTS\.md/);
    assert.match(log, /left in \.loom.*notes\.txt.*Loom does not know it/);
  } finally {
    f.remove();
  }
});

test("a failed database copy keeps the old location, its files and its sessions", () => {
  const f = mkFixture();
  try {
    writeLegacyDatabase(f.paths, 2);
    ensureLoomDirectories(f.paths);
    chmodSync(f.paths.state, 0o500);
    const lines: string[] = [];
    const opened = (() => {
      try {
        return migrateLegacyState(f.paths, recordingLogger(lines));
      } finally {
        chmodSync(f.paths.state, 0o700);
      }
    })();
    const legacyDb = join(f.paths.legacy.dir, "loom.db");
    assert.equal(opened, legacyDb);
    assert.equal(existsSync(f.paths.db), false);
    assert.ok(
      lines.some((line) => /keeping the database in its old location/.test(line)),
      lines.join("\n"),
    );
    const db = new DatabaseSync(legacyDb, { readOnly: true });
    try {
      assert.equal((db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n, 2);
    } finally {
      db.close();
    }
  } finally {
    f.remove();
  }
});

test("a database in both locations: the new one is used, the old one kept", () => {
  const f = mkFixture();
  try {
    writeLegacyDatabase(f.paths, 1);
    ensureLoomDirectories(f.paths);
    openDb(f.paths.db).close();
    const lines: string[] = [];
    assert.equal(migrateLegacyState(f.paths, recordingLogger(lines)), f.paths.db);
    assert.ok(existsSync(join(f.paths.legacy.dir, "loom.db")));
    assert.ok(lines.some((line) => /exists in both locations/.test(line)));
  } finally {
    f.remove();
  }
});

test("worktrees that name the legacy hooks move to the regenerated ones", async () => {
  const f = mkFixture();
  try {
    const legacyHooks = join(f.paths.legacy.dir, "hooks");
    const old = new WorktreeManager({
      repoRoot: f.repo,
      treesDir: f.paths.trees,
      hooksDir: legacyHooks,
      baseBranch: "main",
      log: makeLogger("test"),
    });
    const tree = old.create("hooked");
    assert.equal(git(tree.path, "config", "core.hooksPath"), legacyHooks);

    const daemon = await start(f);
    await daemon.stop("test");
    assert.equal(git(tree.path, "config", "core.hooksPath"), f.paths.hooks);
    assert.ok(existsSync(join(f.paths.hooks, "pre-push")));
    assert.equal(existsSync(f.paths.legacy.dir), false);
  } finally {
    f.remove();
  }
});
