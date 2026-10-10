/**
 * Launcher selection for real-VM acceptance scripts. LOOM_TEST_LAUNCHER=isolation
 * runs a script's agent sessions through the isolation adapter, as the daemon does
 * with session.isolation.launcher = "isolation"; anything else keeps the legacy
 * session-vm-worker path. Preparation and environment-only launches are not agent
 * sessions, so both launchers run them on the legacy path, as Loom itself does.
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
import {
  launchSessionVm,
  type SessionVmStatus,
} from "../../backend/daemon/src/daemon/session-vm-worker.ts";
import type { SessionExecutions } from "../../core/src/connector.ts";
import { supervisorPid } from "./host-processes.ts";

export type TestLauncher = "legacy" | "isolation";
const configured = Deno.env.get("LOOM_TEST_LAUNCHER") ?? "legacy";
if (configured !== "legacy" && configured !== "isolation")
  throw new Error("LOOM_TEST_LAUNCHER must be legacy or isolation");
export const testLauncher: TestLauncher = configured;
console.error("Session VM launcher: " + testLauncher);

type LegacyWorker = Awaited<ReturnType<typeof launchSessionVm>>;
export type TestSessionVmOptions = Parameters<typeof launchSessionVm>[0] & {
  /** Isolation only: receives the environment's executions while its worker runs. */
  executions?: (executions: SessionExecutions) => void;
};
/** What scripts use from a session VM worker, on either launcher. */
export type TestSessionWorker = Pick<
  LegacyWorker,
  "binding" | "input" | "output" | "exited" | "pid" | "terminate" | "cleanup" | "failure"
> & {
  status(): Promise<SessionVmStatus>;
  /** The VM's supervisor; on the isolation launcher, `pid` is the worker execution. */
  supervisor(): Promise<number | undefined>;
  launcher: TestLauncher;
};

const launchers = new Map<string, ReturnType<typeof createIsolatedWorkerLauncher>>();
let anonymous = 0;

/**
 * Launch an agent session VM on the selected launcher. The isolation adapter keeps
 * each session's state in its canonical directory (see sessionVmDirectory), so a
 * script that names a session directory must use that location; its basename is
 * then the session identity. Without one, an identity is assigned.
 */
export const launchTestSessionVm = async (
  options: TestSessionVmOptions,
): Promise<TestSessionWorker> => {
  const { executions, ...launch } = options;
  if (testLauncher === "legacy" || launch.preparationOnly || launch.environmentOnly) {
    const worker = await launchSessionVm(launch);
    return { ...worker, supervisor: async () => worker.pid, launcher: "legacy" };
  }
  // Session state must never land in the user's own state directory.
  if (!Deno.env.get("XDG_STATE_HOME"))
    throw new Error("Set a private XDG_STATE_HOME before launching isolated session VMs");
  const repoRoot = await Deno.realPath(launch.repoRoot ?? launch.workspace);
  let launcher = launchers.get(repoRoot);
  if (!launcher) launchers.set(repoRoot, (launcher = createIsolatedWorkerLauncher(repoRoot)));
  const named = launch.sessionDirectory && basename(launch.sessionDirectory);
  const sessionId = launch.sessionId ?? named ?? `script-${Deno.pid}-${++anonymous}`;
  if (
    launch.sessionDirectory &&
    launch.sessionDirectory !== sessionVmDirectory(repoRoot, sessionId)
  )
    throw new Error("Isolated session state must use sessionVmDirectory(repoRoot, sessionId)");
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
    launcher: "isolation",
  };
};

/** Stop every isolation launcher this script created. */
export const closeTestLaunchers = async () => {
  await Promise.allSettled([...launchers.values()].map((launcher) => launcher.close()));
  launchers.clear();
};
