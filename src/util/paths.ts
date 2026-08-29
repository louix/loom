import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The user-level config file, layered *under* the per-repo `.loom/config.toml`.
 * `$XDG_CONFIG_HOME/loom/config.toml`, falling back to `~/.config/loom/config.toml`.
 * Provider profiles, credentials (env-var names), and keybindings live here;
 * the per-repo file overrides model defaults, base branch, `[[mcp]]`, etc.
 */
export function userConfigPath(): string {
  const base = process.env["XDG_CONFIG_HOME"]?.trim() || join(homedir(), ".config");
  return join(base, "loom", "config.toml");
}

/**
 * Walk up from `start` until a directory containing `.git` is found.
 * That directory is the repo root and the anchor for everything in `.loom/`.
 */
export function findRepoRoot(start: string = process.cwd()): string {
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
}

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
  /** `<repoRoot>/.loom/config.toml` */
  config: string;
  /** Directory holding one git worktree per session. */
  trees: string;
}

export function loomPaths(repoRoot: string): LoomPaths {
  const dir = join(repoRoot, ".loom");
  return {
    repoRoot,
    dir,
    sock: join(dir, "daemon.sock"),
    pid: join(dir, "daemon.pid"),
    db: join(dir, "loom.db"),
    log: join(dir, "daemon.log"),
    config: join(dir, "config.toml"),
    trees: join(dir, "trees"),
  };
}

/** Create `.loom/` (and `.loom/trees/`) if missing. */
export function ensureLoomDir(paths: LoomPaths): void {
  mkdirSync(paths.dir, { recursive: true });
  mkdirSync(paths.trees, { recursive: true });
}
