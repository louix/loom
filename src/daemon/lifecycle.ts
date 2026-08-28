import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { pidAlive } from "./hygiene.ts";

export interface PidfileInfo {
  pid: number;
  epoch: string;
  startedAt: number;
}

export class DaemonAlreadyRunning extends Error {
  info: PidfileInfo;
  constructor(info: PidfileInfo) {
    super(`a Loom daemon is already running for this repo (pid ${info.pid})`);
    this.name = "DaemonAlreadyRunning";
    this.info = info;
  }
}

/**
 * Claim single-daemon-per-repo ownership by atomically creating the pidfile.
 * If it exists and names a live process, throws DaemonAlreadyRunning. A stale
 * pidfile (dead pid) is removed and the claim retried once.
 */
export function acquirePidfile(path: string, epoch: string): PidfileInfo {
  const info: PidfileInfo = { pid: process.pid, epoch, startedAt: Date.now() };
  const body = JSON.stringify(info);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, body, { flag: "wx" });
      return info;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    let existing: PidfileInfo | null = null;
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as PidfileInfo;
    } catch {
      existing = null;
    }

    if (existing && Number.isInteger(existing.pid) && pidAlive(existing.pid)) {
      throw new DaemonAlreadyRunning(existing);
    }
    // Stale — remove and loop to retry the exclusive create.
    try {
      unlinkSync(path);
    } catch {
      /* someone else may have just cleaned it */
    }
  }
  throw new Error(`could not acquire pidfile at ${path}`);
}

export function releasePidfile(path: string): void {
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as PidfileInfo;
    if (info.pid !== process.pid) return; // not ours to remove
  } catch {
    return;
  }
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

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
