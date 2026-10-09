/** Opt-in VM launcher using the existing connector WorkerProcess contract. */
import {
  launchSessionVm,
  type SessionVmOptions,
} from "../../../../runtime/src/session-vm/launch.ts";

// Launch and resource ownership live in the runtime, shared with VM environments.
export {
  launchSessionVm,
  sessionVmGeneration,
  type SessionVmOptions,
  type SessionVmStatus,
} from "../../../../runtime/src/session-vm/launch.ts";

/** A provider owns launches too, including VMs still waiting for agent readiness. */
export const createSessionVmLauncher = () => {
  let closed = false;
  const launches = new Set<Promise<Awaited<ReturnType<typeof launchSessionVm>>>>();
  return {
    launch(options: SessionVmOptions) {
      if (closed) throw new Error("Session VM provider is shutting down");
      const pending = launchSessionVm(options).then(async (worker) => {
        if (closed) {
          worker.terminate("daemon_shutdown");
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
          worker.terminate("daemon_shutdown");
          await worker.cleanup?.();
        }),
      );
    },
  };
};
