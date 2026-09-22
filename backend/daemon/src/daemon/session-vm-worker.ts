import {
  environmentEnabled,
  type SessionEnvironment,
} from "../../../../core/src/session-environment.ts";
import {
  registerVm,
  type VmOwner,
  type VmRecord,
} from "../../../../runtime/src/session-vm/inventory.ts";
import { normalizeExtraHosts } from "../../../../runtime/src/session-vm/network-policy.ts";
/** Opt-in VM launcher using the existing connector WorkerProcess contract. */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectArtifact } from "../../../../runtime/src/packaged/artifact.ts";
import { vmMaintenanceLock } from "../../../../runtime/src/packaged/maintenance.ts";
import { readRecovery, recoverSessionVm } from "../../../../runtime/src/session-vm/recovery.ts";
import {
  finishSessionState,
  lockSessionState,
} from "../../../../runtime/src/session-vm/persistence.ts";
import { workspaceMount } from "../../../../runtime/src/session-vm/workspace.ts";
import { guestWorkingDirectory } from "../../../../runtime/src/packaged/vm.ts";
import { workspaceMounts } from "../../../../runtime/src/packaged/workspace.ts";
import { reapVm, type VmBinding } from "../../../../runtime/src/packaged/vm.ts";
import { cleanupSessionVm } from "../../../../runtime/src/session-vm/cleanup.ts";
import {
  prepareCloneBinding,
  type SessionClone,
} from "../../../../runtime/src/session-vm/clone.ts";
import {
  readStartupProgress,
  startupMessage,
  startupFailures,
  type StartupStage,
} from "../../../../runtime/src/session-vm/progress.ts";
import { repoBaseDirectory } from "../../../../runtime/src/session-vm/repo-base.ts";
import type { WorkerProcess } from "./worker-launch.ts";
import {
  sessionAuth,
  writeSessionAuth,
  type SessionAuth,
} from "../../../../runtime/src/session-vm/auth.ts";

export interface SessionVmOptions {
  prepareHooks?: import("../../../../core/src/types.ts").InitHook[];
  sessionId?: string;
  provider?: string;
  onStop?: (isCurrent: () => boolean) => Promise<void>;
  activity?: () => string;
  onProgress?: (message: string) => void;
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
  repoRoot?: string;
  mcpRelays?: Array<{ port: number; guestPort: number }>;
  /** Work in a private clone served by the Git relay instead of mounting the repository. */
  clone?: SessionClone;
  privateWorkspace?: string;
}
export interface SessionVmStatus {
  phase: string;
  backendDirectory?: string | null;
  execPid?: number;
  network: Array<{ host: string; allowed: boolean }>;
}

