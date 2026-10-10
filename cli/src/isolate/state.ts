/**
 * loom-isolate's own state namespace, separate from Loom's. Each environment
 * directory has exactly one owning process at a time, enforced by a lock held for
 * the whole command; the VM state beneath it is the runtime's, behind its own lock.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { EnvironmentStorage } from "@loom/isolation/storage";
import { IsolationError } from "@loom/isolation/errors";
import { canonicalHostPath } from "../../../core/src/host-path.ts";
import { userDirectory } from "../../../core/src/user-dirs.ts";
import { workspaceMounts } from "../../../runtime/src/packaged/workspace.ts";
import { withStoppedVmState } from "../../../runtime/src/session-vm/stopped-state.ts";

export interface IsolateRuntime {
  artifact: string;
  smolvm: string;
}
export interface EnvironmentRecord {
  version: 1;
  owner: "loom-isolate";
  id: string;
  name: string;
  workspace: string;
  createdAt: string;
  /** Selected by the last prepare; exec flags or the package default override it. */
  runtime: IsolateRuntime | null;
  preparedAt: string | null;
}

const stateHome = () => userDirectory("state");
export const isolateStateRoot = () => canonicalHostPath(join(stateHome(), "loom-isolate"));
/** Loom's session VMs, clones, environments and VM inventory: never mounted or mutated here. */
export const loomStateRoot = () => canonicalHostPath(join(stateHome(), "loom"));

const recordName = "environment.json";
const lockName = "owner.lock";
const vmName = "vm";
const names = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export const environmentId = (workspace: string, name: string) => {
  if (!names.test(name))
    throw new UsageError("Environment names use 1-32 letters, digits, '-' or '_'.");
  return "w" + createHash("sha256").update(workspace).digest("hex").slice(0, 24) + "-" + name;
};

/** Caller mistakes: reported with usage status, never after touching state. */
export class UsageError extends Error {}

