import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { loomRuntimeDirectory, userDirectory } from "./user-dirs.ts";

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
 * Resolve Loom's repository identity. A bare repository and all its worktrees
 * share the common Git directory. Other checkouts keep their own worktree root.
 * Returns null outside Git, for config entries pointing at missing repositories.
 */
export const tryFindRepoRoot = (start: string): string | null => {
  const cwd = resolve(start);
  const git = (args: string[]) =>
    spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 15_000,
    });
  const common = git(["rev-parse", "--git-common-dir"]);
  if (common.status !== 0 || !common.stdout.trim()) return null;
  const commonDir = resolve(cwd, common.stdout.trim());
  // Query the main repository explicitly, not the invoking worktree, whose
  // own is-bare-repository is false even when it belongs to a bare repository.
  // Git also reads the main config.worktree after Loom's config migration.
  const bare = git(["--git-dir", commonDir, "rev-parse", "--is-bare-repository"]);
  if (bare.status === 0 && bare.stdout.trim() === "true") {
    return realpathSync(commonDir);
  }
  const top = git(["rev-parse", "--show-toplevel"]);
  return top.status === 0 && top.stdout.trim() ? realpathSync(top.stdout.trim()) : null;
};

export const findRepoRoot = (start: string = Deno.cwd()): string => {
  const root = tryFindRepoRoot(start);
  if (root) return root;
  throw new Error(
    `not inside a git repository (looked upward from ${resolve(start)}); run 'git init' first`,
  );
};

export interface LoomPaths {
  repoRoot: string;
  /** `<repoRoot>/.loom` */
  dir: string;
  /** `$XDG_RUNTIME_DIR/loom/<repo-key>`: socket and pidfile, private to the user. */
  runtime: string;
  /** Unix domain socket the daemon listens on. */
  sock: string;
  /** Pidfile guarding single-daemon-per-repo. */
  pid: string;
  /** Where Loom kept this repository's socket and pidfile before the XDG layout. */
  legacy: { sock: string; pid: string };
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

/** Longest socket path, without its NUL: `sun_path` is 104 bytes on macOS, 108 on Linux. */
const SOCKET_PATH_MAX_BYTES = Deno.build.os === "linux" ? 107 : 103;

/** `<name>-<hash>`: the repository's directory name in every per-user Loom directory. */
export const repoKey = (repoRoot: string): string => {
  let identity = resolve(repoRoot);
  try {
    identity = realpathSync(identity);
  } catch {
    // Paths are also used before a repository has been created.
  }
  const name =
    basename(identity)
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .slice(0, 48) || "repo";
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `${name}-${hash}`;
};

/** Resolve an exact configured directory, or a repository-specific XDG data path. */
export const worktreeDirectory = (
  repoRoot: string,
  configured = "",
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string => {
  const home = env["HOME"] || homedir();
  if (configured) {
    if (configured === "~") return home;
    if (configured.startsWith("~/")) return resolve(home, configured.slice(2));
    return resolve(repoRoot, configured);
  }
  return join(userDirectory("data", env), "loom", "worktrees", repoKey(repoRoot));
};

/** Throws when the daemon socket would not fit in `sun_path`. */
export const loomPaths = (
  repoRoot: string,
  configuredTrees = "",
  env: Record<string, string | undefined> = Deno.env.toObject(),
): LoomPaths => {
  const dir = join(repoRoot, ".loom");
  const runtime = join(loomRuntimeDirectory(env), repoKey(repoRoot));
  const sock = join(runtime, "daemon.sock");
  const sockBytes = new TextEncoder().encode(sock).length;
  if (sockBytes > SOCKET_PATH_MAX_BYTES)
    throw new Error(
      `The daemon socket path ${sock} is ${sockBytes} bytes, over the ${SOCKET_PATH_MAX_BYTES}-byte Unix socket limit. Set XDG_RUNTIME_DIR to a shorter directory.`,
    );
  return {
    repoRoot,
    dir,
    runtime,
    sock,
    pid: join(runtime, "daemon.pid"),
    legacy: { sock: join(dir, "daemon.sock"), pid: join(dir, "daemon.pid") },
    db: join(dir, "loom.db"),
    log: join(dir, "daemon.log"),
    tuiLog: join(dir, "tui.log"),
    tuiState: join(dir, "tui.json"),
    trees: worktreeDirectory(repoRoot, configuredTrees, env),
  };
};

/**
 * Create the repository's state and runtime directories. The runtime base may be
 * the shared `/tmp`, so it must be a real directory only this user can enter.
 * WorktreeManager creates its directory on demand.
 */
export const ensureLoomDir = (paths: LoomPaths): void => {
  mkdirSync(paths.dir, { recursive: true });
  const base = dirname(paths.runtime);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const info = lstatSync(base);
  if (!info.isDirectory() || info.uid !== Deno.uid() || (info.mode & 0o077) !== 0)
    throw new Error(
      `Refusing to use ${base} for the daemon socket: it must be a directory owned by this user with mode 0700.`,
    );
  mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
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