/** A provider owns launches too, including VMs still waiting for agent readiness. */
export const createSessionVmLauncher = () => {
  let closed = false;
  const launches = new Set<Promise<Awaited<ReturnType<typeof launchSessionVm>>>>();
  return {
    launch(options: SessionVmOptions) {
      if (closed) throw new Error("Session VM provider is shutting down");
      const pending = launchSessionVm(options).then(async (worker) => {
        if (closed) {
          worker.terminate();
          await worker.cleanup?.();
          throw new Error("Session VM provider is shutting down");
        }
        void worker.exited.then(
          () => launches.delete(pending),
          () => launches.delete(pending),
        );
        return worker;
      });
      launches.add(pending);
      void pending.catch(() => launches.delete(pending));
      return pending;
    },
    async close() {
      closed = true;
      await Promise.all(
        [...launches].map(async (pending) => {
          const worker = await pending.catch(() => undefined);
          if (!worker) return;
          worker.terminate();
          await worker.cleanup?.();
        }),
      );
    },
  };
};
const remove = async (path: string) => {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
};
const launchSessionVmOwned = async (
  options: SessionVmOptions,
): Promise<
  WorkerProcess & {
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
  const artifact = await Deno.realPath(options.artifact);
  const smolvm = await Deno.realPath(options.smolvm);
  const auth = sessionAuth(
    options.authOwner ? await options.authOwner.current() : (options.auth ?? {}),
  );
  if (options.clone && (!options.repoRoot || !options.sessionDirectory || options.preparationOnly))
    throw new Error("Clone sessions need a repository and a session directory");
  // The shared package cache lives inside the repository, which clone sessions never mount.
  const packageCache =
    options.repoRoot && !options.clone && !options.privateWorkspace
      ? join(await Deno.realPath(options.repoRoot), ".loom/package-cache")
      : undefined;
  if (packageCache) {
    await Deno.mkdir(packageCache, { recursive: true, mode: 0o700 });
    if ((await Deno.realPath(packageCache)) !== packageCache)
      throw new Error("Package cache must not be a symlink");
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
  const mounts = git || privateWorkspace ? [] : await workspaceMounts(workspace, options.repoRoot);
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
    ...(privateWorkspace ? { privateWorkspace } : {}),
    ...(options.preparationOnly ? { preparationOnly: true } : {}),
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
      workload: options.preparationOnly ? "dependency cache" : (options.activity?.() ?? "starting"),
      state: "starting",
      createdAt: new Date().toISOString(),
      stoppedAt: null,
      observedAt: new Date().toISOString(),
      source: "owner",
      error: null,
      paths: inventoryPaths,
    });
    const root = new URL("../../../../", import.meta.url);
    const child = spawn(
      Deno.execPath(),
      [
        "run",
        "-A",
        "--no-prompt",
        "--cached-only",
        "--frozen",
        "--node-modules-dir=manual",
        `--config=${fileURLToPath(new URL("deno.json", root))}`,
        fileURLToPath(new URL("runtime/src/session-vm/supervisor.ts", root)),
      ],
      {
        cwd: state,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: Deno.env.get("PATH") ?? "",
          ...(Deno.env.get("DENO_DIR") ? { DENO_DIR: Deno.env.get("DENO_DIR")! } : {}),
        },
      },
    );
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    // A private bootstrap frame precedes the unchanged guest worker protocol.
    // Credentials never enter argv, environment, logs, or an unsupervised file.
    child.stdin.on("error", () => {});
    child.stdin.write(
      JSON.stringify({
        binding,
        extraAllowedHosts,
        environment: options.environment,
        prepareHooks: options.prepareHooks,
        providerHosts: normalizeExtraHosts(options.providerHosts ?? ["api.anthropic.com"]),
        auth,
      }) + "\n",
    );
    let lastStage: StartupStage = "runtime";
    let failure: Error | undefined;
    const startup = !options.preparationOnly
      ? readStartupProgress(
          Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
          (stage, elapsed, host) => {
            lastStage = stage;
            options.onProgress?.(startupMessage(stage, elapsed, host));
          },
          (code) => {
            failure = new Error(startupFailures[code]);
          },
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
      if (!child.pid) return;
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
            lock.close();
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
      input: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      output: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      exited,
      pid: child.pid ?? -1,
      exitCode: exited.then(() => child.exitCode ?? 1),
      failure: async () => {
        await startup;
        return (
          failure ?? new Error(`Session VM connection ended during: ${startupMessage(lastStage)}`)
        );
      },
      ...(options.preparationOnly
        ? { diagnostics: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array> }
        : {}),
      terminate() {
        if (stopping) return;
        stopping = true;
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        timer = setTimeout(killGroup, 20_000);
      },
      cleanup: clean,
    };
    inventory.serve(
      async () => {
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
          () => worker.terminate(),
        );
        if (ended.signal.aborted) await unsubscribe();
      })();
      void subscribing.catch(() => worker.terminate());
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
      () => lease.close(),
      () => lease.close(),
    );
    return worker;
  } catch (error) {
    lease.close();
    throw error;
  }
};
