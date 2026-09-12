/** Foreground, credential-free preparation. The published base is never writable. */
import { join, resolve } from "node:path";
import {
  claudeProfileId,
  loadConfig,
  type LoomConfig,
} from "../../backend/daemon/src/config/config.ts";
import { isClaudeId } from "../../core/src/provider-id.ts";
import { environmentEnabled } from "../../core/src/session-environment.ts";
import { launchSessionVm } from "../../backend/daemon/src/daemon/session-vm-worker.ts";
import { repoBaseDirectory, publishRepoBase } from "../../runtime/src/session-vm/repo-base.ts";
import { lockSessionState, SessionVmBusyError } from "../../runtime/src/session-vm/persistence.ts";
import { ipcPermissions } from "../../core/src/network-permissions.ts";
import { loomPaths } from "../../core/src/paths.ts";

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
    )
      return false;
    const policy = environmentPolicy(config, id);
    if (!policy || seen.has(policy.artifact)) return false;
    seen.add(policy.artifact);
    return true;
  });
};

const environmentPolicy = (config: LoomConfig, id: string) => {
  if (isClaudeId(id)) return config.isolation.claude;
  if (config.providers.aisdk[id]?.sdk === "chatgpt") return config.isolation.codex;
  return config.isolation.aisdk;
};

export const prepareRepoEnvironment = async (repo: string, provider?: string) => {
  const config = loadConfig(repo);
  const providers = provider ? [provider] : environmentProviders(config);
  if (!providers.length) throw new Error("No configured VM providers to prepare");
  for (const id of providers) await prepareProviderEnvironment(repo, id);
};

const prepareProviderEnvironment = async (repo: string, id: string) => {
  repo = await Deno.realPath(repo);
  const config = loadConfig(repo);
  if (!environmentEnabled(config.isolation.environment))
    throw new Error("Configure isolation.environment before preparing this repo");
  if (!isClaudeId(id) && !config.providers.aisdk[id]) throw new Error(`Unknown provider: ${id}`);
  const policy = environmentPolicy(config, id);
  if (!policy) throw new Error(`Provider ${id} has no configured session VM runtime`);
  const paths = policy.smolvm.includes("/")
    ? [resolve(policy.smolvm)]
    : (Deno.env.get("PATH") ?? "")
        .split(":")
        .filter(Boolean)
        .map((p) => join(p, policy.smolvm));
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
  const home = repoBaseDirectory(repo);
  await Deno.mkdir(home, { recursive: true, mode: 0o700 });
  // Separate from the brief publication lock: sessions may clone the old base
  // throughout a long preparation. Concurrent preparations fail immediately.
  const preparation = await lockSessionState(join(home, "preparation")).catch((error) => {
    if (error instanceof SessionVmBusyError)
      throw new Error("Repo environment preparation is already running");
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
    if (!result.success)
      throw new Error(`git ${args[0]} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
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
    phase(`Preparing ${repo} at ${revision.slice(0, 12)} for ${id}`);
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
      environment: config.isolation.environment!,
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
    if (code !== 0) throw new Error(`Environment preparation failed (exit ${code})`);
    phase("Saving prepared base…");
    await publishRepoBase(home, candidate, cancelled.signal, await Deno.realPath(policy.artifact));
    published = true;
    phase("Environment prepared. Idle sessions will update automatically; active turns continue.");
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
      if (vmStopped && candidate && !published) await Deno.remove(candidate, { recursive: true });
    } finally {
      preparation.close();
      Deno.removeSignalListener("SIGINT", stop);
      Deno.removeSignalListener("SIGTERM", stop);
    }
  }
};
