import { setTimeout as delay } from "node:timers/promises";
import type { LoomClient } from "@loom/client";
import { loomPaths } from "@loom/core/paths";

/** The shutdown RPC acknowledges the request before the daemon releases its repo. */
export const stopDaemon = async (client: LoomClient, timeoutMs = 30_000): Promise<void> => {
  const daemon = client.daemonInfo;
  if (!daemon) throw new Error("Daemon identity is unavailable");
  const { pid } = loomPaths(daemon.repoRoot);
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
      let owned = false;
      try {
        const owner = JSON.parse(await Deno.readTextFile(pid));
        owned = owner.epoch === daemon.epoch && owner.pid === daemon.pid;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      if (disconnected && !owned) return;
      if (Date.now() >= deadline)
        throw new Error("Daemon shutdown timed out; it has not finished releasing this repo");
      await delay(25);
    }
  } finally {
    unsubscribe();
    unsubscribeClose();
  }
};
