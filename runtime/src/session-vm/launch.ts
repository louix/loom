import {
  environmentEnabled,
  type SessionEnvironment,
} from "../../../core/src/session-environment.ts";
import { registerVm, type VmOwner, type VmRecord } from "./inventory.ts";
import {
  VmTerminationError,
  vmTerminationMessage,
  vmTerminationSchema,
  type VmTermination,
  type HostStopReason,
} from "../../../core/src/vm-termination.ts";
import { relayDiagnosticMessage } from "../../../core/src/relay-diagnostic.ts";
import { normalizeExtraHosts } from "./network-policy.ts";
/** Supervised VM launch and persistent resource ownership, for environments and preparation. */
import { join } from "node:path";
import { repoCacheDirectory } from "../../../core/src/paths.ts";
import { fileURLToPath } from "node:url";
import { inspectArtifact } from "../packaged/artifact.ts";
import { vmMaintenanceLock } from "../packaged/maintenance.ts";
import { readRecovery, recoverSessionVm } from "./recovery.ts";
import { finishSessionState, lockSessionState } from "./persistence.ts";
import { workspaceMount } from "./workspace.ts";
import { guestWorkingDirectory } from "../packaged/vm.ts";
import { workspaceMounts } from "../packaged/workspace.ts";
import { reapVm, type VmBinding } from "../packaged/vm.ts";
import { cleanupSessionVm } from "./cleanup.ts";
import { prepareCloneBinding, type SessionClone } from "./clone.ts";
import {
  readStartupProgress,
  startupMessage,
  startupFailures,
  type StartupStage,
} from "./progress.ts";
import { repoBaseDirectory } from "./repo-base.ts";
import type { ManagedProcess } from "../process.ts";
import { sessionAuth, writeSessionAuth, type SessionAuth } from "./auth.ts";

export interface SessionVmOptions {
  prepareHooks?: import("../../../core/src/init-hook.ts").InitHook[];
  sessionId?: string;
  provider?: string;
  onStop?: (isCurrent: () => boolean) => Promise<void>;
  activity?: () => string;
  onProgress?: (message: string, termination?: VmTermination) => void;
  workspace: string;
  artifact: string;
  smolvm: string;
  auth?: SessionAuth;
  /** Shared by sessions using the same provider profile; caller owns its lifetime. */
  authOwner?: {
    current(force?: boolean): Promise<SessionAuth>;
    subscribe(
      write: (value: SessionAuth) => Promise<void>,
      expired: () => void,
    ): Promise<() => Promise<void>>;
  };
  extraAllowedHosts?: string[];
  environment?: SessionEnvironment;
  providerHosts?: string[];
  sessionDirectory?: string;
  /** Foreground repo preparation: no provider capabilities, raw setup output. */
  preparationOnly?: boolean;
  /** Initialize the guest and keep it alive for commands, without a connector worker. */
  environmentOnly?: boolean;
  repoRoot?: string;
  mcpRelays?: Array<{ port: number; guestPort: number }>;
  /** Work in a private clone served by the Git relay instead of mounting the repository. */
  clone?: SessionClone;
  privateWorkspace?: string;
  /** `GIT_AUTHOR_*` / `GIT_COMMITTER_*` for the guest worker and its shells. */
  gitIdentity?: Record<string, string>;
}
export interface SessionVmStatus {
  phase: string;
  backendDirectory?: string | null;
  execPid?: number;
  network: Array<{ host: string; allowed: boolean }>;
}

const remove = async (path: string) => {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
};
/** Agent sessions reach this provider unless their launcher names others. */
export const defaultProviderHosts = ["api.anthropic.com"];
/**
 * Standalone environment protocol of a session runtime; 0 when absent.
 * 1: environment guests report readiness. 2: they also run guest-worker.ts executions.
 */
