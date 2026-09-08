/** Host-only Claude credential owner. Refresh tokens never enter VM snapshots. */
import { join } from "node:path";
import { homedir } from "node:os";

import type { ClaudeAccess } from "../../../../runtime/src/session-vm/auth.ts";
export type { ClaudeAccess } from "../../../../runtime/src/session-vm/auth.ts";
export interface ClaudeAuthSnapshot {
  claudeAiOauth: ClaudeAccess;
}
export class ClaudeAuthError extends Error {
  readonly code: "needs_login" | "refresh_failed" | "refresh_timeout" | "closed";
  constructor(code: ClaudeAuthError["code"], detail = "") {
    super(`Claude authentication: ${code.replaceAll("_", " ")}${detail ? ` (${detail})` : ""}`);
    this.code = code;
  }
}
const read = async (profile: string): Promise<ClaudeAccess & { refreshToken?: string }> => {
  try {
    const value = JSON.parse(
      await Deno.readTextFile(join(profile, ".credentials.json")),
    ).claudeAiOauth;
    if (
      !value ||
      typeof value.accessToken !== "string" ||
      !value.accessToken ||
      !Number.isFinite(value.expiresAt) ||
      !Array.isArray(value.scopes) ||
      !value.scopes.every((scope: unknown) => typeof scope === "string")
    )
      throw new Error();
    return {
      accessToken: value.accessToken,
      expiresAt: value.expiresAt,
      scopes: [...value.scopes],
      ...(typeof value.refreshToken === "string" && value.refreshToken
        ? { refreshToken: value.refreshToken }
        : {}),
    };
  } catch {
    throw new ClaudeAuthError("needs_login");
  }
};
const snapshot = (value: ClaudeAccess): ClaudeAuthSnapshot => ({
  claudeAiOauth: {
    accessToken: value.accessToken,
    expiresAt: value.expiresAt,
    scopes: [...value.scopes],
  },
});
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(new ClaudeAuthError("closed"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
/** The CLI owns its credential format and persists rotated refresh tokens itself. */
const runRefresh = async (
  profile: string,
  cli: string,
  credential: ClaudeAccess & { refreshToken?: string },
  signal: AbortSignal,
) => {
  if (!credential.refreshToken) throw new ClaudeAuthError("needs_login");
  signal.throwIfAborted();
  const child = new Deno.Command(cli, {
    args: ["auth", "login", "--claudeai"],
    cwd: profile,
    clearEnv: true,
    env: {
      HOME: homedir(),
      PATH: Deno.env.get("PATH") ?? "",
      CLAUDE_CONFIG_DIR: profile,
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: credential.refreshToken,
      CLAUDE_CODE_OAUTH_SCOPES: credential.scopes.join(" "),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* exited */
    }
  };
  signal.addEventListener("abort", kill, { once: true });
  let diagnostics = "";
  const drain = (stream: ReadableStream<Uint8Array>) =>
    stream
      .pipeTo(
        new WritableStream({
          write(bytes) {
            diagnostics = (diagnostics + new TextDecoder().decode(bytes)).slice(-8192);
          },
        }),
      )
      .catch(() => {});
  const drains = Promise.all([drain(child.stdout), drain(child.stderr)]);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, 60_000);
  try {
    const result = await child.status;
    await drains;
    if (timedOut) throw new ClaudeAuthError("refresh_timeout");
    if (signal.aborted) throw new ClaudeAuthError("closed");
    if (!result.success) {
      const status = /status code (\d{3})/i.exec(diagnostics)?.[1];
      const categories = [
        "certificate",
        "TLS",
        "ENOTFOUND",
        "ECONNREFUSED",
        "ECONNRESET",
        "EACCES",
        "ENOENT",
        "invalid_scope",
        "invalid_grant",
        "unauthorized_client",
      ].filter((code) => diagnostics.includes(code));
      throw new ClaudeAuthError(
        status === "400" ||
          status === "401" ||
          /invalid_grant|revoked|invalid refresh token/i.test(diagnostics)
          ? "needs_login"
          : "refresh_failed",
        [`CLI exit ${result.code}`, ...(status ? [`HTTP ${status}`] : []), ...categories].join(
          ", ",
        ),
      );
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
  }
};
export interface ClaudeAuthOptions {
  profile: string;
  cli: string;
  report?: (code: ClaudeAuthError["code"] | "publish_failed") => void;
  /** Test seam; production always uses the pinned Claude CLI. */
  refresh?: typeof runRefresh;
  pollMs?: number;
  refreshAheadMs?: number;
}
interface Subscriber {
  write: (value: ClaudeAuthSnapshot) => Promise<void>;
  expired: () => void;
  delivered?: string;
  timer?: ReturnType<typeof setTimeout>;
  tail: Promise<void>;
}
export class ClaudeAuthOwner {
  readonly #options: ClaudeAuthOptions;
  readonly #abort = new AbortController();
  readonly #subscribers = new Set<Subscriber>();
  #pending: Promise<ClaudeAuthSnapshot> | undefined;
  #loop: Promise<void> | undefined;
  #forcing = false;
  #retryAt = 0;
  #failures = 0;
  #terminalToken: string | undefined;
  constructor(options: ClaudeAuthOptions) {
    this.#options = options;
  }
  /** Force is useful after an early authentication failure, before expiresAt. */
  current(force = false): Promise<ClaudeAuthSnapshot> {
    if (this.#abort.signal.aborted) return Promise.reject(new ClaudeAuthError("closed"));
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
  async #current(force: boolean): Promise<ClaudeAuthSnapshot> {
    const { profile } = this.#options;
    let value = await read(profile);
    const ahead = this.#options.refreshAheadMs ?? 5 * 60_000;
    const initial = value.accessToken;
    if (force || value.expiresAt - Date.now() <= ahead) {
      if (this.#terminalToken === initial && !force) {
        if (value.expiresAt <= Date.now()) throw new ClaudeAuthError("needs_login");
        return snapshot(value);
      }
      if (!force && Date.now() < this.#retryAt) {
        if (value.expiresAt <= Date.now()) throw new ClaudeAuthError("refresh_failed");
        return snapshot(value);
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
          if (Date.now() > deadline) throw new ClaudeAuthError("refresh_timeout");
          await delay(100, this.#abort.signal);
        }
        this.#abort.signal.throwIfAborted();
        value = await read(profile);
        // Another owner may have refreshed while we waited, including forced refresh.
        if (value.accessToken === initial && (force || value.expiresAt - Date.now() <= ahead)) {
          await (this.#options.refresh ?? runRefresh)(
            profile,
            this.#options.cli,
            value,
            this.#abort.signal,
          );
          value = await read(profile);
          if (value.expiresAt <= Date.now() || value.accessToken === initial)
            throw new ClaudeAuthError("refresh_failed");
        }
        this.#failures = 0;
        this.#retryAt = 0;
        this.#terminalToken = undefined;
      } catch (error) {
        // The CLI can persist a rotation before a later login step fails, or an
        // external Claude process can refresh concurrently. Never discard that token.
        const updated = await read(profile).catch(() => undefined);
        if (
          !this.#abort.signal.aborted &&
          updated &&
          updated.accessToken !== initial &&
          updated.expiresAt > Date.now()
        ) {
          this.#failures = 0;
          this.#retryAt = 0;
          this.#terminalToken = undefined;
          return snapshot(updated);
        }
        const failure =
          error instanceof ClaudeAuthError ? error : new ClaudeAuthError("refresh_failed");
        this.#options.report?.(failure.code);
        if (failure.code === "needs_login") this.#terminalToken = initial;
        this.#retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(this.#failures++, 6));
        // Preserve a still-valid token during transient refresh failures.
        if (force || value.expiresAt <= Date.now() || this.#abort.signal.aborted) throw failure;
      } finally {
        lock.close();
      }
    }
    if (this.#abort.signal.aborted) throw new ClaudeAuthError("closed");
    return snapshot(value);
  }
  async subscribe(
    write: Subscriber["write"],
    expired: Subscriber["expired"],
  ): Promise<() => Promise<void>> {
    const subscriber: Subscriber = { write, expired, tail: Promise.resolve() };
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
  #publish(subscriber: Subscriber, value: ClaudeAuthSnapshot): Promise<void> {
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
          const remaining = value.claudeAiOauth.expiresAt - Date.now();
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
                  ? JSON.parse(subscriber.delivered).claudeAiOauth.expiresAt
                  : 0;
                if (old <= Date.now()) subscriber.expired();
              }
            }),
          ).then(() => {});
          await this.#delivery;
        } catch (error) {
          this.#options.report?.(error instanceof ClaudeAuthError ? error.code : "refresh_failed");
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
