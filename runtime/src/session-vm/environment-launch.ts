import type { HostStopReason } from "../../../core/src/vm-termination.ts";
import { readEnvironmentOutput } from "./environment-protocol.ts";
import { launchSessionVm, type SessionVmOptions, type SessionVmStatus } from "./launch.ts";
import type { VmBinding } from "../packaged/vm.ts";

export type EnvironmentVmOptions = Omit<
  SessionVmOptions,
  "preparationOnly" | "prepareHooks" | "environmentOnly"
>;
/** Coordinator injects these fields after accepting a launch configuration. */
export type EnvironmentVmConfiguration = Omit<
  EnvironmentVmOptions,
  "sessionId" | "sessionDirectory" | "onStop"
>;

export interface VmEnvironment {
  binding: VmBinding;
  pid: number;
  ready: Promise<void>;
  exited: Promise<unknown>;
  status(): Promise<SessionVmStatus>;
  close(reason?: HostStopReason): Promise<void>;
  /** Credential-free diagnosis of the VM, available once it has exited. */
  failure?(): Promise<Error | undefined>;
  /** The first recorded host reason wins; later termination keeps it. */
  setStopReason?(reason: HostStopReason): void;
}

/**
 * Start the existing supervised VM without constructing a conversation worker.
 * The returned handle owns startup too: close() cancels it before ready resolves.
 * Callers must await ready before using the command/shell transports.
 */
export const launchEnvironmentVm = async (
  options: EnvironmentVmOptions,
): Promise<VmEnvironment> => {
  const worker = await launchSessionVm({
    ...options,
    // Unlike agent sessions, environments get no provider egress by default.
    providerHosts: options.providerHosts ?? [],
    environmentOnly: true,
  });
  const ready = Promise.withResolvers<void>();
  let initialized = false;
  // Observe immediately; callers may cancel before they begin waiting for readiness.
  void ready.promise.catch(() => {});
  const monitor = (async () => {
    try {
      await readEnvironmentOutput(worker.output, () => {
        initialized = true;
        ready.resolve();
      });
    } catch {
      worker.terminate();
    } finally {
      if (!initialized) {
        await worker.exited;
        ready.reject(await worker.failure!());
      }
    }
  })();
  void monitor.catch(ready.reject);
  return {
    binding: worker.binding,
    pid: worker.pid,
    ready: ready.promise,
    exited: worker.exited,
    status: worker.status,
    failure: worker.failure!,
    setStopReason: worker.setStopReason!,
    async close(reason: HostStopReason = "session_close") {
      worker.terminate(reason);
      await worker.cleanup!();
      await monitor;
    },
  };
};
