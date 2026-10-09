import { ExecutionLeases, type ExecutionOwner } from "./execution-leases.ts";
import type { EnvironmentStorage } from "./storage.ts";
import { IsolationError } from "./errors.ts";
import type {
  EnvironmentHandle,
  EnvironmentLauncher,
  LifecycleOptions,
  StopReason,
} from "./environment.ts";

type Lifecycle<Request, Transport extends object> =
  | { kind: "starting" }
  | { kind: "initializing"; completion: Promise<void> }
  | { kind: "ready"; environment: EnvironmentHandle<Request, Transport> }
  // Inventory grants permission to stop before the backend begins its own teardown.
  | { kind: "stop-requested"; initialization: Promise<void> | null }
  | { kind: "stopping"; completion: Promise<void> }
  | { kind: "failed"; initialization: Promise<void> | null };

type Entry<Request, Transport extends object> = {
  lifecycle: Lifecycle<Request, Transport>;
  launched: Promise<EnvironmentHandle<Request, Transport>>;
  ready: Promise<void>;
  abort: AbortController;
  capabilities?: LifecycleOptions["capabilities"];
};

/**
 * Environment ownership, independent of repository identity and conversation state.
 * Starts reuse the current generation; changed options apply after an explicit stop.
 * Durable workspace selection and grants are resolved by the caller before start.
 */
export class EnvironmentCoordinator<Options, Request, Transport extends object> {
  readonly leases: ExecutionLeases;
  #entries = new Map<string, Entry<Request, Transport>>();
  #mutations = new Map<string, Promise<void>>();
  readonly #storage: EnvironmentStorage;
  readonly #launch: EnvironmentLauncher<Options, Request, Transport>;
  #closed = false;

  constructor(
    storage: EnvironmentStorage,
    launch: EnvironmentLauncher<Options, Request, Transport>,
    leases = new ExecutionLeases(),
  ) {
    this.leases = leases;
    this.#storage = storage;
    this.#launch = launch;
  }

  inspect(id: string): {
    phase: "starting" | "ready" | "stopping" | "failed" | "stopped";
    busy: boolean;
  } {
    const lifecycle = this.#entries.get(id)?.lifecycle;
    const phases = {
      starting: "starting",
      initializing: "starting",
      ready: "ready",
      "stop-requested": "stopping",
      stopping: "stopping",
      failed: "failed",
    } as const;
    return { phase: lifecycle ? phases[lifecycle.kind] : "stopped", busy: this.leases.has(id) };
  }