export const environmentRuntimeVersion = async (artifact: string): Promise<number> => {
  try {
    const value = (
      await Deno.readTextFile(join(artifact, "standalone-environment-version"))
    ).trim();
    return /^[1-9][0-9]{0,3}$/.test(value) ? Number(value) : 0;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    throw error;
  }
};
const launchSessionVmOwned = async (
  options: SessionVmOptions,
): Promise<
  ManagedProcess & {
    binding: VmBinding;
    status(): Promise<SessionVmStatus>;
    exitCode: Promise<number>;
    diagnostics?: ReadableStream<Uint8Array>;
  }
> => {
  const extraAllowedHosts = normalizeExtraHosts(options.extraAllowedHosts);
  if (
    options.preparationOnly &&
    (options.authOwner || Object.keys(options.auth ?? {}).length || options.mcpRelays?.length)
  )
    throw new Error("Repo preparation must not receive provider credentials or MCP endpoints");
  if (options.auth && options.authOwner)
    throw new Error("Choose static auth or a credential owner");
  if (options.preparationOnly && options.environmentOnly)
    throw new Error("Choose repo preparation or an environment, not both");
  // Agent workers run as executions inside an environment (see isolated-worker.ts).
  if (!options.preparationOnly && !options.environmentOnly)
    throw new Error("Session VMs launch an environment or repo preparation");
  const artifact = await Deno.realPath(options.artifact);
  const smolvm = await Deno.realPath(options.smolvm);
  const auth = sessionAuth(
    options.authOwner ? await options.authOwner.current() : (options.auth ?? {}),
  );
  if (options.clone && (!options.repoRoot || !options.sessionDirectory || options.preparationOnly))
    throw new Error("Clone sessions need a repository and a session directory");
  // Shared by the repository's mounted sessions; a clone session keeps its own.
  let packageCache: string | undefined;
  if (options.repoRoot && !options.clone && !options.privateWorkspace) {
    const cache = join(repoCacheDirectory(await Deno.realPath(options.repoRoot)), "package-cache");
    await Deno.mkdir(cache, { recursive: true, mode: 0o700 });
    if ((await Deno.lstat(cache)).isSymlink) throw new Error("Package cache must not be a symlink");
    packageCache = await Deno.realPath(cache);
  }
  let git: VmBinding["git"];
  if (options.clone) {
    await Deno.mkdir(options.sessionDirectory!, { recursive: true, mode: 0o700 });
    git = await prepareCloneBinding(
      await Deno.realPath(options.repoRoot!),
      await Deno.realPath(options.sessionDirectory!),
      options.clone,
    );
  }
  const workspace = await Deno.realPath(options.workspace);
  const privateWorkspace =
    options.privateWorkspace ??
    (git && workspaceMount(workspace).host !== workspace
      ? workspaceMount(workspace).host
      : undefined);
  if (privateWorkspace && (await Deno.realPath(privateWorkspace)) !== privateWorkspace)
    throw new Error("Private workspace must not be a symlink");
  if (
    git &&
    guestWorkingDirectory({ workspace, ...(privateWorkspace ? { privateWorkspace } : {}) }) !==
      git.checkout.path
  )
    throw new Error("Clone session workspace must be the session clone");
  // workspaceMounts runs Git in the workspace; host Git never opens a session clone.
  const mounts =
    git || privateWorkspace
      ? []
      : [...(await workspaceMounts(workspace)), ...(packageCache ? [packageCache] : [])];
  const manifest = await inspectArtifact(artifact);
  try {
    if (
      !manifest.environmentCompatibility ||
      (await Deno.readTextFile(join(artifact, "claude-session-version"))).trim() !== "2"
    )
      throw new Error("incompatible runtime");
  } catch {
    throw new Error(
      "Session VM runtime is missing or incompatible; upgrade the Loom package, or rebuild the configured provider runtime with this Loom version",
    );
  }
  if (options.environmentOnly && (await environmentRuntimeVersion(artifact)) < 1)
    throw new Error(
      "Standalone environments require a rebuilt session runtime; run loom runtime update",
    );
  if (privateWorkspace || options.preparationOnly || environmentEnabled(options.environment)) {
    try {
      if ((await Deno.readTextFile(join(artifact, "session-environment-version"))).trim() !== "7")
        throw new Error();
    } catch {
      throw new Error(
        "Session environment requires a rebuilt provider runtime; upgrade Loom or run loom runtime update",
      );
    }
  }
  if (auth.codexOauth) {
    // Bubblewrap cannot create protected mount points through the guest's
    // host-owned virtiofs worktree. Materialize them before entering the VM.
    for (const name of [".agents", ".codex"])
      await Deno.mkdir(join(workspace, name), { recursive: true });
  }
  let sessionDirectory: string | undefined;
  if (options.sessionDirectory) {
    await Deno.mkdir(options.sessionDirectory, { recursive: true, mode: 0o700 });
    sessionDirectory = await Deno.realPath(options.sessionDirectory);
    if (
      sessionDirectory === workspace ||
      sessionDirectory.startsWith(workspace + "/") ||
      /[:,;|\n\0]/.test(sessionDirectory)
    )
      throw new Error("Session history must be outside the worktree");
  }
  const state = await Deno.realPath(
    await Deno.makeTempDir({
      dir: "/tmp",
      // smolvm uses HOME/Library/Caches on macOS, regardless of XDG_CACHE_HOME.
      // Leave room for its VM ID and control socket within Darwin's 104-byte limit.
      prefix: Deno.build.os === "darwin" ? "loom-svm-" : "loom-session-vm-",
    }),
  );
  const binding = {
    version: 1 as const,
    artifact,
    smolvm,
    workspace,
    manifest,
    state,
    token: crypto.randomUUID(),
    ...(environmentEnabled(options.environment) ? { writableNix: true } : {}),
    mounts,
    ...(packageCache ? { packageCache } : {}),
    ...(sessionDirectory ? { sessionDirectory } : {}),
    ...(options.mcpRelays ? { mcpRelays: options.mcpRelays } : {}),
    ...(git ? { git } : {}),
    ...(options.gitIdentity && !options.preparationOnly
      ? { gitIdentity: options.gitIdentity }
      : {}),
    ...(privateWorkspace ? { privateWorkspace } : {}),
    ...(options.preparationOnly ? { preparationOnly: true } : {}),
    ...(options.environmentOnly ? { environmentOnly: true } : {}),
    ...(options.repoRoot ? { repoBaseDirectory: repoBaseDirectory(options.repoRoot) } : {}),
  };
  let inventory: VmOwner | undefined;
  const inventoryPaths: VmRecord["paths"] = {
    workspace,
    runtime: artifact,
    state,
    session: sessionDirectory ?? null,
    profile:
      sessionDirectory && !options.preparationOnly ? join(sessionDirectory, "profile") : null,
    backend: null,
    base: null,
  };
  try {
    inventory = await registerVm({
      version: 1,
      id: binding.token,
      repo: await Deno.realPath(options.repoRoot ?? workspace),
      kind: options.preparationOnly ? "prepare" : "session",
      sessionId: options.sessionId ?? null,
      provider: options.provider ?? null,
      smolvm: binding.smolvm,
      workload: options.preparationOnly ? "dependency cache" : (options.activity?.() ?? "starting"),
      state: "starting",
      createdAt: new Date().toISOString(),
      stoppedAt: null,
      observedAt: new Date().toISOString(),
      source: "owner",
      error: null,
      paths: inventoryPaths,
    });
    const root = new URL("../../../", import.meta.url);
    // Deno-native pipes, not node:child_process + Readable.toWeb: cancelling that
    // adapter destroys stdout with an AbortError, which Deno's child_process exit
    // handler (still awaiting stdout's close) rethrows as an unhandled rejection.
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--no-prompt",
        "--cached-only",
        "--frozen",
        "--node-modules-dir=manual",
        `--config=${fileURLToPath(new URL("deno.json", root))}`,
        fileURLToPath(new URL("runtime/src/session-vm/supervisor.ts", root)),
      ],
      cwd: state,
      detached: true,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "",
        ...(Deno.env.get("DENO_DIR") ? { DENO_DIR: Deno.env.get("DENO_DIR")! } : {}),
      },
    }).spawn();
    let supervisorExit: Deno.CommandStatus | undefined;
    const exited = child.status.then((status) => {
      supervisorExit = status;
    });
    // A private bootstrap frame precedes the unchanged guest worker protocol.
    // Credentials never enter argv, environment, logs, or an unsupervised file.
    // Releasing the lock leaves the write queued ahead of the worker's frames.
    const bootstrap = child.stdin.getWriter();
    void bootstrap
      .write(
        new TextEncoder().encode(
          JSON.stringify({
            binding,
            extraAllowedHosts,
            environment: options.environment,
            prepareHooks: options.prepareHooks,
            providerHosts: normalizeExtraHosts(options.providerHosts ?? defaultProviderHosts),
            auth,
          }) + "\n",
        ),
      )
      .catch(() => {});
    bootstrap.releaseLock();
    let lastStage: StartupStage = "runtime";
    let failure: Error | undefined;
    let termination: VmTermination | undefined;
    let hostReason: HostStopReason | undefined;
    let lastNetworkWarning: VmTermination["lastNetworkWarning"];
    const diagnosis = (): VmTermination => {
      const activity = vmTerminationSchema.shape.activity.safeParse(options.activity?.());
      return {
        ...(termination ?? { reason: "connection_closed", at: Date.now(), phase: "unknown" }),
        stage: lastStage,
        ...(activity.success && activity.data ? { activity: activity.data } : {}),
        ...(hostReason ? { hostReason } : {}),
        ...(lastNetworkWarning ? { lastNetworkWarning } : {}),
        ...(supervisorExit
          ? {
              supervisorExit: {
                code: supervisorExit.signal ? null : supervisorExit.code,
                signal: supervisorExit.signal,
              },
            }
          : {}),
      };
    };
    let reported = false;
    const reportTermination = () => {
      if (reported) return;
      reported = true;
      const info = diagnosis();
      options.onProgress?.(vmTerminationMessage(info), info);
    };
    const startup = !options.preparationOnly
      ? readStartupProgress(
          child.stderr,
          (stage, elapsed, host) => {
            if (stage === "networkBlocked") {
              if (host) lastNetworkWarning = { host, at: Date.now() };
            } else {
              lastStage = stage;
            }
            options.onProgress?.(startupMessage(stage, elapsed, host));
          },
          (code) => {
            // A guest's specific diagnostic outlives the supervisor's generic summary.
            if (!failure || code !== "backend") failure = new Error(startupFailures[code]);
          },
          (info) => {
            termination ??= info;
            reportTermination();
          },
          undefined,
          (info) => options.onProgress?.(relayDiagnosticMessage(info)),
        ).catch(() => {})
      : Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = new AbortController();
    void exited.then(
      () => ended.abort(),
      () => ended.abort(),
    );
    let unsubscribe: (() => Promise<void>) | undefined;
    let subscribing: Promise<void> | undefined;
    let publication: Promise<void> = Promise.resolve();
    const killGroup = () => {
      try {
        Deno.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    };
    let cleanup: Promise<void> | undefined;
    const clean = () =>
      (cleanup ??= (async () => {
        await exited.catch(() => {});
        await startup;
        if (!options.preparationOnly) reportTermination();
        clearTimeout(timer);
        await unsubscribe?.();
        await publication.catch(() => {});
        if (sessionDirectory && (await readRecovery(sessionDirectory))?.token === binding.token) {
          const lock = await lockSessionState(sessionDirectory);
          try {
            const record = await readRecovery(sessionDirectory);
            if (record?.token === binding.token) {
              await recoverSessionVm(sessionDirectory);
              return;
            }
          } finally {
            lock.release();
          }
        }
        // A killed supervisor cannot reap: stop its native CLI group before fallback.
        if (!sessionDirectory) killGroup();
        try {
          await Deno.stat(state);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            if (sessionDirectory) await finishSessionState(sessionDirectory, binding.token);
            return;
          }
          throw error;
        }
        await cleanupSessionVm({
          stop: async () => {},
          egress: async () => {},
          credentials: () => remove(join(state, "private")),
          reap: () => reapVm(binding),
          state: async () => {
            await remove(state);
            if (sessionDirectory) await finishSessionState(sessionDirectory, binding.token);
          },
        });
      })()
        .then(
          () => inventory?.finish(),
          async (error) => {
            await inventory?.finish(error);
            throw error;
          },
        )
        .catch((error) => {
          cleanup = undefined;
          throw error;
        }));
    void exited.then(clean, clean).catch(() => {});
    let stopping = false;
    const worker = {
      binding,
      status: async () => JSON.parse(await Deno.readTextFile(join(state, "status.json"))),
      input: child.stdin,
      output: child.stdout,
      exited,
      pid: child.pid,
      exitCode: child.status.then((status) => (status.signal ? 1 : status.code)),
      failure: async () => {
        await startup;
        await exited.catch(() => {});
        return new VmTerminationError(diagnosis(), failure?.message);
      },
      ...(options.preparationOnly ? { diagnostics: child.stderr } : {}),
      setStopReason(reason: HostStopReason) {
        if (!termination && !supervisorExit) hostReason ??= reason;
      },
      terminate(reason?: HostStopReason) {
        if (reason) worker.setStopReason(reason);
        if (stopping) return;
        stopping = true;
        if (supervisorExit) return;
        try {
          child.kill("SIGTERM");
        } catch {
          return; // exited before its status was observed
        }
        timer = setTimeout(killGroup, 20_000);
      },
      cleanup: clean,
    };
    inventory.serve(
      async () => {
        worker.setStopReason("user_stop");
        await options.onStop?.(() => !ended.signal.aborted);
        worker.terminate();
        await clean();
      },
      async () => {
        let phase = "starting";
        try {
          const status: SessionVmStatus = await worker.status();
          phase = status.phase;
          inventoryPaths.backend = status.backendDirectory ?? null;
          const generation = await sessionVmGeneration(state);
          inventoryPaths.base =
            generation && binding.repoBaseDirectory
              ? join(binding.repoBaseDirectory, generation)
              : null;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        let vmState: VmRecord["state"] = phase === "running" ? "running" : "starting";
        if (stopping) vmState = "stopping";
        return {
          state: vmState,
          paths: inventoryPaths,
          workload:
            options.activity?.() ?? (options.preparationOnly ? "dependency cache" : lastStage),
        };
      },
    );
    if (options.authOwner) {
      subscribing = (async () => {
        // Wait until the supervisor has written its initial credential snapshot.
        const deadline = Date.now() + 15_000;
        for (;;) {
          if (ended.signal.aborted) return;
          try {
            await Deno.stat(join(state, "private/auth.json"));
            break;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
          if (Date.now() > deadline) throw new Error("Session credentials were not initialized");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        unsubscribe = await options.authOwner!.subscribe(
          async (value) => {
            if (ended.signal.aborted) return;
            publication = writeSessionAuth(join(state, "private"), value);
            await publication;
          },
          () => worker.terminate("credential_expired"),
        );
        if (ended.signal.aborted) await unsubscribe();
      })();
      void subscribing.catch(() => worker.terminate("credential_setup_failed"));
    }
    return worker;
  } catch (error) {
    await remove(state);
    await inventory?.finish();
    throw error;
  }
};

/** Recorded under the publication lock when this VM selects its immutable base. */
export const sessionVmGeneration = async (state: string): Promise<string> => {
  try {
    return await Deno.readTextFile(join(state, "base-generation"));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "";
    throw error;
  }
};

/** A cache collector cannot race VM startup; retained state protects crash recovery. */
export const launchSessionVm = async (options: SessionVmOptions) => {
  const lease = (await vmMaintenanceLock())!;
  try {
    const worker = await launchSessionVmOwned(options);
    void worker.exited.then(
      () => lease.release(),
      () => lease.release(),
    );
    return worker;
  } catch (error) {
    lease.release();
    throw error;
  }
};
