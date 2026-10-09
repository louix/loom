/**
 * Loom execution adapter for `session.isolation.launcher = "isolation"`. Each VM
 * session boots one environment through the isolation coordinator, then runs the
 * existing guest worker inside it as a leased execution, adapted to WorkerProcess.
 * RemoteWorkerSession and the connector protocol run unchanged above it.
 *
 * Lifetimes are separate. WorkerProcess.exited is the worker execution's exit, not
 * the VM's. Execution cleanup reaps the child and releases its lease; only then is
 * the environment stopped, by the coordinator, and only for the generation that
 * started it. A VM failure cancels the lease, which ends the execution.
 *
 * Idle policy stays in the daemon: its sweep closes an idle session, which ends the
 * worker and releases its lease before the environment stops. The library has no
 * idle timer, so the daemon's grace period and keep-warm exclusions remain the only
 * ones.
 *
 * While the worker runs, the environment's other executions are published to the
 * daemon: session shells, daemon-run hooks, guest Git and inspection each hold their
 * own lease beside the worker's. They neither keep the environment alive nor stop
 * it; as with the session VM, they end when the worker's environment stops, and the
 * daemon keeps idle suspension away from open shells and running hooks.
 */
import { dirname, join } from "node:path";
import type { StopReason } from "@loom/isolation/environment";
import type { EnvironmentStorage } from "@loom/isolation/storage";
import type { ExecutionTarget } from "../../../../core/src/execution.ts";
import {
  VmTerminationError,
  type HostStopReason,
  type VmTermination,
} from "../../../../core/src/vm-termination.ts";
import type { WorkerFailure } from "../../../../core/src/worker-failure.ts";
import { relayDiagnosticMessage } from "../../../../core/src/relay-diagnostic.ts";
import { inspectArtifact } from "../../../../runtime/src/packaged/artifact.ts";
import { vmCommand } from "../../../../runtime/src/session-vm/command.ts";
import { createVmEnvironmentCoordinator } from "../../../../runtime/src/session-vm/coordinator.ts";
import { launchEnvironmentVm } from "../../../../runtime/src/session-vm/environment-launch.ts";
import {
  defaultProviderHosts,
  environmentRuntimeVersion,
  type SessionVmOptions,
} from "../../../../runtime/src/session-vm/launch.ts";
import {
  readStartupProgress,
  startupFailures,
  startupMessage,
} from "../../../../runtime/src/session-vm/progress.ts";
import { sessionVmDirectory, withStoppedSessionVm } from "./session-vm-state.ts";
import type { WorkerProcess } from "./worker-launch.ts";
import type { SessionExecutions } from "@loom/core/connector";

type EnvironmentVm = Awaited<ReturnType<typeof launchEnvironmentVm>>;
export type IsolatedLaunchOptions = SessionVmOptions & {
  signal?: AbortSignal;
  /** Publish the environment's executions while its worker runs; returns the withdrawal. */
  executions?: (executions: SessionExecutions) => () => void;
};
export type IsolatedWorker = WorkerProcess & {
  binding: EnvironmentVm["binding"];
  /** Resolves once the execution is reaped and its lease released. */
  settled: Promise<void>;
};
/** The host side of one execution; Deno.ChildProcess in production. */
export interface ExecutionChild {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  pid: number;
  status: Promise<{ code: number; signal: Deno.Signal | null }>;
  kill(signal?: Deno.Signal): void;
}
export interface IsolatedWorkerBackend {
  launch: typeof launchEnvironmentVm;
  command: typeof vmCommand;
  spawn(target: ExecutionTarget["vm"]): ExecutionChild;
  /** Guest argv that starts the worker inside an initialized environment. */
  workerArgv(artifact: string): Promise<string[]>;
}

