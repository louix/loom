import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { McpOAuthError } from "./mcp-oauth-model.ts";
import type { McpOAuthStore } from "./mcp-oauth-store.ts";

/** Register under the store transaction lock before handing credentials to a relay.
 * The held OS lock is liveness; the adjacent file contains only an acknowledged generation. */
export const registerOAuthOwner = async (store: McpOAuthStore) => {
  const path = join(store.directory, "owner-" + crypto.randomUUID());
  const lock = await Deno.open(path, { createNew: true, read: true, write: true, mode: 0o600 });
  await lock.lock(true);
  let closed = false;
  let acknowledged = -1;
  return {
    async setWorkers(pids: number[]) {
      const temp = path + ".pids-pending";
      await Deno.writeTextFile(temp, JSON.stringify(pids), { createNew: true, mode: 0o600 });
      await Deno.rename(temp, path + ".pids");
    },
    async acknowledge(generation: number) {
      if (generation === acknowledged) return;
      const temp = path + ".pending";
      await Deno.writeTextFile(temp, String(generation), { createNew: true, mode: 0o600 });
      await Deno.rename(temp, path + ".ack");
      acknowledged = generation;
    },
    async close() {
      if (closed) return;
      closed = true;
      // Relay shutdown must finish before releasing this lock.
      lock.close();
      for (const suffix of ["", ".ack", ".pending", ".pids", ".pids-pending"])
        await Deno.remove(path + suffix).catch((e) => {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        });
    },
  };
};

export const waitOAuthInvalidation = async (
  store: McpOAuthStore,
  generation: number,
  timeoutMs = 10000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let pending = false;
    for await (const entry of Deno.readDir(store.directory)) {
      if (!/^owner-[0-9a-f-]{36}$/.test(entry.name)) continue;
      const path = join(store.directory, entry.name);
      let lock: Deno.FsFile | undefined;
      try {
        const stat = await Deno.lstat(path);
        if (!stat.isFile || stat.isSymlink || stat.uid !== Deno.uid() || stat.nlink !== 1)
          throw new McpOAuthError("storage_unsafe");
        lock = await Deno.open(path, { read: true });
        const opened = await lock.stat();
        if (opened.ino !== stat.ino || opened.dev !== stat.dev)
          throw new McpOAuthError("storage_unsafe");
        if (await lock.tryLock(true)) {
          // Owner death closes relay stdin, but wait for its already-published children to exit.
          // PID reuse can only produce an incomplete result; we never signal a recorded PID.
          try {
            const stat = await Deno.lstat(path + ".pids");
            if (!stat.isFile || stat.isSymlink || stat.size > 65536)
              throw new McpOAuthError("storage_unsafe");
            const pids: unknown = JSON.parse(await Deno.readTextFile(path + ".pids"));
            if (!Array.isArray(pids) || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0))
              throw new McpOAuthError("storage_corrupt");
            for (const pid of pids) {
              try {
                Deno.kill(pid, 0);
                pending = true;
              } catch (e) {
                if (!(e instanceof Deno.errors.NotFound)) pending = true;
              }
            }
          } catch (e) {
            if (!(e instanceof Deno.errors.NotFound)) throw e;
          }
          continue;
        }
        let acknowledged = -1;
        try {
          const ack = await Deno.lstat(path + ".ack");
          if (ack.isFile && !ack.isSymlink && ack.size < 32)
            acknowledged = Number(await Deno.readTextFile(path + ".ack"));
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
        if (!Number.isSafeInteger(acknowledged) || acknowledged < generation) pending = true;
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      } finally {
        lock?.close();
      }
    }
    if (!pending) return;
    if (Date.now() >= deadline) throw new McpOAuthError("invalidation_incomplete");
    await sleep(50);
  }
};