  /** Ownership transfers synchronously, before launch or any rejection. */
  start(id: string, options: Options & LifecycleOptions): Promise<void> {
    const { capabilities } = options;
    const existing = this.#entries.get(id);
    const unused =
      capabilities && capabilities !== existing?.capabilities ? capabilities : undefined;
    const reject = async (error: unknown): Promise<never> => {
      try {
        await unused?.close();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Environment start rejected and unused capability cleanup failed",
        );
      }
      throw error;
    };
    if (this.#closed) return reject(new Error("Environment coordinator is shutting down"));
    if (this.#mutations.has(id))
      return reject(new IsolationError("busy", "Environment workspace is being changed."));
    if (existing) {
      if (
        existing.lifecycle.kind === "stopping" ||
        existing.lifecycle.kind === "stop-requested" ||
        existing.lifecycle.kind === "failed"
      )
        return reject(
          new IsolationError("busy", "Environment cleanup must finish before restart."),
        );
      if (!unused) return existing.ready;
      return Promise.resolve()
        .then(() => unused.close())
        .then(() => existing.ready);
    }
    let directory: string;
    try {
      directory = this.#storage.directory(id);
    } catch (error) {
      return reject(error);
    }
    // Defer the launch until after ownership has been published synchronously.
    const entry: Entry<Request, Transport> = {
      lifecycle: { kind: "starting" },
      ...(capabilities ? { capabilities } : {}),
      abort: new AbortController(),
      launched: Promise.resolve().then(() => {
        if (entry.lifecycle.kind !== "starting") throw new Error("Environment startup cancelled");
        return this.#launch(
          {
            id,
            directory,
            onStop: async (isCurrent) => {
              if (this.#entries.get(id) !== entry || !isCurrent()) return;
              this.leases.assertIdle(id);
              const lifecycle = entry.lifecycle;
              switch (lifecycle.kind) {
                case "starting":
                case "ready":
                  entry.lifecycle = { kind: "stop-requested", initialization: null };
                  break;
                case "initializing":
                  entry.lifecycle = {
                    kind: "stop-requested",
                    initialization: lifecycle.completion,
                  };
                  break;
                case "stop-requested":
                case "stopping":
                case "failed":
                  break;
              }
              entry.abort.abort();
            },
          },
          options,
        );
      }),
      ready: Promise.resolve(),
    };
    this.#entries.set(id, entry);
    if (capabilities)
      void capabilities.failed
        .then(
          () => this.#stop(id, entry, "backend_failure", true),
          () => this.#stop(id, entry, "backend_failure", true),
        )
        .catch(() => {});
    entry.ready = (async () => {
      try {
        const environment = await entry.launched;
        void environment.exited
          .then(
            () => this.#stop(id, entry, "backend_failure", true),
            () => this.#stop(id, entry, "backend_failure", true),
          )
          .catch(() => {
            /* Keep failed cleanup visible and retryable. */
          });
        if (entry.lifecycle.kind !== "starting") throw new Error("Environment startup cancelled");
        await environment.ready;
        if (entry.lifecycle.kind !== "starting") throw new Error("Environment startup cancelled");
        const initializing = {
          kind: "initializing" as const,
          completion: Promise.resolve().then(() => environment.initialize(entry.abort.signal)),
        };
        entry.lifecycle = initializing;
        await initializing.completion;
        if (entry.lifecycle !== initializing) throw new Error("Environment startup cancelled");
        entry.lifecycle = { kind: "ready", environment };
      } catch (error) {
        await this.#stop(id, entry, "backend_failure", true);
        throw error;
      }
    })();
    void entry.ready.catch(() => {});
    return entry.ready;
  }

  #ready(id: string): EnvironmentHandle<Request, Transport> {
    const lifecycle = this.#entries.get(id)?.lifecycle;
    if (this.#closed || this.#mutations.has(id) || lifecycle?.kind !== "ready")
      throw new IsolationError("busy", "Environment is not ready for execution.");
    return lifecycle.environment;
  }

  /** Bounded shell-command transport for internal hooks and inspection. */
  async command(
    id: string,
    command: string,
    timeoutMs: number,
    owner: ExecutionOwner,
    env: Record<string, string> = {},
  ) {
    const environment = this.#ready(id);
    return await this.leases.run(id, owner, (signal) =>
      environment.command(command, timeoutMs, signal, env),
    );
  }

  /** Mutate a live workspace only while idle; exclude all new execution until output settles. */
  async exclusiveCommand(
    id: string,
    command: string,
    timeoutMs: number,
    owner: ExecutionOwner,
    env: Record<string, string> = {},
  ) {
    const environment = this.#ready(id);
    this.leases.assertIdle(id);
    const finished = Promise.withResolvers<void>();
    this.#mutations.set(id, finished.promise);
    try {
      return await this.leases.run(id, owner, (signal) =>
        environment.command(command, timeoutMs, signal, env),
      );
    } finally {
      this.#mutations.delete(id);
      finished.resolve();
    }
  }

  /** Hand off the foreground transport to a connected local client. */
  openExecution(
    id: string,
    options: Request,
    owner: ExecutionOwner,
    exclusive?: string,
  ): Transport & { token: string } {
    const environment = this.#ready(id);
    const target = environment.execution(options);
    const lease = this.leases.acquire(id, owner, true, exclusive);
    return { ...target, token: lease.token };
  }

  closeExecution(token: string, owner: ExecutionOwner): void {
    this.leases.close(token, owner);
  }

  stop(id: string, reason: StopReason = "user_stop"): Promise<void> {
    this.leases.assertIdle(id);
    const entry = this.#entries.get(id);
    return entry ? this.#stop(id, entry, reason, false) : Promise.resolve();
  }

  #stop(
    id: string,
    entry: Entry<Request, Transport>,
    reason: StopReason,
    force: boolean,
  ): Promise<void> {
    if (this.#entries.get(id) !== entry) return Promise.resolve();
    const lifecycle = entry.lifecycle;
    let initialization: Promise<void> | null;
    switch (lifecycle.kind) {
      case "stopping":
        return lifecycle.completion;
      case "starting":
      case "ready":
        initialization = null;
        break;
      case "initializing":
        initialization = lifecycle.completion;
        break;
      case "stop-requested":
      case "failed":
        initialization = lifecycle.initialization;
        break;
    }
    // Publish cleanup ownership before abort listeners or backend callbacks can reenter.
    const completion = Promise.resolve().then(async () => {
      const drained = force ? this.leases.cancel(id) : Promise.resolve();
      const environment = await entry.launched.catch(() => undefined);
      try {
        try {
          await environment?.close(reason);
        } finally {
          await entry.capabilities?.close();
          delete entry.capabilities;
        }
        await initialization?.catch(() => {});
        await drained;
        if (this.#entries.get(id) === entry) this.#entries.delete(id);
      } catch (error) {
        entry.lifecycle = { kind: "failed", initialization };
        throw error;
      }
    });
    entry.lifecycle = { kind: "stopping", completion };
    entry.abort.abort();
    return completion;
  }

  /** Keep both in-process exclusion and the existing disk lock through archive/delete. */
  async withStopped<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#mutations.has(id))
      throw new IsolationError("busy", "Environment lifecycle operation is already running.");
    this.leases.assertIdle(id);
    const finished = Promise.withResolvers<void>();
    this.#mutations.set(id, finished.promise);
    try {
      await this.stop(id);
      return await this.#storage.withStopped(id, action);
    } finally {
      this.#mutations.delete(id);
      finished.resolve();
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const results = await Promise.allSettled(
      [...this.#entries].map(([id, entry]) => this.#stop(id, entry, "owner_shutdown", true)),
    );
    await Promise.all(this.#mutations.values());
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Environment cleanup failed",
      );
  }
}
