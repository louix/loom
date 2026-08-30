import { accessSync, constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

/**
 * Is `cmd` runnable — an executable on `$PATH`, or an executable file if `cmd`
 * already contains a path separator? Used for best-effort tool fallbacks.
 */
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const runnable = (p: string): boolean => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (cmd.includes("/") || cmd.includes("\\")) return runnable(cmd);
  const exts = process.platform === "win32" ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (dir && exts.some((ext) => runnable(join(dir, cmd + ext)))) return true;
  }
  return false;
}

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

/** The `config.example.toml` shipped alongside the source. */
export function exampleConfigPath(): string {
  return join(import.meta.dirname, "..", "..", "config.example.toml");
}

/**
 * First-run convenience: drop a copy of `config.example.toml` at
 * {@link userConfigPath} when nothing is there yet, so `loom` has an obvious,
 * annotated place to configure providers. Never overwrites an existing file.
 * Returns the path when it created one, `null` otherwise (already present, or
 * the example couldn't be read).
 */
export function scaffoldUserConfig(): string | null {
  const dest = userConfigPath();
  if (existsSync(dest)) return null;
  const src = exampleConfigPath();
  if (!existsSync(src)) return null;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return dest;
  } catch {
    return null;
  }
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
