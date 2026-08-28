import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon.ts";
import { loomPaths } from "../src/util/paths.ts";
import { setLogLevel } from "../src/util/logger.ts";

setLogLevel("error"); // keep test output quiet

export interface Harness {
  repoRoot: string;
  sockPath: string;
  daemon: Daemon;
  restart(): Promise<Daemon>;
  cleanup(): Promise<void>;
}

/** A throwaway git repo with a standalone daemon running against it. */
export async function makeHarness(opts: { git?: boolean; config?: string } = {}): Promise<Harness> {
  const repoRoot = mkdtempSync(join(tmpdir(), "loom-h-"));
  if (opts.config !== undefined) {
    mkdirSync(join(repoRoot, ".loom"), { recursive: true });
    writeFileSync(join(repoRoot, ".loom", "config.toml"), opts.config);
  }
  if (opts.git !== false) {
    execFileSync("git", ["init", "-q", "-b", "main", repoRoot]);
    execFileSync("git", ["-C", repoRoot, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.name", "t"]);
    // A base commit so per-session `git worktree add -b … main` has a ref.
    execFileSync("git", ["-C", repoRoot, "commit", "-q", "--allow-empty", "-m", "base"]);
  }
  const { sock } = loomPaths(repoRoot);

  let daemon = await Daemon.start({ repoRoot, standalone: true });

  const h: Harness = {
    repoRoot,
    sockPath: sock,
    get daemon() {
      return daemon;
    },
    async restart() {
      await daemon.stop("test-restart");
      daemon = await Daemon.start({ repoRoot, standalone: true });
      return daemon;
    },
    async cleanup() {
      await daemon.stop("test-cleanup").catch(() => {});
      rmSync(repoRoot, { recursive: true, force: true });
    },
  } as Harness;
  return h;
}
