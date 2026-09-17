import type { WorkerProcess } from "./worker-launch.ts";

// Host-only metadata survives provider wrappers without entering the worker protocol.
export const startupSignal = Symbol("startupSignal");
export type StartupOptions = { [startupSignal]?: AbortSignal };
export const signalOf = (input: object): AbortSignal | undefined =>
  (input as StartupOptions)[startupSignal];

export const startWorker = async <T>(
  input: object,
  start: (own: <W extends WorkerProcess>(worker: W) => W) => Promise<T>,
): Promise<T> => {
  const signal = signalOf(input);
  let worker: WorkerProcess | undefined;
  const abort = () => worker?.terminate();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await start((value) => {
      worker = value;
      if (signal?.aborted) value.terminate();
      signal?.throwIfAborted();
      return value;
    });
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (worker) {
      worker.terminate();
      await worker.cleanup?.();
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
};
