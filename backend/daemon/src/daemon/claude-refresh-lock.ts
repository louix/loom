/**
 * Claude uses proper-lockfile's directory protocol: realpath(profile) + ".lock",
 * stale after 10s, refreshed every 5s. Keep that protocol without a second lock
 * namespace that native Claude processes cannot see.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { CredentialAuthError } from "./credential-owner.ts";

export const withClaudeRefreshLock = async <T>(
  profile: string,
  signal: AbortSignal,
  run: (signal: AbortSignal, verify: () => Promise<void>) => Promise<T>,
): Promise<T> => {
  const path = (await Deno.realPath(profile)) + ".lock";
  const deadline = Date.now() + 40_000;
  while (true) {
    signal.throwIfAborted();
    try {
      await Deno.mkdir(path, { mode: 0o700 });
      break;
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      try {
        const stat = await Deno.stat(path);
        if (stat.mtime && stat.mtime.getTime() < Date.now() - 10_000) {
          // Like proper-lockfile, remove only an empty, stale lock directory.
          await Deno.remove(path);
          continue;
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      if (Date.now() >= deadline)
        throw new CredentialAuthError("refresh_timeout", "Claude lock busy");
      await sleep(100, undefined, { signal });
    }
  }
  const lost = new AbortController();
  let owned = await Deno.stat(path);
  let stopped = false;
  let heartbeat: Promise<void> = Promise.resolve();
  const matches = (stat: Deno.FileInfo) =>
    stat.ino === owned.ino && stat.mtime?.getTime() === owned.mtime?.getTime();
  const checkOwnership = async () => {
    try {
      if (!matches(await Deno.stat(path)) || Date.now() - owned.mtime!.getTime() > 10_000)
        throw new Error("lock lost");
    } catch {
      lost.abort(new CredentialAuthError("refresh_failed", "Claude lock lost"));
    }
    lost.signal.throwIfAborted();
  };
  const update = async () => {
    try {
      await checkOwnership();
      const now = new Date();
      await Deno.utime(path, now, now);
      owned = await Deno.stat(path);
    } catch {
      lost.abort(new CredentialAuthError("refresh_failed", "Claude lock lost"));
    }
  };
  // Serialize explicit checks with heartbeats so our own mtime update cannot
  // be mistaken for a replacement by another process.
  const verify = () => {
    const checked = heartbeat.then(checkOwnership);
    heartbeat = checked.catch(() => {});
    return checked;
  };
  const timer = setInterval(() => {
    if (!stopped) heartbeat = heartbeat.then(update);
  }, 5000);
  try {
    const guarded = AbortSignal.any([signal, lost.signal]);
    const result = await run(guarded, verify);
    await verify();
    guarded.throwIfAborted();
    return result;
  } finally {
    stopped = true;
    clearInterval(timer);
    await heartbeat;
    try {
      if (!lost.signal.aborted && matches(await Deno.stat(path))) await Deno.remove(path);
    } catch {
      // A failed release becomes stale after 10s; do not mask the exchange result.
    }
  }
};
