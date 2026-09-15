import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

/**
 * Is `cmd` runnable — an executable on `$PATH`, or an executable file if `cmd`
 * already contains a path separator? Used for best-effort tool fallbacks.
 */
export const onPath = (
  cmd: string,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): boolean => {
  const runnable = (p: string): boolean => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (cmd.includes("/") || cmd.includes("\\")) return runnable(cmd);
  const exts = Deno.build.os === "windows" ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (dir && exts.some((ext) => runnable(join(dir, cmd + ext)))) return true;
  }
  return false;
};

/**
 * Ask Git for the current checkout root, or the git directory in a bare repo.
 * Linked worktrees keep their own root as the anchor for `.loom/`.
 */
export const findRepoRoot = (start: string = Deno.cwd()): string => {
  const git = (arg: string) =>
    spawnSync("git", ["-C", resolve(start), "rev-parse", arg], {
      encoding: "utf8",
      timeout: 15_000,
    });
  const top = git("--show-toplevel");
  if (top.status === 0 && top.stdout.trim()) return top.stdout.trim();
  const bare = git("--is-bare-repository");
  if (bare.status === 0 && bare.stdout.trim() === "true") {
    const dir = git("--absolute-git-dir");
    if (dir.status === 0 && dir.stdout.trim()) return dir.stdout.trim();
  }
  throw new Error(
    `not inside a git repository (looked upward from ${resolve(start)}); run 'git init' first`,
  );
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
