import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

/**
 * Is `cmd` runnable — an executable on `$PATH`, or an executable file if `cmd`
 * already contains a path separator? Used for best-effort tool fallbacks.
 */
export const onPath = (cmd: string, env: NodeJS.ProcessEnv = process.env): boolean => {
  const runnable = (p: string): boolean => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (cmd.includes("/") || cmd.includes("\\")) return runnable(cmd);
  const exts =
    process.platform === "win32" ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (dir && exts.some((ext) => runnable(join(dir, cmd + ext)))) return true;
  }
  return false;
};

/**
 * Walk up from `start` until a directory containing `.git` is found.
 * That directory is the repo root and the anchor for everything in `.loom/`.
 */
export const findRepoRoot = (start: string = process.cwd()): string => {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `not inside a git repository (looked upward from ${resolve(start)}); run 'git init' first`,
      );
    }
    dir = parent;
  }
};

export interface LoomPaths {
  repoRoot: string;
  /** `<repoRoot>/.loom` */
  dir: string;
  /** Unix domain socket the daemon listens on. */
  sock: string;
  /** Pidfile guarding single-daemon-per-repo. */
  pid: string;
  /** SQLite database. */
  db: string;
  /** Rolling daemon log. */
  log: string;
  /** TUI client log — one client per repo, truncated each launch. */
  tuiLog: string;
  /** TUI preference file — the persisted theme, read on boot / written on `t`. */
  tuiState: string;
  /** `<repoRoot>/.loom/config.toml` */
  config: string;
  /** Directory holding one git worktree per session. */
  trees: string;
}

export const loomPaths = (repoRoot: string): LoomPaths => {
  const dir = join(repoRoot, ".loom");
  return {
    repoRoot,
    dir,
    sock: join(dir, "daemon.sock"),
    pid: join(dir, "daemon.pid"),
    db: join(dir, "loom.db"),
    log: join(dir, "daemon.log"),
    tuiLog: join(dir, "tui.log"),
    tuiState: join(dir, "tui.json"),
    config: join(dir, "config.toml"),
    trees: join(dir, "trees"),
  };
};

/** Create `.loom/` (and `.loom/trees/`) if missing. */
export const ensureLoomDir = (paths: LoomPaths): void => {
  mkdirSync(paths.dir, { recursive: true });
  mkdirSync(paths.trees, { recursive: true });
};

/**
 * The repo's steering file: `<dir>/.loom/LOOM.md`. Operators record
 * repo-specific instructions there — init commands, how to typecheck, house
 * conventions — and the daemon injects the content into every session's
 * system prompt. Returns the framed block, or null when absent or empty.
 */
export const loomInstructions = (dir: string): string | null => {
  try {
    const md = readFileSync(join(dir, ".loom", "LOOM.md"), "utf8").trim();
    return md ? `# Repository instructions (.loom/LOOM.md)\n\n${md}` : null;
  } catch {
    return null; // no file (or unreadable) — nothing to inject
  }
};
