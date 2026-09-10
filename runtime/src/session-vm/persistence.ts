/** Host-only ownership metadata; only profile/ is mounted into the guest. */
import { join } from "node:path";
export class SessionVmBusyError extends Error {}
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
    throw new SessionVmBusyError("Session VM is still running or being cleaned up");
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

/** Publish recovery metadata atomically, including across host power loss. */
export const writeRecoveryFile = async (
  dir: string,
  name: string,
  value: unknown,
  signal?: AbortSignal,
) => {
  const tmp = join(dir, `.${name}-${crypto.randomUUID()}`);
  try {
    const file = await Deno.open(tmp, { write: true, createNew: true, mode: 0o600 });
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      let offset = 0;
      while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
      await file.sync();
    } finally {
      file.close();
    }
    signal?.throwIfAborted();
    await Deno.rename(tmp, join(dir, name));
    const directory = await Deno.open(dir, { read: true });
    try {
      await directory.sync();
    } finally {
      directory.close();
    }
  } finally {
    // The active marker is authoritative; a failed temp cleanup must not hide
    // the publication error. Temporary metadata contains no credentials.
    await Deno.remove(tmp).catch(() => {});
  }
};

/** Keep the ownership stamp until recursive removal is finished. */
export const removeSessionRuntimeState = async (state: string) => {
  for await (const entry of Deno.readDir(state)) {
    if (entry.name !== "owner.json")
      await Deno.remove(join(state, entry.name), { recursive: true });
  }
  try {
    await Deno.remove(join(state, "owner.json"));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.remove(state);
};
