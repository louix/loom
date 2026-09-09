import { recoverSessionVm } from "../../../../runtime/src/session-vm/recovery.ts";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import {
  assertNoActiveVm,
  lockSessionState,
  SessionVmBusyError,
} from "../../../../runtime/src/session-vm/persistence.ts";
export const sessionVmDirectory = (repo: string, id: string) => {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid session identity");
  const root = Deno.env.get("XDG_STATE_HOME") || join(homedir(), ".local/state");
  const key = createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 32);
  return join(root, "loom/session-vms", key, id);
};

/** Keep the lock through recovery and the caller's filesystem mutation. */
export const withStoppedSessionVm = async <T>(
  repo: string,
  id: string,
  action: (recovered: boolean) => T | Promise<T>,
): Promise<T> => {
  const dir = sessionVmDirectory(repo, id);
  try {
    await Deno.lstat(dir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return await action(false);
    throw error;
  }
  if ((await Deno.realPath(dir)) !== dir) throw new Error("Session state must not be a symlink");
  const lock = await lockSessionState(dir);
  try {
    const recovered = await recoverSessionVm(dir);
    await assertNoActiveVm(dir);
    return await action(recovered);
  } finally {
    lock.close();
  }
};
export const removeSessionVmProfile = async (repo: string, id: string) => {
  try {
    await Deno.remove(join(sessionVmDirectory(repo, id), "profile"), { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
};
export const stoppedSessionVm = async (repo: string, id: string, remove = false) =>
  withStoppedSessionVm(repo, id, async (recovered) => {
    if (remove) await removeSessionVmProfile(repo, id);
    return recovered;
  });
export const recoverRepositoryVms = async (
  repo: string,
  report: (id: string, error: unknown) => void,
) => {
  const handled = new Set<string>();
  const deadline = Date.now() + 30_000;
  const root = dirname(sessionVmDirectory(repo, "scan"));
  try {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory && !entry.isSymlink) continue;
      if (Date.now() > deadline) {
        handled.add(entry.name);
        report(
          entry.name,
          new Error("Startup recovery budget reached; retry this session to recover it"),
        );
        continue;
      }
      try {
        if (await stoppedSessionVm(repo, entry.name)) handled.add(entry.name);
      } catch (error) {
        handled.add(entry.name);
        if (!(error instanceof SessionVmBusyError)) report(entry.name, error);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) report("repository", error);
  }
  return handled;
};
