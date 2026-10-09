import { recoverSessionVm } from "./recovery.ts";
import { discardSessionDisks } from "./disks.ts";
import { assertNoActiveVm, lockSessionState } from "./persistence.ts";

/** Keep the lock through recovery and the caller's filesystem mutation. */
export const withStoppedVmState = async <T>(
  dir: string,
  action: (recovered: boolean) => T | Promise<T>,
): Promise<T> => {
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
    await discardSessionDisks(dir);
    return await action(recovered);
  } finally {
    lock.close();
  }
};
