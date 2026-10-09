/** Runtime reasons are translated into backend diagnostics by the launch adapter. */
export type StopReason = "user_stop" | "idle_suspension" | "owner_shutdown" | "backend_failure";

export interface LifecycleOptions {
  /** start() consumes this resource, even when it rejects or reuses a live environment.
   * Callers retain ownership only until start() is invoked. Repeated starts may
   * reference the same live resource; a fresh resource is required after disposal.
   * Failed cleanup of a retained environment can be retried with stop/close.
   * Unused resources are disposed before start settles; disposal errors are
   * reported to that caller, not retained as an environment cleanup operation.
   */
  capabilities?: { close(): Promise<void>; failed: Promise<unknown> };
}

export interface EnvironmentHandle<Request, Transport extends object> {
  /** Backend readiness precedes initialization; neither permits execution until both finish. */
  ready: Promise<void>;
  /** Exit triggers cleanup; it is not itself evidence that cleanup succeeded. */
  exited: Promise<unknown>;
  initialize(signal: AbortSignal): Promise<void>;
  /** Cancel startup too, and resolve only after owned processes/resources have been reaped. */
  close(reason: StopReason): Promise<void>;
  command(
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
    env: Record<string, string>,
  ): Promise<{ code: number; output: string; timedOut: boolean }>;
  execution(request: Request): Transport;
}

/** Return an owned handle before waiting for readiness so startup can be cancelled. */
export type EnvironmentLauncher<Options, Request, Transport extends object> = (
  context: {
    id: string;
    directory: string;
    onStop(isCurrent: () => boolean): Promise<void>;
  },
  options: Options,
) => Promise<EnvironmentHandle<Request, Transport>>;
