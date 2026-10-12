import { setTimeout as delay } from "node:timers/promises";
import type { LoomClient } from "@loom/client";
import { daemonLock, type DaemonEndpoint } from "@loom/core/daemon-endpoint";

/**
 * The shutdown RPC acknowledges the request before the daemon releases its repo.
 * `endpoint` is the one the client dialled: a legacy daemon's pidfile is in `<repo>/.loom`.
 */
export const stopDaemon = async (
  client: LoomClient,
  endpoint: DaemonEndpoint,
  timeoutMs = 30_000,
): Promise<void> => {
  const daemon = client.daemonInfo;
  if (!daemon) throw new Error("Daemon identity is unavailable");
  let disconnected = false;
  const unsubscribe = client.on("disconnect", () => {
    disconnected = true;
  });
  const unsubscribeClose = client.on("close", () => {
    disconnected = true;
  });
  const deadline = Date.now() + timeoutMs;
  try {
    await client.request("daemon.shutdown", undefined, timeoutMs);
    for (;;) {
      if (disconnected && !(await stillOwned(endpoint, daemon))) return;
      if (Date.now() >= deadline)
        throw new Error("Daemon shutdown timed out; it has not finished releasing this repo");
      await delay(25);
    }
  } finally {
    unsubscribe();
    unsubscribeClose();
  }
};

/** A lock held before its holder records itself may be the stopping daemon's still. */
const stillOwned = async (
  endpoint: DaemonEndpoint,
  daemon: { pid: number; epoch: string },
): Promise<boolean> => {
  if (endpoint.kind === "current") {
    const lock = daemonLock(endpoint.lock);
    return (
      lock.kind === "held" &&
      (lock.record === null ||
        (lock.record.epoch === daemon.epoch && lock.record.pid === daemon.pid))
    );
  }
  try {
    const owner = JSON.parse(await Deno.readTextFile(endpoint.pid));
    return owner.epoch === daemon.epoch && owner.pid === daemon.pid;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};
