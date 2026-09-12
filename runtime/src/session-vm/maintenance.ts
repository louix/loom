/** Preparation closes admission before stopping VMs, then waits for their leases. */
import { join } from "node:path";

const openLock = async (path: string) =>
  Deno.open(path, { read: true, write: true, create: true, mode: 0o600 });

export const enterSessionEnvironment = async (home: string): Promise<Deno.FsFile> => {
  await Deno.mkdir(join(home, "preparation"), { recursive: true, mode: 0o700 });
  const admission = await openLock(join(home, "preparation/owner.lock"));
  let lease: Deno.FsFile | undefined;
  try {
    if (!(await admission.tryLock(false)))
      throw new Error(
        "Repo environment preparation is running. Start the session after it finishes.",
      );
    lease = await openLock(join(home, "sessions.lock"));
    if (!(await lease.tryLock(false)))
      throw new Error("Repo environment preparation is finishing. Retry shortly.");
    return lease;
  } catch (error) {
    lease?.close();
    throw error;
  } finally {
    admission.close();
  }
};

/** Caller already holds preparation/owner.lock exclusively. */
export const drainSessionEnvironment = async (
  home: string,
  signal: AbortSignal,
): Promise<Deno.FsFile> => {
  const lease = await openLock(join(home, "sessions.lock"));
  const deadline = Date.now() + 30_000;
  try {
    while (!(await lease.tryLock(true))) {
      signal.throwIfAborted();
      if (Date.now() >= deadline)
        throw new Error("Session VMs have not stopped. Preparation left the previous base intact.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    signal.throwIfAborted();
    return lease;
  } catch (error) {
    lease.close();
    throw error;
  }
};
