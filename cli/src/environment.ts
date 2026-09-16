/** Foreground, credential-free preparation. The published base is never writable. */
import { join, resolve } from "node:path";
import {
  claudeProfileId,
  loadConfig,
  type LoomConfig,
} from "../../backend/daemon/src/config/config.ts";
import { isClaudeId } from "../../core/src/provider-id.ts";
import { environmentEnabled } from "../../core/src/session-environment.ts";
import { detectNixActivation } from "../../core/src/nix-activation.ts";
import { launchSessionVm } from "../../backend/daemon/src/daemon/session-vm-worker.ts";
import {
  pruneRepoBases,
  publishRepoBase,
  repoBaseDirectory,
} from "../../runtime/src/session-vm/repo-base.ts";
import { lockSessionState, SessionVmBusyError } from "../../runtime/src/session-vm/persistence.ts";
import { ipcPermissions } from "../../core/src/network-permissions.ts";
import { inspectArtifact } from "../../runtime/src/packaged/artifact.ts";
import { loomPaths } from "../../core/src/paths.ts";
import { pruneRuntimeCaches } from "./maintenance.ts";
import { pruneRepositorySessionDisks } from "../../backend/daemon/src/daemon/session-vm-state.ts";

/** Called while Ink has suspended terminal ownership. Keep one CLI output path. */
export const prepareEnvironmentInTerminal = async (
  entry: string,
  repo: string,
): Promise<number> => {
  let child: Deno.ChildProcess | undefined;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    try {
      child?.kill("SIGINT");
    } catch {
      /* already stopped */
    }
  };
  Deno.addSignalListener("SIGINT", interrupt);
  try {
    child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--cached-only",
        "--frozen",
        "--node-modules-dir=manual",
        ...ipcPermissions(loomPaths(repo).sock),
        entry,
        "--repo",
        repo,
        "environment",
        "prepare",
      ],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const result = await child.status;
    if (interrupted) return 130;
    // A short-lived reader owns stdin; no pending read can steal Ink's next key.
    child = new Deno.Command("/bin/sh", {
      args: ["-c", "printf '\\nPress Enter to return to Loom.\\n'; read -r loom_return"],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    await child.status;
    return interrupted ? 130 : result.code;
  } finally {
    Deno.removeSignalListener("SIGINT", interrupt);
  }
};

export const environmentProviders = (config: LoomConfig): string[] => {
  const providers = [
    ...config.claudeProfiles.map(claudeProfileId),
    ...Object.keys(config.providers.aisdk),
  ];
  const seen = new Set<string>();
  return providers.filter((id) => {
    if (
      config.providerAccess.disabled.includes(id) ||
      (config.providerAccess.only && !config.providerAccess.only.includes(id))
    ) {
      return false;
    }
    const policy = environmentPolicy(config, id);
    if (!policy || seen.has(policy.artifact)) return false;
    seen.add(policy.artifact);
    return true;
  });
};

const environmentPolicy = (config: LoomConfig, id: string) => {
  let kind: "claude" | "codex" | "aisdk" = "aisdk";
  if (isClaudeId(id)) kind = "claude";
  else if (config.providers.aisdk[id]?.sdk === "chatgpt") kind = "codex";
  return config.isolation[kind];
};

/** Preparation needs runtime images, independent of provider access and session defaults. */
export const environmentPreparationRuntimes = (config: LoomConfig) => {
  const seen = new Set<string>();
  return [
    config.isolation.claude,
    config.isolation.codex,
    config.isolation.aisdk,
    ...Object.values(config.isolation.runtimes ?? {}),
  ].filter((policy): policy is { artifact: string; smolvm: string } => {
    if (!policy || seen.has(policy.artifact)) return false;
    seen.add(policy.artifact);
    return true;
  });
};

export const prepareRepoEnvironment = async (repo: string) => {
  repo = await Deno.realPath(repo);
  const config = loadConfig(repo);
  if (
    !detectNixActivation(repo, config.autoNix, true) &&
    !config.isolation.environment?.commandPrefix.length &&
    !config.isolation.environment?.prepare
  ) {
    const reason = config.autoNix
      ? "No devenv.nix, flake.nix, shell.nix or default.nix found at the repository root in committed HEAD (also used for bare repos)."
      : "Nix auto-activation is disabled (session.auto_nix).";
    throw new Error(
      `No session environment found. ${reason} Enable session.auto_nix for a project shell, or configure an advanced preparation command.`,
    );
  }
  const runtimes = environmentPreparationRuntimes(config);
  if (!runtimes.length) {
    throw new Error("No session VM runtime images available to prepare");
  }
  for (const policy of runtimes) {
    await prepareRuntimeEnvironment(repo, config, policy);
  }
  await pruneRepoEnvironment(repo).catch((error) =>
    console.error(
      `Environment prepared; cleanup deferred: ${error instanceof Error ? error.message : error}`,
    ),
  );
};

