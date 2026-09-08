/** Host-only ownership metadata; only profile/ is mounted into the guest. */
import { join } from "node:path";
export const lockSessionState = async (dir: string) => {
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = await Deno.open(join(dir, "owner.lock"), {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  if (!(await lock.tryLock(true))) {
    lock.close();
    throw new Error("Session VM is still running or being cleaned up");
  }
  return lock;
};
export const assertNoActiveVm = async (dir: string) => {
  try {
    await Deno.stat(join(dir, "active.json"));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  throw new Error(`Session VM cleanup is incomplete; retained state: ${dir}/active.json`);
};
export const finishSessionState = async (dir: string, token: string) => {
  try {
    const active = JSON.parse(await Deno.readTextFile(join(dir, "active.json")));
    if (active.token !== token) return; // A newer VM owns the directory now.
    await Deno.remove(join(dir, "active.json"));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
};
