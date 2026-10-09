import { randomUUID } from "node:crypto";
import { IsolationError } from "./errors.ts";

export interface ExecutionOwner {
  readonly signal: AbortSignal;
}

/** Shared by foreground terminals and coordinator-owned commands. */
export class ExecutionLeases {
  #activity = new Map<string, number>();

  lastActivity(id: string): number {
    return this.#activity.get(id) ?? 0;
  }
  #leases = new Map<
    string,
    {
      id: string;
      exclusive?: string;
      owner: ExecutionOwner;
      cancel: AbortController;
      release: () => void;
      done: Promise<void>;
    }
  >();

  has(id: string): boolean {
    return [...this.#leases.values()].some((lease) => lease.id === id);
  }

  assertIdle(id: string): void {
    if (this.has(id))
      throw new IsolationError("busy", "Exit the session's open shells and active commands first.");
  }

  acquire(id: string, owner: ExecutionOwner, releaseOnDisconnect = false, exclusive?: string) {
    if (owner.signal.aborted)
      throw new IsolationError("disconnected", "Execution connection closed.");
    if (
      exclusive &&
      [...this.#leases.values()].some((l) => l.id === id && l.exclusive === exclusive)
    )
      throw new IsolationError(
        "busy",
        "An exclusive execution is already running in this environment.",
      );
    const token = randomUUID();
    const cancel = new AbortController();
    const done = Promise.withResolvers<void>();
    const release = () => {
      owner.signal.removeEventListener("abort", disconnected);
      cancel.signal.removeEventListener("abort", release);
      if (this.#leases.delete(token)) this.#activity.set(id, Date.now());
      done.resolve();
    };
    const disconnected = () => {
      cancel.abort();
      // Terminal transport is owned by the client; it dies with the connection.
      // Host commands retain their lease until their process and output have settled.
      if (releaseOnDisconnect) release();
    };
    this.#leases.set(token, {
      id,
      owner,
      cancel,
      release,
      done: done.promise,
      ...(exclusive ? { exclusive } : {}),
    });
    this.#activity.set(id, Date.now());
    owner.signal.addEventListener("abort", disconnected, { once: true });
    if (releaseOnDisconnect) cancel.signal.addEventListener("abort", release, { once: true });
    return { token, signal: cancel.signal, release };
  }

  async run<T>(
    id: string,
    owner: ExecutionOwner,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const lease = this.acquire(id, owner);
    try {
      return await action(lease.signal);
    } finally {
      lease.release();
    }
  }

  close(token: string, owner: ExecutionOwner): void {
    const lease = this.#leases.get(token);
    if (lease && lease.owner !== owner)
      throw new IsolationError("bad_request", "This execution belongs to another connection.");
    lease?.release();
  }

  /** Forced teardown aborts processes but keeps leases until owners finish cleanup. */
  async cancel(id: string): Promise<void> {
    const leases = [...this.#leases.values()].filter((lease) => lease.id === id);
    for (const lease of leases) lease.cancel.abort();
    await Promise.all(leases.map((lease) => lease.done));
  }
}
