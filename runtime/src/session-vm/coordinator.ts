import { EnvironmentCoordinator } from "@loom/isolation/coordinator";
import type {
  EnvironmentLauncher,
  LifecycleOptions,
  StopReason,
} from "@loom/isolation/environment";
import type { EnvironmentStorage } from "@loom/isolation/storage";
import { ExecutionLeases } from "@loom/isolation/execution-leases";
import type { InitHook } from "../../../core/src/init-hook.ts";
import type { ExecutionOptions, ExecutionTarget } from "../../../core/src/execution.ts";
import type { HostStopReason } from "../../../core/src/vm-termination.ts";
import { vmCommand } from "./command.ts";
import { vmExecutionCommand } from "./execution.ts";
import {
  launchEnvironmentVm,
  type EnvironmentVmOptions,
  type EnvironmentVmConfiguration,
} from "./environment-launch.ts";
import { configuredEnvironment, type ConfigureEnvironment } from "./configured-environment.ts";
import {
  environmentEnabled,
  type SessionEnvironment,
} from "../../../core/src/session-environment.ts";

type ExecutionStartOptions = EnvironmentVmConfiguration &
  LifecycleOptions & {
    mode: "execution";
    startHooks?: InitHook[];
    configure?: never;
  };

type InspectionStartOptions = Pick<
  EnvironmentVmOptions,
  "workspace" | "artifact" | "smolvm" | "privateWorkspace" | "onProgress" | "activity" | "provider"
> & {
  mode: "inspection";
  repoRoot: string;
  clone: NonNullable<EnvironmentVmOptions["clone"]>;
  configure: ConfigureEnvironment;
  environment?: SessionEnvironment & { autoNix: false; commandPrefix: [] };
  auth?: never;
  authOwner?: never;
  capabilities?: never;
  mcpRelays?: never;
  providerHosts?: never;
  extraAllowedHosts?: never;
  gitIdentity?: never;
  startHooks?: never;
};

export type EnvironmentStartOptions = ExecutionStartOptions | InspectionStartOptions;

const hostReason = (reason: StopReason): HostStopReason => {
  if (reason === "owner_shutdown") return "daemon_shutdown";
  if (reason === "backend_failure") return "worker_failure";
  return reason;
};

/** VM-only launch adapter. Local execution is selected by Loom, never here. */
export const createVmEnvironmentLauncher =
  (
    backend = { launch: launchEnvironmentVm, command: vmCommand },
  ): EnvironmentLauncher<EnvironmentStartOptions, ExecutionOptions, Pick<ExecutionTarget, "vm">> =>
  async ({ id, directory, onStop }, options) => {
    const { mode, startHooks = [], configure, capabilities: _capabilities, ...launch } = options;
    // Inspection reads untrusted repository files: no credentials, relays or setup.
    const inspectionGrants =
      options.auth ||
      options.authOwner ||
      options.capabilities ||
      options.gitIdentity ||
      options.mcpRelays?.length ||
      options.providerHosts?.length ||
      options.extraAllowedHosts?.length ||
      startHooks.length ||
      environmentEnabled(options.environment);
    if (mode === "inspection" && (!options.clone || inspectionGrants))
      throw new Error(
        "Checkout inspection requires a credential-free clone without setup or network grants.",
      );
    const initial = await backend.launch({
      ...launch,
      sessionId: id,
      sessionDirectory: directory,
      onStop,
    });
    const configured =
      mode === "inspection"
        ? configuredEnvironment(initial, configure, {
            ...backend,
            launch: (resolved) =>
              backend.launch({
                ...resolved,
                sessionId: id,
                sessionDirectory: directory,
                onStop,
                ...(options.onProgress ? { onProgress: options.onProgress } : {}),
              }),
          })
        : undefined;
    const environment = configured ?? initial;
    return {
      ready: environment.ready,
      exited: environment.exited,
      close: (reason) => environment.close(hostReason(reason)),
      command: (command, timeoutMs, signal, env) =>
        backend.command(environment.binding, command, timeoutMs, signal, env),
      execution: (request) => ({ vm: vmExecutionCommand(environment.binding, request) }),
      async initialize(signal) {
        const hooks = configured ? await configured.initialize(signal) : startHooks;
        for (const hook of hooks) {
          signal.throwIfAborted();
          options.onProgress?.("Running workspace hook: " + hook.name);
          const result = await backend.command(
            environment.binding,
            hook.run,
            hook.timeoutMs,
            signal,
            { LOOM_HOOK: hook.name, LOOM_HOOK_EVENT: "workspace_start", LOOM_SESSION_ID: id },
          );
          signal.throwIfAborted();
          if (result.code !== 0 || result.timedOut)
            throw new Error(
              "Workspace hook " +
                hook.name +
                (result.timedOut ? " timed out" : " exited " + result.code) +
                ":\n" +
                result.output,
            );
        }
      },
    };
  };

/** Portable VM lifecycle ownership, also usable without Loom's session layer. */
export const createVmEnvironmentCoordinator = (
  storage: EnvironmentStorage,
  backend = { launch: launchEnvironmentVm, command: vmCommand },
  leases = new ExecutionLeases(),
) => new EnvironmentCoordinator(storage, createVmEnvironmentLauncher(backend), leases);
export type VmEnvironmentCoordinator = ReturnType<typeof createVmEnvironmentCoordinator>;
