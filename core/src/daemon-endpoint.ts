import { existsSync, readFileSync } from "node:fs";
import type { LoomPaths } from "./paths.ts";

/** Where a client reaches a repository's daemon, and which pidfile names it. */
export interface DaemonEndpoint {
  sock: string;
  pid: string;
  /** A daemon from before the XDG layout, still serving from `<repo>/.loom`. */
  legacy: boolean;
}

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

const pidfileOwner = (path: string): number | null => {
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
  const pid = pidfileOwner(paths.legacy.pid);
  return pid !== null && existsSync(paths.legacy.sock) && pidAlive(pid) && runsLoomd(pid)
    ? pid
    : null;
};

/**
 * The current daemon when one runs, else a pre-XDG daemon that still does, else
 * the current location for a new daemon. Clients never autospawn beside a legacy
 * daemon: that one keeps the repository until it is restarted.
 */
export const daemonEndpoint = (paths: LoomPaths): DaemonEndpoint => {
  const current = pidfileOwner(paths.pid);
  if ((current === null || !pidAlive(current)) && legacyDaemonPid(paths) !== null)
    return { sock: paths.legacy.sock, pid: paths.legacy.pid, legacy: true };
  return { sock: paths.sock, pid: paths.pid, legacy: false };
};

export const showLegacyDaemonNotice = (paths: LoomPaths): string =>
  `loom: a daemon from an older Loom version is still running from ${paths.dir}. ` +
  `This client uses it; run \`loom stop\`, then start Loom again to move the repository's state to ${paths.runtime} and the XDG state directory.\n`;