const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
/** Resolve symlinks as far as the path exists, so aliases cannot dodge the overlap check. */
const resolved = async (path: string): Promise<string> => {
  try {
    return await Deno.realPath(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    const parent = join(path, "..");
    return parent === path ? path : join(await resolved(parent), path.slice(parent.length + 1));
  }
};

/**
 * The caller's workspace, mounted read-write as given. Refuse anything whose mounts
 * would expose or contain Loom's VM state or loom-isolate's own state.
 */
export const resolveWorkspace = async (path: string): Promise<string> => {
  let workspace: string;
  try {
    workspace = await Deno.realPath(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound)
      throw new UsageError("Workspace does not exist: " + path);
    throw error;
  }
  if (!(await Deno.stat(workspace)).isDirectory)
    throw new UsageError("Workspace is not a directory: " + workspace);
  const owned = [
    ["Loom's VM state", await resolved(loomStateRoot())],
    ["loom-isolate's state", await resolved(isolateStateRoot())],
  ] as const;
  for (const mount of await workspaceMounts(workspace)) {
    for (const [label, root] of owned) {
      if (overlaps(mount, root))
        throw new IsolationError(
          "bad_request",
          `Refusing to mount ${mount}: it overlaps ${label} (${root}). Choose a narrower workspace.`,
        );
    }
  }
  return workspace;
};

const ownedDirectory = async (path: string, create: boolean): Promise<boolean> => {
  if (create) {
    try {
      await Deno.mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
  }
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
  if (!info.isDirectory || info.isSymlink || info.uid !== Deno.uid())
    throw new IsolationError("bad_request", "Unsafe loom-isolate state directory: " + path);
  return true;
};

/** Create the namespace on demand; it must never resolve into Loom's own state. */
const stateRoot = async (create: boolean): Promise<string | undefined> => {
  const root = isolateStateRoot();
  if (create) await Deno.mkdir(join(root, ".."), { recursive: true });
  if (!(await ownedDirectory(root, create))) return undefined;
  if ((await Deno.realPath(root)) !== root)
    throw new IsolationError(
      "bad_request",
      "loom-isolate state must not be reached through a symlink: " + root,
    );
  if (overlaps(root, await resolved(loomStateRoot())))
    throw new IsolationError("bad_request", "loom-isolate state overlaps Loom's state: " + root);
  await ownedDirectory(join(root, "environments"), create);
  return root;
};

const readRecord = async (directory: string): Promise<EnvironmentRecord | undefined> => {
  const path = join(directory, recordName);
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  if (!info.isFile || info.isSymlink || info.uid !== Deno.uid() || info.size > 65536)
    throw new IsolationError("bad_request", "Invalid environment record: " + path);
  const record = JSON.parse(await Deno.readTextFile(path)) as EnvironmentRecord;
  if (record?.version !== 1 || record.owner !== "loom-isolate" || typeof record.id !== "string")
    throw new IsolationError("bad_request", "Not a loom-isolate environment: " + directory);
  return record;
};

const writeRecord = async (directory: string, record: EnvironmentRecord) => {
  const temporary = join(directory, `.${recordName}-${crypto.randomUUID()}`);
  await Deno.writeTextFile(temporary, JSON.stringify(record, null, 2) + "\n", {
    createNew: true,
    mode: 0o600,
  });
  await Deno.rename(temporary, join(directory, recordName));
};

/**
 * One owner per environment directory. A non-blocking exclusive lock, retried
 * briefly so a concurrent inspect probe cannot fail an exec. The lock must still
 * be the directory's file once held: cleanup unlinks it before releasing.
 */
const lockEnvironment = async (directory: string): Promise<Deno.FsFile> => {
  const path = join(directory, lockName);
  const deadline = Date.now() + 500;
  for (;;) {
    const file = await Deno.open(path, { create: true, read: true, write: true, mode: 0o600 });
    let held = false;
    try {
      const info = await Deno.lstat(path);
      if (!info.isFile || info.isSymlink || info.uid !== Deno.uid())
        throw new IsolationError("bad_request", "Unsafe environment lock: " + path);
      held = await file.tryLock(true);
      if (held) {
        const [opened, current] = await Promise.all([file.stat(), Deno.lstat(path)]);
        if (opened.ino === current.ino && opened.dev === current.dev) {
          await file.truncate(0);
          await file.write(new TextEncoder().encode(String(Deno.pid) + "\n"));
          return file;
        }
      }
    } catch (error) {
      file.close();
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    file.close();
    if (held) continue; // Unlinked by cleanup between open and lock; take the new one.
    if (Date.now() >= deadline)
      throw new IsolationError(
        "busy",
        "Environment is in use by another loom-isolate process" + (await ownerPid(path)) + ".",
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const ownerPid = async (path: string) => {
  try {
    const pid = (await Deno.readTextFile(path)).trim();
    return /^\d+$/.test(pid) ? " (pid " + pid + ")" : "";
  } catch {
    return "";
  }
};

export interface OwnedEnvironment {
  id: string;
  directory: string;
  record: EnvironmentRecord;
  storage: EnvironmentStorage;
  update(change: Partial<Pick<EnvironmentRecord, "runtime" | "preparedAt">>): Promise<void>;
  /** Stop recovery, then remove the whole environment while still owning it. */
  remove(): Promise<void>;
  release(): void;
}

const storageFor = (directory: string): EnvironmentStorage => ({
  directory: () => join(directory, vmName),
  withStopped: (_id, action) => withStoppedVmState(join(directory, vmName), () => action()),
});

/** Own an environment of this workspace for the life of the calling command. */
export const ownEnvironment = async (
  workspace: string,
  name: string,
  create: boolean,
): Promise<OwnedEnvironment | undefined> => {
  const id = environmentId(workspace, name);
  const root = await stateRoot(create);
  if (!root) return undefined;
  const directory = join(root, "environments", id);
  if (!(await ownedDirectory(directory, create))) return undefined;
  const lock = await lockEnvironment(directory);
  try {
    let record = await readRecord(directory);
    if (!record) {
      // Anything other than our own lock means this directory was not created by us.
      for await (const entry of Deno.readDir(directory))
        if (entry.name !== lockName)
          throw new IsolationError(
            "bad_request",
            "Refusing to adopt an environment directory without a loom-isolate record: " +
              directory,
          );
      if (!create) {
        lock.close();
        return undefined;
      }
      record = {
        version: 1,
        owner: "loom-isolate",
        id,
        name,
        workspace,
        createdAt: new Date().toISOString(),
        runtime: null,
        preparedAt: null,
      };
      await writeRecord(directory, record);
    }
    if (record.id !== id || record.workspace !== workspace)
      throw new IsolationError("bad_request", "Environment record does not match " + workspace);
    const owned = record;
    const vm = join(directory, vmName);
    try {
      const info = await Deno.lstat(vm);
      if (!info.isDirectory || info.isSymlink || info.uid !== Deno.uid())
        throw new IsolationError("bad_request", "Unsafe environment VM state: " + vm);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    let released = false;
    return {
      id,
      directory,
      record: owned,
      storage: storageFor(directory),
      async update(change) {
        Object.assign(owned, change);
        await writeRecord(directory, owned);
      },
      async remove() {
        await withStoppedVmState(vm, () =>
          Deno.remove(vm, { recursive: true }).catch(ignoreMissing),
        );
        for await (const entry of Deno.readDir(directory))
          if (entry.name !== lockName)
            await Deno.remove(join(directory, entry.name), { recursive: true });
        // Unlink the lock last, while holding it; late openers notice the new inode.
        await Deno.remove(join(directory, lockName));
        await Deno.remove(directory);
      },
      release() {
        if (released) return;
        released = true;
        lock.close();
      },
    };
  } catch (error) {
    lock.close();
    throw error;
  }
};
const ignoreMissing = (error: unknown) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
};

export interface EnvironmentStatus {
  id: string;
  directory: string;
  record: EnvironmentRecord | null;
  /** Another process owns it now; its pid when recorded. */
  inUse: boolean;
  ownerPid: number | null;
  /** The runtime's recovery marker: a VM is running, or a crashed one awaits cleanup. */
  vmActive: boolean;
  error: string | null;
}

/** Read-only observation; probing ownership takes a shared lock only momentarily. */
export const environmentStatus = async (id: string): Promise<EnvironmentStatus> => {
  const directory = join(isolateStateRoot(), "environments", id);
  const status: EnvironmentStatus = {
    id,
    directory,
    record: null,
    inUse: false,
    ownerPid: null,
    vmActive: false,
    error: null,
  };
  try {
    if (!(await ownedDirectory(directory, false))) return status;
    status.record = (await readRecord(directory)) ?? null;
    const lock = join(directory, lockName);
    try {
      const file = await Deno.open(lock, { read: true, write: true });
      try {
        status.inUse = !(await file.tryLock(false));
      } finally {
        file.close();
      }
      const pid = (await ownerPid(lock)).match(/\d+/)?.[0];
      if (status.inUse && pid) status.ownerPid = Number(pid);
    } catch (error) {
      ignoreMissing(error);
    }
    try {
      await Deno.lstat(join(directory, vmName, "active.json"));
      status.vmActive = true;
    } catch (error) {
      ignoreMissing(error);
    }
  } catch (error) {
    status.error = error instanceof Error ? error.message : String(error);
  }
  return status;
};

export const listEnvironmentIds = async (): Promise<string[]> => {
  const root = await stateRoot(false);
  const ids: string[] = [];
  if (!root) return ids;
  try {
    for await (const entry of Deno.readDir(join(root, "environments")))
      if (/^w[0-9a-f]{24}-[A-Za-z0-9_-]+$/.test(entry.name)) ids.push(entry.name);
  } catch (error) {
    ignoreMissing(error);
  }
  return ids.sort();
};

/** Own an environment by ID alone, for cleanup of a workspace that may no longer exist. */
export const ownEnvironmentById = async (id: string): Promise<OwnedEnvironment | undefined> => {
  const directory = join(isolateStateRoot(), "environments", id);
  const record = await readRecord(directory).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  });
  if (!record) return undefined;
  return await ownEnvironment(record.workspace, record.name, false);
};
