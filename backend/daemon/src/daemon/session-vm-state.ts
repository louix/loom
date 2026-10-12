import { canonicalHostPath } from "../../../../core/src/host-path.ts";
import { userDirectory } from "../../../../core/src/user-dirs.ts";
import { existsSync } from "node:fs";
import { discardSessionDisks } from "../../../../runtime/src/session-vm/disks.ts";
import { withStoppedVmState } from "../../../../runtime/src/session-vm/stopped-state.ts";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import {
  assertNoActiveVm,
  lockSessionState,
  SessionVmBusyError,
} from "../../../../runtime/src/session-vm/persistence.ts";
export const sessionVmDirectory = (repo: string, id: string) => {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid session identity");
  const root = userDirectory("state");
  const key = createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 32);
  return canonicalHostPath(join(root, "loom/session-vms", key, id));
};

/** Every clone session of this repository lives under here; host Git never enters it. */
export const sessionCloneRoot = (repo: string) => dirname(sessionVmDirectory(repo, "root"));

/** Keep the lock through recovery and the caller's filesystem mutation. */
export const withStoppedSessionVm = <T>(
  repo: string,
  id: string,
  action: (recovered: boolean) => T | Promise<T>,
): Promise<T> => withStoppedVmState(sessionVmDirectory(repo, id), action);
export const removeSessionVmProfile = async (repo: string, id: string) => {
  for (const name of [
    "profile",
    "disks",
    "disk-runtime-root",
    "disk-backend-root",
    "checkout",
    "workspace",
    "git-policy.json",
  ]) {
    try {
      await Deno.remove(join(sessionVmDirectory(repo, id), name), { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
};
export const stoppedSessionVm = async (repo: string, id: string, remove = false) =>
  withStoppedSessionVm(repo, id, async (recovered) => {
    if (remove) await removeSessionVmProfile(repo, id);
    return recovered;
  });
/**
 * Startup recovery of one session's VM state: `stopped`, the VM it found running
 * is stopped; `unsettled`, recovery failed, found the state owned or ran out of
 * time, so the VM may still run.
 */
export type VmRecovery = "stopped" | "unsettled";

export interface RepositoryVmRecovery {
  /** The sessions recovery acted on; one with no VM to stop is not listed. */
  readonly sessions: ReadonlyMap<string, VmRecovery>;
  /** `failed`: the sessions could not all be listed, so any VM may still run. */
  readonly scan: "complete" | "failed";
}

export const recoverRepositoryVms = async (
  repo: string,
  report: (id: string, error: unknown) => void,
): Promise<RepositoryVmRecovery> => {
  const handled = new Map<string, VmRecovery>();
  const deadline = Date.now() + 30_000;
  const root = dirname(sessionVmDirectory(repo, "scan"));
  try {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory && !entry.isSymlink) continue;
      if (Date.now() > deadline) {
        handled.set(entry.name, "unsettled");
        report(
          entry.name,
          new Error("Startup recovery budget reached; retry this session to recover it"),
        );
        continue;
      }
      try {
        if (await stoppedSessionVm(repo, entry.name)) handled.set(entry.name, "stopped");
      } catch (error) {
        handled.set(entry.name, "unsettled");
        if (!(error instanceof SessionVmBusyError)) report(entry.name, error);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { sessions: handled, scan: "complete" };
    report("repository", error);
    return { sessions: handled, scan: "failed" };
  }
  return { sessions: handled, scan: "complete" };
};

/** Collect legacy disks without stopping VMs or touching native conversation history. */
export const pruneRepositorySessionDisks = async (repo: string, dryRun = false) => {
  const result = { sessionDisksRemoved: 0, sessionDisksRetained: 0 };
  const root = dirname(sessionVmDirectory(repo, "scan"));
  try {
    if ((await Deno.realPath(root)) !== root) {
      throw new Error("Session state must not be a symlink");
    }
    for await (const entry of Deno.readDir(root)) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(entry.name)) continue;
      const dir = join(root, entry.name);
      let owner: Deno.FsFile | undefined;
      try {
        if (!entry.isDirectory || entry.isSymlink || (await Deno.realPath(dir)) !== dir) {
          result.sessionDisksRetained++;
          continue;
        }
        owner = await lockSessionState(dir);
        await assertNoActiveVm(dir);
        if (await discardSessionDisks(dir, dryRun)) result.sessionDisksRemoved++;
      } catch {
        result.sessionDisksRetained++;
      } finally {
        owner?.close();
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return result;
};

/** Read-only preflight; never import or move native provider history across boundaries. */
export const vmResumeBlockedReason = (
  repo: string,
  id: string,
  ref: string,
  vm: boolean,
): string | undefined => {
  const profile = join(sessionVmDirectory(repo, id), "profile");
  const savedVm =
    /^[0-9a-f-]{36}$/i.test(ref) &&
    existsSync(join(profile, "projects/loom-session", `${ref}.jsonl`));
  if (vm && !savedVm) return "No VM history for this session. Fork to continue with VM isolation.";
  if (!vm && existsSync(profile))
    return "This session has VM history. Fork to continue without VM isolation.";
  return undefined;
};
