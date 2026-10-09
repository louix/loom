import type { LifecycleOptions } from "@loom/isolation/environment";
import type { HostStopReason } from "../../../core/src/vm-termination.ts";
import type { InitHook } from "../../../core/src/init-hook.ts";
import type { EnvironmentVmConfiguration, launchEnvironmentVm } from "./environment-launch.ts";
import type { vmCommand } from "./command.ts";

type Vm = Awaited<ReturnType<typeof launchEnvironmentVm>>;
export type ConfiguredLaunch = EnvironmentVmConfiguration &
  LifecycleOptions & { startHooks?: InitHook[] };
export type ConfigureEnvironment = (
  command: (source: string, timeoutMs: number) => ReturnType<typeof vmCommand>,
  signal: AbortSignal,
) => Promise<ConfiguredLaunch>;

/**
 * One coordinator entry across inspection and execution. The inspection VM is
 * fully reaped before replacement; no command transport is exposed before setup.
 */
export const configuredEnvironment = (
  initial: Vm,
  configure: ConfigureEnvironment,
  backend: {
    launch(options: EnvironmentVmConfiguration): ReturnType<typeof launchEnvironmentVm>;
    command: typeof vmCommand;
  },
) => {
  let current: Vm | undefined = initial;
  let capabilities: LifecycleOptions["capabilities"];
  let initializing: Promise<InitHook[]> | undefined;
  let closing: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  const stop = new AbortController();
  const exited = Promise.withResolvers<void>();
  const intentional = new WeakSet<Vm>();
  const watch = (vm: Vm) => {
    void vm.exited.then(
      () => {
        if (!intentional.has(vm)) exited.resolve();
      },
      () => {
        if (!intentional.has(vm)) exited.resolve();
      },
    );
  };
  watch(initial);
  const closeCurrent = (reason: HostStopReason): Promise<void> => {
    if (closing) return closing;
    const vm = current;
    if (!vm) return Promise.resolve();
    intentional.add(vm);
    closing = vm
      .close(reason)
      .then(() => {
        if (current === vm) current = undefined;
      })
      .finally(() => {
        closing = undefined;
      });
    return closing;
  };
  return {
    get binding() {
      if (!current) throw new Error("Environment is not ready for execution.");
      return current.binding;
    },
    ready: initial.ready,
    exited: exited.promise,
    initialize(signal: AbortSignal): Promise<InitHook[]> {
      return (initializing ??= (async () => {
        const stopped = AbortSignal.any([signal, stop.signal]);
        stopped.throwIfAborted();
        const resolved = await configure(
          (source, timeoutMs) => backend.command(initial.binding, source, timeoutMs, stopped),
          stopped,
        );
        capabilities = resolved.capabilities;
        if (capabilities)
          void capabilities.failed.then(
            () => exited.resolve(),
            () => exited.resolve(),
          );
        stopped.throwIfAborted();
        await closeCurrent("session_close");
        stopped.throwIfAborted();
        const { capabilities: _capabilities, startHooks = [], ...options } = resolved;
        current = await backend.launch(options);
        watch(current);
        stopped.throwIfAborted();
        await current.ready;
        stopped.throwIfAborted();
        return startHooks;
      })());
    },
    close(reason: HostStopReason): Promise<void> {
      if (cleanup) return cleanup;
      // Publish before abort callbacks or resource disposal can re-enter close.
      cleanup = Promise.resolve()
        .then(async () => {
          const failures: unknown[] = [];
          try {
            await closeCurrent(reason);
          } catch (error) {
            failures.push(error);
          }
          // Configuration or replacement launch can acquire resources after cancellation.
          await initializing?.catch(() => {});
          if (!failures.length) {
            try {
              await closeCurrent(reason);
            } catch (error) {
              failures.push(error);
            }
          }
          try {
            await capabilities?.close();
            capabilities = undefined;
          } catch (error) {
            failures.push(error);
          }
          if (failures.length)
            throw new AggregateError(failures, "Configured environment cleanup failed");
        })
        .catch((error) => {
          cleanup = undefined; // Only remaining obligations participate in the retry.
          throw error;
        });
      stop.abort();
      return cleanup;
    },
  };
};
