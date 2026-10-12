import { setTimeout as delay } from "node:timers/promises";
import { legacyDaemonPid, readDaemonRecord, type DaemonRecord } from "@loom/core/daemon-endpoint";
import { releaseFlock } from "@loom/core/flock";
import type { LoomPaths } from "@loom/core/paths";

/** How long a starting daemon retries the lock: a client's probe holds it shared for a moment. */
const LOCK_RETRY_MS = 500;

export class DaemonAlreadyRunning extends Error {
  constructor(record: DaemonRecord | null) {
    super(`a Loom daemon is already running for this repo${record ? ` (pid ${record.pid})` : ""}`);
    this.name = "DaemonAlreadyRunning";
  }
}

/** A daemon from before the XDG layout still serves this repository from `<repo>/.loom`. */
export class LegacyDaemonRunning extends Error {
  constructor(pid: number, dir: string) {
    super(
      `a Loom daemon from an older version is still running for this repo (pid ${pid}, ${dir}); ` +
        "stop it with `loom stop`, then start Loom again",
    );
    this.name = "LegacyDaemonRunning";
  }
}

/** The repository's lock, held until `release`. */
export interface RepositoryLock {
  record: DaemonRecord;
  /** Never throws: why the record could not be cleared or the lock released, else null. */
  release: () => string | null;
}

/**
 * Take the exclusive `flock` on `lock` that makes this the repository's daemon,
 * and record this process in it. Only the lock says a daemon runs, so nothing
 * here judges a recorded pid: a crash or a reboot releases the lock with its
 * holder. The file is never removed — a new inode would let a second daemon lock
 * it beside the first.
 */
export const lockRepository = async (lock: string, epoch: string): Promise<RepositoryLock> => {
  const file = await Deno.open(lock, { read: true, write: true, create: true, mode: 0o600 });
  const deadline_ms = Date.now() + LOCK_RETRY_MS;
  while (!(await file.tryLock(true))) {
    if (Date.now() >= deadline_ms) {
      file.close();
      throw new DaemonAlreadyRunning(readDaemonRecord(lock));
    }
    await delay(25);
  }
  const record: DaemonRecord = { pid: Deno.pid, epoch, startedAt: Date.now() };
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  await file.truncate(0);
  let written = 0;
  while (written < bytes.length) written += await file.write(bytes.subarray(written));
  return {
    record,
    release: () => {
      const cleared = attempt(() => file.truncateSync(0));
      const closed = attempt(() => releaseFlock(file));
      return cleared ?? closed;
    },
  };
};

/** `fn`'s error as a message, or null when it returned. */
const attempt = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** This run's identity, and the lock it holds unless it is standalone. */
export interface RepositoryClaim {
  epoch: string;
  lock: RepositoryLock | null;
}

/** Take the lock, then refuse if a daemon from before the XDG layout still runs. */
export const claimRepository = async (paths: LoomPaths, epoch: string): Promise<RepositoryLock> => {
  const lock = await lockRepository(paths.lock, epoch);
  const legacy = legacyDaemonPid(paths);
  if (legacy !== null) {
    lock.release();
    throw new LegacyDaemonRunning(legacy, paths.legacy.dir);
  }
  return lock;
};

/**
 * Fires `onIdle` after the daemon has been continuously idle (no active
 * sessions, no connected clients) for `minutes`. Any call to `poke(true)`
 * before then cancels the pending fire. `minutes <= 0` disables the timer.
 */
export class IdleTimer {
  #ms: number;
  #onIdle: () => void;
  #timer: NodeJS.Timeout | null = null;

  constructor(minutes: number, onIdle: () => void) {
    this.#ms = minutes > 0 ? minutes * 60_000 : 0;
    this.#onIdle = onIdle;
  }

  /** `busy` true = there is something keeping the daemon alive. */
  poke(busy: boolean): void {
    if (this.#ms === 0) return;
    if (busy) {
      this.#clear();
      return;
    }
    if (this.#timer) return; // already counting down
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#onIdle();
    }, this.#ms);
    this.#timer.unref();
  }

  /** Re-arm with a new interval (config reload). Clears any running countdown;
   *  the next `poke(false)` starts a fresh one. */
  setMinutes(minutes: number): void {
    this.#ms = minutes > 0 ? minutes * 60_000 : 0;
    this.#clear();
  }

  stop(): void {
    this.#clear();
  }

  #clear(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
