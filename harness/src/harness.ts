import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorManifest } from "@loom/core/connector";
import { loomPaths } from "@loom/core/paths";
import { setLogLevel } from "@loom/core/logger";
import { Daemon, type DaemonStartOptions } from "@loom/daemon/daemon/daemon";

/** Every connector, for a harness daemon that may exercise any provider. */
const CONNECTORS: ConnectorManifest = {
  "@loom/connector-mock": () => import("@loom/connector-mock"),
  "@loom/connector-claude": () => import("@loom/connector-claude"),
  "@loom/connector-generic": () => import("@loom/connector-generic"),
  "@loom/connector-gemini": () => import("@loom/connector-gemini"),
};

setLogLevel("error"); // keep test output quiet

// Isolate the user-level config: without this, the developer's real
// ~/.config/loom/config.jsonc is deep-merged into every harness daemon (extra
// providers, live credentials, start-up network probes). Point XDG at an empty
// dir; each harness also supplies its own trusted config file.
Deno.env.set("XDG_CONFIG_HOME", mkdtempSync(join(tmpdir(), "loom-xdg-")));

export interface Harness {
  repoRoot: string;
  configPath: string;
  sockPath: string;
  daemon: Daemon;
  restart(): Promise<Daemon>;
  cleanup(): Promise<void>;
}

/** A throwaway git repo with a standalone daemon running against it. */
export const makeHarness = async (
  opts: {
    git?: boolean;
    config?: string;
    connectors?: ConnectorManifest;
    guestCommand?: DaemonStartOptions["guestCommand"];
  } = {},
): Promise<Harness> => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loom-h-"));
  const configDir = mkdtempSync(join(tmpdir(), "loom-h-config-"));
  const configPath = join(configDir, "config.jsonc");
  writeFileSync(configPath, opts.config ?? "{}");
  if (opts.git !== false) {
    execFileSync("git", ["init", "-q", "-b", "main", repoRoot]);
    execFileSync("git", ["-C", repoRoot, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.name", "t"]);
    // Don't inherit a machine-wide commit.gpgsign — gpg has no TTY here.
    execFileSync("git", ["-C", repoRoot, "config", "commit.gpgsign", "false"]);
    execFileSync("git", ["-C", repoRoot, "config", "tag.gpgsign", "false"]);
    // A base commit so per-session `git worktree add -b … main` has a ref.
    execFileSync("git", ["-C", repoRoot, "commit", "-q", "--allow-empty", "-m", "base"]);
  }
  const { sock } = loomPaths(repoRoot);

  let daemon = await Daemon.start({
    repoRoot,
    configFile: configPath,
    ...(opts.guestCommand ? { guestCommand: opts.guestCommand } : {}),
    standalone: true,
    connectors: opts.connectors ?? CONNECTORS,
  });

  const h: Harness = {
    repoRoot,
    configPath,
    sockPath: sock,
    get daemon() {
      return daemon;
    },
    async restart() {
      await daemon.stop("test-restart");
      daemon = await Daemon.start({
        repoRoot,
        configFile: configPath,
        ...(opts.guestCommand ? { guestCommand: opts.guestCommand } : {}),
        standalone: true,
        connectors: opts.connectors ?? CONNECTORS,
      });
      return daemon;
    },
    async cleanup() {
      await daemon.stop("test-cleanup").catch(() => {});
      rmSync(configDir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    },
  } as Harness;
  return h;
};
