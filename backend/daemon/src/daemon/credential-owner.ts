/** Host credential lifecycle shared by native provider VM backends. */
import { join } from "node:path";
export interface AccessCredential {
  accessToken: string;
  expiresAt: number;
}
export class CredentialAuthError extends Error {
  readonly code: "needs_login" | "refresh_failed" | "refresh_timeout" | "closed";
  /** Only sanitized, provider-selected diagnostics belong in detail. */
  readonly detail: string;
  constructor(code: CredentialAuthError["code"], detail = "") {
    super(`Provider authentication: ${code.replaceAll("_", " ")}${detail ? ` (${detail})` : ""}`);
    this.code = code;
    this.detail = detail;
  }
}
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(new CredentialAuthError("closed"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
export interface CredentialOwnerOptions<T extends AccessCredential, S> {
  profile: string;
  cli: string;
  read(profile: string): Promise<T>;
  snapshot(value: T): S;
  expiresAt(value: S): number;
  refresh(profile: string, cli: string, value: T, signal: AbortSignal): Promise<void>;
  report?: (code: CredentialAuthError["code"] | "publish_failed", detail?: string) => void;
  pollMs?: number;
  refreshAheadMs?: number;
}
interface Subscriber<S> {
  write: (value: S) => Promise<void>;
  expired: () => void;
  delivered?: string;
  timer?: ReturnType<typeof setTimeout>;
  tail: Promise<void>;
}
export class CredentialOwner<T extends AccessCredential, S> {
  readonly #options: CredentialOwnerOptions<T, S>;
  readonly #abort = new AbortController();
  readonly #subscribers = new Set<Subscriber<S>>();
  #pending: Promise<S> | undefined;
  #loop: Promise<void> | undefined;
  #forcing = false;
  #retryAt = 0;
  #failures = 0;
  #terminalToken: string | undefined;
  constructor(options: CredentialOwnerOptions<T, S>) {
    this.#options = options;
  }
  /** Force is useful after an early authentication failure, before expiresAt. */
  current(force = false): Promise<S> {
    if (this.#abort.signal.aborted) return Promise.reject(new CredentialAuthError("closed"));
    if (this.#pending) {
      if (force && !this.#forcing) return this.#pending.then(() => this.current(true));
      return this.#pending;
    }
    this.#forcing = force;
    return (this.#pending = this.#current(force).finally(() => {
      this.#pending = undefined;
      this.#forcing = false;
    }));
  }
  async #current(force: boolean): Promise<S> {
    const { profile } = this.#options;
    let value = await this.#options.read(profile);
    const ahead = this.#options.refreshAheadMs ?? 5 * 60_000;
    const initial = value.accessToken;
    if (force || value.expiresAt - Date.now() <= ahead) {
      if (this.#terminalToken === initial && !force) {
        if (value.expiresAt <= Date.now()) throw new CredentialAuthError("needs_login");
        return this.#options.snapshot(value);
      }
      if (!force && Date.now() < this.#retryAt) {
        if (value.expiresAt <= Date.now()) throw new CredentialAuthError("refresh_failed");
        return this.#options.snapshot(value);
      }
      const lock = await Deno.open(join(profile, ".loom-auth-refresh.lock"), {
        create: true,
        read: true,
        write: true,
        mode: 0o600,
      });
      try {
        const deadline = Date.now() + 70_000;
        while (!(await lock.tryLock(true))) {
          if (Date.now() > deadline) throw new CredentialAuthError("refresh_timeout");
          await delay(100, this.#abort.signal);
        }
        this.#abort.signal.throwIfAborted();
        value = await this.#options.read(profile);
        // Another owner may have refreshed while we waited, including forced refresh.
        if (value.accessToken === initial && (force || value.expiresAt - Date.now() <= ahead)) {
          await this.#options.refresh(profile, this.#options.cli, value, this.#abort.signal);
          value = await this.#options.read(profile);
          if (value.expiresAt <= Date.now() || value.accessToken === initial)
            throw new CredentialAuthError("refresh_failed");
        }
        this.#failures = 0;
        this.#retryAt = 0;
        this.#terminalToken = undefined;
      } catch (error) {
        // The CLI can persist a rotation before a later login step fails, or an
        // external provider process can refresh concurrently. Never discard that token.
        const updated = await this.#options.read(profile).catch(() => undefined);
        if (
          !this.#abort.signal.aborted &&
          updated &&
          updated.accessToken !== initial &&
          updated.expiresAt > Date.now()
        ) {
          this.#failures = 0;
          this.#retryAt = 0;
          this.#terminalToken = undefined;
          return this.#options.snapshot(updated);
        }
        const failure =
          error instanceof CredentialAuthError ? error : new CredentialAuthError("refresh_failed");
        this.#options.report?.(failure.code, failure.detail);
        if (failure.code === "needs_login") this.#terminalToken = initial;
        this.#retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(this.#failures++, 6));
        // Preserve a still-valid token during transient refresh failures.
        if (force || value.expiresAt <= Date.now() || this.#abort.signal.aborted) throw failure;
      } finally {
        lock.close();
      }
    }
    if (this.#abort.signal.aborted) throw new CredentialAuthError("closed");
    return this.#options.snapshot(value);
  }
  async subscribe(
    write: Subscriber<S>["write"],
    expired: Subscriber<S>["expired"],
  ): Promise<() => Promise<void>> {
    const subscriber: Subscriber<S> = { write, expired, tail: Promise.resolve() };
    // Register before initial publication so a concurrent refresh cannot be missed.
    this.#subscribers.add(subscriber);
    try {
      await this.#publish(subscriber, await this.current());
    } catch (error) {
      this.#subscribers.delete(subscriber);
      clearTimeout(subscriber.timer);
      throw error;
    }
    this.#loop ??= this.#watch();
    return async () => {
      this.#subscribers.delete(subscriber);
      clearTimeout(subscriber.timer);
      await subscriber.tail.catch(() => {});
    };
  }
  #delivery: Promise<void> = Promise.resolve();
  #publish(subscriber: Subscriber<S>, value: S): Promise<void> {
    const serialized = JSON.stringify(value);
    const next = subscriber.tail
      .catch(() => {})
      .then(async () => {
        if (
          subscriber.delivered === serialized ||
          !this.#subscribers.has(subscriber) ||
          this.#abort.signal.aborted
        )
          return;
        await subscriber.write(JSON.parse(serialized));
        subscriber.delivered = serialized;
        if (!this.#subscribers.has(subscriber)) return;
        clearTimeout(subscriber.timer);
        // Expiry enforcement is independent of a slow refresh or publisher.
        const expire = () => {
          const remaining = this.#options.expiresAt(value) - Date.now();
          if (remaining <= 0) {
            subscriber.expired();
            return;
          }
          subscriber.timer = setTimeout(expire, Math.min(remaining, 2_147_000_000));
        };
        expire();
      });
    subscriber.tail = next;
    return next;
  }
  async #watch() {
    try {
      while (!this.#abort.signal.aborted) {
        await delay(this.#options.pollMs ?? 1000, this.#abort.signal);
        if (!this.#subscribers.size) continue;
        try {
          const value = await this.current();
          this.#delivery = Promise.all(
            [...this.#subscribers].map(async (subscriber) => {
              try {
                await this.#publish(subscriber, value);
              } catch {
                this.#options.report?.("publish_failed");
                // A failed write must not let an expired last-delivered token keep running.
                const old = subscriber.delivered
                  ? this.#options.expiresAt(JSON.parse(subscriber.delivered))
                  : 0;
                if (old <= Date.now()) subscriber.expired();
              }
            }),
          ).then(() => {});
          await this.#delivery;
        } catch (error) {
          this.#options.report?.(
            error instanceof CredentialAuthError ? error.code : "refresh_failed",
          );
          // Existing subscribers retain valid credentials until their independent expiry timers fire.
        }
      }
    } catch {
      /* closed */
    }
  }
  async close() {
    this.#abort.abort();
    for (const subscriber of this.#subscribers) {
      clearTimeout(subscriber.timer);
      subscriber.expired();
    }
    await this.#pending?.catch(() => {});
    await this.#loop;
    await Promise.allSettled([...this.#subscribers].map((subscriber) => subscriber.tail));
    this.#subscribers.clear();
  }
}
