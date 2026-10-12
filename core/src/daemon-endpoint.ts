import { existsSync, readFileSync } from "node:fs";
import { releaseFlock } from "./flock.ts";
import type { LoomPaths } from "./paths.ts";

/** What a daemon writes into the lock it holds: for display and `loom stop`, never liveness. */
export interface DaemonRecord {
  pid: number;
  epoch: string;
  startedAt: number;
}

/** Whether a daemon holds the repository's lock, and what it recorded there if it has yet. */
export type DaemonLock = { kind: "free" } | { kind: "held"; record: DaemonRecord | null };

/** Where a client reaches a repository's daemon, and what says it still owns the repository. */
export type DaemonEndpoint =
  | { kind: "current"; sock: string; lock: string }
  /** A daemon from before the XDG layout, still serving from `<repo>/.loom`. */
  | { kind: "legacy"; sock: string; pid: string };

/** Is `pid` a live process (whether or not we can signal it)? */
export const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 sends nothing — it only probes whether `pid` exists and is
    // signalable. Deno's Signal type is a name union with no "0" member, but
    // the underlying syscall (and Deno's kill()) accepts it identically to
    // Node's `process.kill(pid, 0)`.
    Deno.kill(pid, 0 as unknown as Deno.Signal);
    return true;
  } catch (err) {
    return err instanceof Deno.errors.PermissionDenied;
  }
};

/** A lock's record; null when absent, empty or malformed. */
export const readDaemonRecord = (path: string): DaemonRecord | null => {
  try {
    // Loom's own JSON; anything else names nobody.
    const { pid, epoch, startedAt } = JSON.parse(readFileSync(path, "utf8")) as {
      pid?: unknown;
      epoch?: unknown;
      startedAt?: unknown;
    };
    return typeof pid === "number" && typeof epoch === "string" && typeof startedAt === "number"
      ? { pid, epoch, startedAt }
      : null;
  } catch {
    return null;
  }
};

/**
 * Probe with a shared lock, which fails only while a daemon holds it
 * exclusively. Never creates the file; a daemon that takes the lock during the
 * probe retries (`lockRepository`).
 */
export const daemonLock = (lock: string): DaemonLock => {
  const file = openIfExists(lock);
  if (file === null) return { kind: "free" };
  try {
    return file.tryLockSync(false)
      ? { kind: "free" }
      : { kind: "held", record: readDaemonRecord(lock) };
  } finally {
    releaseFlock(file);
  }
};

const openIfExists = (path: string): Deno.FsFile | null => {
  try {
    return Deno.openSync(path, { read: true });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
};

const legacyPidfileOwner = (path: string): number | null => {
  try {
    // The pidfile is Loom's own JSON; a malformed one names nobody.
    const { pid } = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
};

/** Is `pid` running `loomd`? Not just alive: a stale pidfile's pid may have been reused. */
const runsLoomd = (pid: number): boolean => {
  try {
    if (Deno.build.os === "linux")
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("loomd");
    const ps = new Deno.Command("ps", { args: ["-o", "command=", "-p", String(pid)] }).outputSync();
    return new TextDecoder().decode(ps.stdout).includes("loomd");
  } catch {
    return false;
  }
};

/** The pid of a pre-XDG daemon still running for this repository, or null. */
export const legacyDaemonPid = (paths: LoomPaths): number | null => {
  const pid = legacyPidfileOwner(paths.legacy.pid);
  return pid !== null && existsSync(paths.legacy.sock) && pidAlive(pid) && runsLoomd(pid)
    ? pid
    : null;
};

/**
 * Any daemon running for this repository, current or pre-XDG, with its pid
 * when known: a current one has not written it in the moment after it locks.
 */
export const runningDaemon = (paths: LoomPaths): { pid: number | null } | null => {
  const current = daemonLock(paths.lock);
  if (current.kind === "held") return { pid: current.record?.pid ?? null };
  const legacy = legacyDaemonPid(paths);
  return legacy === null ? null : { pid: legacy };
};

/**
 * The current daemon when one runs, else a pre-XDG daemon that still does, else
 * the current location for a new daemon. Clients never autospawn beside a legacy
 * daemon: that one keeps the repository until it is restarted.
 */
export const daemonEndpoint = (paths: LoomPaths): DaemonEndpoint =>
  daemonLock(paths.lock).kind === "free" && legacyDaemonPid(paths) !== null
    ? { kind: "legacy", sock: paths.legacy.sock, pid: paths.legacy.pid }
    : { kind: "current", sock: paths.sock, lock: paths.lock };

export const showLegacyDaemonNotice = (paths: LoomPaths): string =>
  `loom: a daemon from an older Loom version is still running from ${paths.legacy.dir}. ` +
  `This client uses it; run \`loom stop\`, then start Loom again to move the repository's state to ${paths.state}.\n`;
