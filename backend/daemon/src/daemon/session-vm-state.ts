import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertNoActiveVm,
  lockSessionState,
} from "../../../../runtime/src/session-vm/persistence.ts";
export const sessionVmDirectory = (repo: string, id: string) => {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid session identity");
  const root = Deno.env.get("XDG_STATE_HOME") || join(homedir(), ".local/state");
  const key = createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 32);
  return join(root, "loom/session-vms", key, id);
};
export const stoppedSessionVm = async (repo: string, id: string, remove = false) => {
  const dir = sessionVmDirectory(repo, id);
  try {
    await Deno.stat(dir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  const lock = await lockSessionState(dir);
  try {
    await assertNoActiveVm(dir);
    if (remove)
      try {
        await Deno.remove(join(dir, "profile"), { recursive: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
  } finally {
    lock.close();
  }
};
