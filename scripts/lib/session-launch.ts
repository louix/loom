/**
 * Agent session VMs for real-VM acceptance scripts, launched as the daemon launches
 * them: an environment through the isolation coordinator, with the guest worker as
 * a leased execution inside it. Preparation is not an agent session; scripts launch
 * it with launchSessionVm directly, as Loom itself does.
 */
import { basename, join } from "node:path";
import {
  createIsolatedWorkerLauncher,
  type IsolatedLaunchOptions,
} from "../../backend/daemon/src/daemon/isolated-worker.ts";
import {
  sessionVmDirectory,
  stoppedSessionVm,
} from "../../backend/daemon/src/daemon/session-vm-state.ts";
import type { SessionVmOptions, SessionVmStatus } from "../../runtime/src/session-vm/launch.ts";
import type { WorkerProcess } from "../../backend/daemon/src/daemon/worker-launch.ts";
import type { VmBinding } from "../../runtime/src/packaged/vm.ts";
import type { SessionExecutions } from "../../core/src/connector.ts";
import { supervisorPid } from "./host-processes.ts";

export type TestSessionVmOptions = Omit<
  SessionVmOptions,
  "preparationOnly" | "prepareHooks" | "environmentOnly"
> & {
  /** Receives the environment's executions while its worker runs. */
  executions?: (executions: SessionExecutions) => void;
};
/** What scripts use from a session VM worker. */
export type TestSessionWorker = Pick<
  WorkerProcess,
  "input" | "output" | "exited" | "pid" | "terminate" | "cleanup" | "failure"
> & {
  binding: VmBinding;
  status(): Promise<SessionVmStatus>;
  /** The VM's supervisor; `pid` is the worker execution. */
  supervisor(): Promise<number | undefined>;
};

const launchers = new Map<string, ReturnType<typeof createIsolatedWorkerLauncher>>();
let anonymous = 0;

/**
 * Launch an agent session VM. Each session's state lives in its canonical directory
 * (see sessionVmDirectory), so a script that names a session directory must use that
 * location; its basename is then the session identity. Without one, an identity is
 * assigned.
 */
export const launchTestSessionVm = async (
  options: TestSessionVmOptions,
): Promise<TestSessionWorker> => {
  const { executions, ...launch } = options;
  // Session state must never land in the user's own state directory.
  if (!Deno.env.get("XDG_STATE_HOME"))
    throw new Error("Set a private XDG_STATE_HOME before launching session VMs");
  const repoRoot = await Deno.realPath(launch.repoRoot ?? launch.workspace);
  let launcher = launchers.get(repoRoot);
  if (!launcher) launchers.set(repoRoot, (launcher = createIsolatedWorkerLauncher(repoRoot)));
  const named = launch.sessionDirectory && basename(launch.sessionDirectory);
  const sessionId = launch.sessionId ?? named ?? `script-${Deno.pid}-${++anonymous}`;
  if (
    launch.sessionDirectory &&
    launch.sessionDirectory !== sessionVmDirectory(repoRoot, sessionId)
  )
    throw new Error("Session VM state must use sessionVmDirectory(repoRoot, sessionId)");
  const { sessionDirectory: _directory, ...rest } = launch;
  await stoppedSessionVm(repoRoot, sessionId);
  const worker = await launcher.launch({
    ...rest,
    repoRoot,
    sessionId,
    sessionDirectory: sessionVmDirectory(repoRoot, sessionId),
    ...(executions
      ? {
          executions: (published) => {
            executions(published);
            return () => {};
          },
        }
      : {}),
  } satisfies IsolatedLaunchOptions);
  return {
    binding: worker.binding,
    input: worker.input,
    output: worker.output,
    exited: worker.exited,
    pid: worker.pid,
    terminate: worker.terminate,
    cleanup: async () => {
      await worker.cleanup?.();
      await worker.settled;
    },
    failure: async () => (await worker.failure?.()) ?? new Error("Session worker exited"),
    supervisor: () => supervisorPid(worker.binding.state),
    status: async () =>
      JSON.parse(await Deno.readTextFile(join(worker.binding.state, "status.json"))),
  };
};

/** Stop every session VM launcher this script created. */
export const closeTestLaunchers = async () => {
  await Promise.allSettled([...launchers.values()].map((launcher) => launcher.close()));
  launchers.clear();
};
