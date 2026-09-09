/** Called only while holding the persistent session's ownership lock. */
import { cleanupSessionVm } from "./cleanup.ts";
import { join, resolve } from "node:path";
import { reapVm, type VmBinding } from "../packaged/vm.ts";
import { bootId, stopProcess, type OwnedProcess } from "./process.ts";
import { finishSessionState, writeRecoveryFile, removeSessionRuntimeState } from "./persistence.ts";
export interface RecoveryRecord {
  version: 1;
  bootId: string;
  processes: OwnedProcess[];
  reaped: boolean;
}
export type RecoverableBinding = VmBinding & { recovery: RecoveryRecord };
const exists = async (path: string) => {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};
const directory = async (path: string) => {
  const stat = await Deno.lstat(path);
  if (!stat.isDirectory || stat.isSymlink || (await Deno.realPath(path)) !== path)
    throw new Error("Recovery path is not a real directory");
};
export const readRecovery = async (dir: string): Promise<RecoverableBinding | undefined> => {
  if (!(await exists(join(dir, "active.json")))) return;
  await directory(dir);
  const file = join(dir, "active.json");
  const stat = await Deno.lstat(file);
  if (!stat.isFile || stat.isSymlink || stat.size > 64 * 1024)
    throw new Error("Invalid VM recovery marker");
  const b = JSON.parse(await Deno.readTextFile(file)) as RecoverableBinding;
  if (
    !b ||
    b.version !== 1 ||
    b.sessionDirectory !== dir ||
    typeof b.token !== "string" ||
    !/^[0-9a-f-]{36}$/.test(b.token) ||
    typeof b.state !== "string" ||
    !/^\/tmp\/loom-session-vm-[a-z0-9]+$/.test(b.state) ||
    typeof b.smolvm !== "string" ||
    !/^\/nix\/store\/[a-z0-9]{32}-[^/]+\/bin\/smolvm$/.test(b.smolvm) ||
    !b.recovery ||
    b.recovery.version !== 1 ||
    !/^[0-9a-f-]{36}$/.test(b.recovery.bootId) ||
    typeof b.recovery.reaped !== "boolean" ||
    !Array.isArray(b.recovery.processes) ||
    b.recovery.processes.length > 16 ||
    b.recovery.processes.some(
      (p) =>
        !p ||
        !Number.isSafeInteger(p.pid) ||
        p.pid <= 1 ||
        !Number.isSafeInteger(p.group) ||
        p.group <= 1 ||
        typeof p.start !== "string" ||
        !/^\d+$/.test(p.start),
    )
  )
    throw new Error("VM recovery marker is incomplete or incompatible; manual recovery required");
  if (
    b.gitSocket !== join(b.state, "git.sock") &&
    !(
      typeof b.gitSocket === "string" &&
      b.gitSocket.startsWith(b.state + "/git-bridge-") &&
      /^git-bridge-[a-z0-9]+\/git\.sock$/.test(b.gitSocket.slice(b.state.length + 1))
    )
  )
    throw new Error("Invalid recovery Git endpoint");
  return b;
};
export const recoverSessionVm = async (dir: string): Promise<boolean> => {
  const b = await readRecovery(dir);
  if (!b) return false;
  const previousBoot = b.recovery.bootId !== (await bootId());
  const present = await exists(b.state);
  if (present) {
    await directory(b.state);
    const stamp = join(b.state, "owner.json");
    if (!(await exists(stamp))) {
      if (!b.recovery.reaped) throw new Error("Missing VM state ownership stamp");
      for await (const _ of Deno.readDir(b.state))
        throw new Error("Unidentified contents remain in reaped state");
    } else {
      const stat = await Deno.lstat(stamp);
      if (!stat.isFile || stat.isSymlink || stat.size > 1024)
        throw new Error("Invalid VM state ownership stamp");
      const owner = JSON.parse(await Deno.readTextFile(stamp));
      if (owner.token !== b.token || owner.bootId !== b.recovery.bootId)
        throw new Error("VM state belongs to another owner");
    }
    // These are host-only paths. Never follow substituted cleanup targets.
    for (const name of ["private", "home", "cache", "data", "config"]) {
      const path = join(b.state, name);
      if (await exists(path)) await directory(path);
    }
  } else if (!previousBoot && !b.recovery.reaped) {
    throw new Error("VM state is missing on the current boot; shutdown cannot be confirmed");
  }
  const finish = async () => {
    b.recovery.reaped = true;
    await writeRecoveryFile(dir, "active.json", b);
    if (present) await removeSessionRuntimeState(b.state);
    await finishSessionState(dir, b.token);
  };
  if (!previousBoot && !b.recovery.reaped) {
    await cleanupSessionVm({
      stop: async () => {
        const errors: unknown[] = [];
        for (const process of b.recovery.processes.slice(1).reverse())
          try {
            await stopProcess(process);
          } catch (error) {
            errors.push(error);
          }
        if (errors.length) throw new AggregateError(errors, "Could not stop recorded VM helpers");
      },
      egress: async () => {}, // Socket relays belonged to the now-dead supervisor.
      credentials: async () => {
        await Deno.remove(join(b.state, "private"), { recursive: true }).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
      },
      reap: async () => {
        if ((await Deno.realPath(b.smolvm)) !== resolve(b.smolvm))
          throw new Error("Recovery executable changed");
        await reapVm(b);
      },
      git: async () => {
        if (b.recovery.processes[0]) await stopProcess(b.recovery.processes[0]);
      },
      state: finish,
    }).catch((error) => {
      const detail = (value: unknown): string => {
        if (value instanceof AggregateError) return value.errors.map(detail).join("; ");
        return value instanceof Error ? value.message : String(value);
      };
      throw new Error(
        `Session VM cleanup incomplete: ${detail(error)}; state retained at ${b.state}`,
        { cause: error },
      );
    });
  } else {
    // Another boot cannot contain any old VM. Never interpret old monitor PIDs
    // against the new boot; a durable reaped marker also makes retries safe.
    await finish();
  }
  return true;
};