/** The session runtime's own wrapper, running guest-worker.ts beside its guest.ts. */
export const guestWorkerArgv = async (artifact: string): Promise<string[]> => {
  const root = await Deno.realPath(artifact);
  if ((await environmentRuntimeVersion(root)) < 2)
    throw new Error(
      "The isolation launcher needs a rebuilt session runtime; run loom runtime update, or set session.isolation.launcher to legacy",
    );
  const manifest = await inspectArtifact(root);
  const guest = manifest.args[0];
  if (manifest.args.length !== 1 || !guest?.endsWith("/runtime/src/session-vm/guest.ts"))
    throw new Error("Session runtime has no guest worker entrypoint");
  return [manifest.entrypoint, join(dirname(guest), "guest-worker.ts")];
};

const spawnExecution = (target: ExecutionTarget["vm"]): ExecutionChild =>
  new Deno.Command(target.executable, {
    args: target.args,
    env: target.env,
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

/** The coordinator's reasons are coarser; the precise host reason is recorded first. */
const coordinatorReason = (reason: HostStopReason): StopReason => {
  if (reason === "idle_suspension") return "idle_suspension";
  if (reason === "daemon_shutdown") return "owner_shutdown";
  if (reason === "worker_failure") return "backend_failure";
  return "user_stop";
};
const exitStatus = (status: { code: number; signal: Deno.Signal | null }) => ({
  code: status.signal ? null : Math.min(255, Math.max(0, status.code)),
  signal: status.signal,
});

interface Generation {
  id: string;
  onStop?: SessionVmOptions["onStop"];
  environment?: EnvironmentVm;
  worker?: IsolatedWorker;
  /** This adapter asked the coordinator to stop the environment. */
  stopping?: boolean;
  /** Withdraws the published executions; set while the worker runs. */
  withdraw?: () => void;
}

const notRunning = () => new Error("The session VM is not running. Resume it first.");
const withdraw = (generation: Generation) => {
  const published = generation.withdraw;
  delete generation.withdraw;
  published?.();
};

/** Same contract as createSessionVmLauncher, over one coordinator per provider. */
export const createIsolatedWorkerLauncher = (
  repoRoot: string,
  overrides: Partial<IsolatedWorkerBackend> = {},
) => {
  const backend: IsolatedWorkerBackend = {
    launch: launchEnvironmentVm,
    command: vmCommand,
    spawn: spawnExecution,
    workerArgv: guestWorkerArgv,
    ...overrides,
  };
  // Preserve each session's VM state location and its stopped-state lock.
  const storage: EnvironmentStorage = {
    directory: (id) => sessionVmDirectory(repoRoot, id),
    withStopped: (id, action) => withStoppedSessionVm(repoRoot, id, () => action()),
  };
  // The generation that currently owns each environment ID.
  const generations = new Map<string, Generation>();
  let closed = false;
  const coordinator = createVmEnvironmentCoordinator(storage, {
    command: backend.command,
    launch: async (options) => {
      const generation = generations.get(options.sessionId!)!;
      const environment = await backend.launch({
        ...options,
        // An external stop (loom vm stop) first suspends the session in order, so
        // the worker's lease is released before the coordinator's own stop.
        onStop: async (isCurrent) => {
          await generation.onStop?.(isCurrent);
          if (isCurrent() && generation.worker) {
            generation.worker.terminate("user_stop");
            await generation.worker.settled;
          }
          // As with a session VM, open shells and commands end with the VM.
          if (isCurrent() && generations.get(generation.id) === generation) {
            withdraw(generation);
            await coordinator.leases.cancel(generation.id);
          }
          await options.onStop!(isCurrent);
        },
      });
      generation.environment = environment;
      return environment;
    },
  });

  /** Never stop a replacement VM through a stale callback. */
  const stopEnvironment = async (generation: Generation, reason: HostStopReason) => {
    if (generations.get(generation.id) !== generation) return;
    generation.stopping = true;
    withdraw(generation);
    generation.environment?.setStopReason?.(reason);
    // The environment exists for its worker. Shells and commands still open on it
    // end with it, as they did with the session VM; the daemon's lifecycle checks
    // keep idle suspension and refreshes away from open shells and running hooks.
    await coordinator.leases.cancel(generation.id);
    await coordinator.stop(generation.id, coordinatorReason(reason));
    if (generations.get(generation.id) === generation) generations.delete(generation.id);
  };

  const startWorker = (
    generation: Generation,
    argv: string[],
    onProgress: SessionVmOptions["onProgress"],
    publish: IsolatedLaunchOptions["executions"],
  ): IsolatedWorker => {
    const { id } = generation;
    const environment = generation.environment!;
    const owner = new AbortController();
    // Held like a host command rather than a terminal: forced teardown cancels it,
    // but it is released only once the worker process has been reaped.
    const lease = coordinator.leases.acquire(id, owner);
    let child: ExecutionChild;
    try {
      const target = coordinator.openExecution(id, { argv, stdin: true, tty: false }, owner);
      // openExecution's own lease ends with its caller's connection; ours outlives it.
      coordinator.closeExecution(target.token, owner);
      child = backend.spawn(target.vm);
    } catch (error) {
      lease.release();
      throw error;
    }
    let stopReason: HostStopReason | undefined;
    let terminated = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let workerFailure: WorkerFailure | undefined;
    let startupFailure: string | undefined;
    // Set when the VM ended without this adapter asking it to.
    let environmentFailed = false;
    void environment.exited.then(
      () => (environmentFailed ||= !generation.stopping),
      () => {},
    );
    // Raw guest stderr can contain credentials; only fixed frames cross.
    const diagnostics = readStartupProgress(
      child.stderr,
      (stage, elapsed, host) => onProgress?.(startupMessage(stage, elapsed, host)),
      (code) => {
        startupFailure = startupFailures[code];
      },
      undefined,
      (info) => {
        workerFailure ??= info;
      },
      (info) => onProgress?.(relayDiagnosticMessage(info)),
    ).catch(() => {});
    const status = child.status;
    let ended = false;
    const reaped = () => {
      ended = true;
      withdraw(generation);
      clearTimeout(killTimer);
      lease.release();
    };
    const exited = status.then(reaped, (error) => {
      reaped();
      throw error;
    });
    void exited.catch(() => {});
    const kill = (signal: Deno.Signal) => {
      try {
        child.kill(signal);
      } catch {
        /* exited */
      }
    };
    const setStopReason = (reason: HostStopReason) => {
      stopReason ??= reason;
      environment.setStopReason?.(reason);
    };
    const terminate = (reason?: HostStopReason) => {
      if (reason) setStopReason(reason);
      // RemoteWorkerSession also terminates after an unexpected exit: not a request.
      if (terminated || ended) return;
      terminated = true;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 5000);
    };
    lease.signal.addEventListener("abort", () => terminate(), { once: true });
    const settled = (async () => {
      await exited.catch(() => {});
      await diagnostics;
      if (terminated) return;
      // The worker ended by itself. A failing VM ends its executions too, sometimes
      // before its own exit is observed: let it report first so the diagnosis names it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        environment.exited.catch(() => {}),
        new Promise((resolve) => (timer = setTimeout(resolve, 1000))),
      ]);
      clearTimeout(timer);
    })();
    let cleaning: Promise<void> | undefined;
    const cleanup = () =>
      (cleaning ??= (async () => {
        await settled;
        await stopEnvironment(
          generation,
          stopReason ?? (terminated ? "session_close" : "worker_failure"),
        );
      })().catch((error) => {
        cleaning = undefined;
        throw error;
      }));
    // The environment exists only for this worker; its exit ends the generation.
    void exited.then(cleanup, cleanup).catch(() => {});
    const worker: IsolatedWorker = {
      binding: environment.binding,
      input: child.stdin,
      output: child.stdout,
      pid: child.pid,
      exited,
      settled,
      setStopReason,
      terminate,
      cleanup,
      async failure() {
        await settled;
        // Diagnose after the VM has gone, whether or not its cleanup succeeded.
        await (cleaning ?? cleanup()).catch(() => {});
        const vm = await environment.failure?.();
        if (environmentFailed || !(vm instanceof VmTerminationError))
          return vm ?? new Error("Session worker exited");
        const termination: VmTermination = {
          ...vm.termination,
          // From the session's view, its guest execution is the worker.
          reason: "guest_exit",
          phase: "running",
          hostReason: stopReason ?? "worker_failure",
          guestExit: exitStatus(await status),
          ...(workerFailure ? { workerFailure } : {}),
        };
        return new VmTerminationError(termination, startupFailure);
      },
    };
    generation.worker = worker;
    // Shells, hooks and inspection: independent executions on the same environment,
    // each under its own lease, available only while this generation's worker runs.
    const live = () => {
      if (ended || generation.stopping || generations.get(id) !== generation) throw notRunning();
    };
    const executions: SessionExecutions = {
      workspace: environment.binding.workspace,
      async command(command, timeoutMs, signal, env) {
        live();
        return await coordinator.command(id, command, timeoutMs, { signal }, env);
      },
      open(options, owner) {
        live();
        return coordinator.openExecution(id, options, owner);
      },
      close: (token, owner) => coordinator.closeExecution(token, owner),
    };
    if (publish) generation.withdraw = publish(executions);
    return worker;
  };

  return {
    async launch(options: IsolatedLaunchOptions): Promise<IsolatedWorker> {
      if (closed) throw new Error("Session VM provider is shutting down");
      const {
        signal,
        executions,
        onStop,
        sessionId: id,
        sessionDirectory,
        preparationOnly,
        prepareHooks,
        environmentOnly,
        ...configuration
      } = options;
      if (!id) throw new Error("Isolated session VMs need a session identity");
      if (preparationOnly || prepareHooks || environmentOnly)
        throw new Error("Isolated session VMs run agents, not preparation");
      if (sessionDirectory !== undefined && sessionDirectory !== storage.directory(id))
        throw new Error("Session VM state must stay in the session's own directory");
      signal?.throwIfAborted();
      const argv = await backend.workerArgv(configuration.artifact);
      // Finish or retry a previous generation's cleanup; never reuse a live one.
      const previous = coordinator.inspect(id).phase;
      if (previous === "starting" || previous === "ready")
        throw new Error("Session VM is already running");
      if (previous !== "stopped") await coordinator.stop(id);
      signal?.throwIfAborted();
      if (closed) throw new Error("Session VM provider is shutting down");
      const generation: Generation = { id, ...(onStop ? { onStop } : {}) };
      generations.set(id, generation);
      const cancel = () => void stopEnvironment(generation, "user_stop").catch(() => {});
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        await coordinator.start(id, {
          mode: "execution",
          ...configuration,
          // Unlike plain environments, agent sessions keep their provider egress.
          providerHosts: configuration.providerHosts ?? defaultProviderHosts,
        });
        signal?.throwIfAborted();
        if (closed) throw new Error("Session VM provider is shutting down");
        return startWorker(generation, argv, configuration.onProgress, executions);
      } catch (error) {
        // The coordinator already reaped a failed start; this covers later failures.
        await stopEnvironment(generation, "user_stop").catch(() => {});
        throw signal?.aborted ? signal.reason : error;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    },
    async close() {
      closed = true;
      const live = [...generations.values()];
      for (const generation of live) generation.worker?.terminate("daemon_shutdown");
      await Promise.allSettled(
        live.map((generation) =>
          generation.worker
            ? generation.worker.cleanup!()
            : stopEnvironment(generation, "daemon_shutdown"),
        ),
      );
      // Anything left, including failed cleanup, is retried and reported here.
      await coordinator.close();
    },
    /** Observation for tests and B3 routing; the daemon keeps session state. */
    inspect: (id: string) => coordinator.inspect(id),
    leases: coordinator.leases,
  };
};