const prepareRuntimeEnvironment = async (
  repo: string,
  config: LoomConfig,
  policy: { artifact: string; smolvm: string },
) => {
  const smolvm = await resolveEnvironmentBackend(policy.smolvm);
  const home = repoBaseDirectory(repo);
  await Deno.mkdir(home, { recursive: true, mode: 0o700 });
  // Separate from the brief publication lock: sessions may clone the old base
  // throughout a long preparation. Concurrent preparations fail immediately.
  const preparation = await lockSessionState(join(home, "preparation")).catch((error) => {
    if (error instanceof SessionVmBusyError) {
      throw new Error("Repo environment preparation is already running");
    }
    throw error;
  });
  const cancelled = new AbortController();
  let worker: Awaited<ReturnType<typeof launchSessionVm>> | undefined;
  const stop = () => {
    cancelled.abort();
    worker?.terminate();
  };
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);
  const started = performance.now();
  const phase = (text: string) =>
    console.error(`[${((performance.now() - started) / 1000).toFixed(1)}s] ${text}`);
  let candidate: string | undefined, temporary: string | undefined;
  let published = false,
    vmStopped = true;
  const git = async (args: string[], signal?: AbortSignal) => {
    const result = await new Deno.Command("git", {
      args: ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", repo, ...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      ...(signal ? { signal } : {}),
    }).output();
    if (!result.success) {
      throw new Error(`git ${args[0]} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
    }
    return new TextDecoder().decode(result.stdout).trim();
  };
  const removeWorktree = async (workspace: string) => {
    try {
      await Deno.stat(join(workspace, ".git"));
      await git(["worktree", "remove", "--force", workspace]);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  try {
    const revision = await git(["rev-parse", "HEAD"], cancelled.signal);
    phase(`Preparing session environment for ${repo} at ${revision.slice(0, 12)}`);
    phase("Creating disposable worktree (committed HEAD)…");
    temporary = await Deno.realPath(
      await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-prepare-" }),
    );
    const workspace = join(temporary, "worktree");
    await git(["worktree", "add", "--detach", workspace, revision], cancelled.signal);
    candidate = await Deno.makeTempDir({ dir: home, prefix: "base-" });
    cancelled.signal.throwIfAborted();
    worker = await launchSessionVm({
      workspace,
      artifact: policy.artifact,
      smolvm,
      repoRoot: repo,
      sessionDirectory: candidate,
      preparationOnly: true,
      auth: {},
      providerHosts: [],
      ...(config.isolation.environment ? { environment: config.isolation.environment } : {}),
      extraAllowedHosts: config.isolation.extraAllowedHosts,
    });
    vmStopped = false;
    if (cancelled.signal.aborted) worker.terminate();
    await Promise.all([
      worker.output.pipeTo(Deno.stdout.writable, { preventClose: true }),
      worker.diagnostics!.pipeTo(Deno.stderr.writable, { preventClose: true }),
    ]);
    const code = await worker.exitCode;
    await worker.cleanup!();
    vmStopped = true;
    cancelled.signal.throwIfAborted();
    if (code !== 0) {
      throw new Error(`Environment preparation failed (exit ${code})`);
    }
    phase("Saving prepared cache…");
    await publishRepoBase(home, candidate, cancelled.signal, await Deno.realPath(policy.artifact));
    published = true;
    phase("Cache prepared. Sessions will activate their checkout using the cached dependencies.");
  } catch (error) {
    phase(
      cancelled.signal.aborted
        ? "Preparation cancelled; previous base retained."
        : "Preparation failed; previous base retained.",
    );
    throw error;
  } finally {
    try {
      if (worker && !vmStopped) {
        worker.terminate();
        await worker.cleanup!();
        vmStopped = true;
      }
      if (vmStopped && temporary) {
        const workspace = join(temporary, "worktree");
        await removeWorktree(workspace);
        await Deno.remove(temporary, { recursive: true });
      }
      if (vmStopped && candidate && !published) {
        await Deno.remove(candidate, { recursive: true });
      }
    } finally {
      preparation.close();
      Deno.removeSignalListener("SIGINT", stop);
      Deno.removeSignalListener("SIGTERM", stop);
    }
  }
};

const resolveEnvironmentBackend = async (executable: string): Promise<string> => {
  const paths = executable.includes("/")
    ? [resolve(executable)]
    : (Deno.env.get("PATH") ?? "")
        .split(":")
        .filter(Boolean)
        .map((p) => join(p, executable));
  let smolvm: string | undefined;
  for (const path of paths) {
    try {
      if ((await Deno.stat(path)).isFile) {
        smolvm = await Deno.realPath(path);
        break;
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  if (!smolvm) throw new Error("Configured smolvm executable was not found");
  return smolvm;
};

/** Launch-time preflight: no VM, fetching or preparation; only enabled VM providers. */
export const repoEnvironmentWarning = async (
  repo: string,
  configured?: LoomConfig,
): Promise<string | null> => {
  try {
    const config = configured ?? loadConfig(repo);
    if (!environmentEnabled(config.isolation.environment)) return null;
    let missing = false;
    for (const id of environmentProviders(config)) {
      const policy = environmentPolicy(config, id)!;
      try {
        const artifact = await Deno.realPath(policy.artifact);
        await resolveEnvironmentBackend(policy.smolvm);
        const manifest = await inspectArtifact(artifact);
        const version = (
          await Deno.readTextFile(join(artifact, "session-environment-version"))
        ).trim();
        if (!manifest.environmentCompatibility || version !== "5") {
          missing = true;
        }
      } catch {
        missing = true;
      }
    }
    return missing ? "Environment image missing or out of date." : null;
  } catch (error) {
    return `Could not check environment image: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
};

/** Explicit and post-preparation collection, scoped to this repo's configured images. */
export const pruneRepoEnvironment = async (repo: string) => {
  repo = await Deno.realPath(repo);
  const config = loadConfig(repo);
  const bindings = [];
  for (const policy of [
    config.isolation.claude,
    config.isolation.codex,
    config.isolation.aisdk,
    ...Object.values(config.isolation.runtimes ?? {}),
  ]) {
    if (!policy) continue;
    bindings.push({
      artifact: await Deno.realPath(policy.artifact),
      smolvm: await resolveEnvironmentBackend(policy.smolvm),
      writableNix: environmentEnabled(config.isolation.environment),
    });
  }
  const sessions = await pruneRepositorySessionDisks(repo);
  const bases = await pruneRepoBases(repoBaseDirectory(repo), bindings);
  const caches = await pruneRuntimeCaches(repo);
  return { ...bases, ...caches, ...sessions };
};
