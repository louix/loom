/** Host-only VM inventory and per-instance control mailboxes. Never mounted in guests. */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { canonicalHostPath } from "../../../core/src/host-path.ts";
import { lockSessionState, writeRecoveryFile } from "./persistence.ts";
import { readRecovery, recoverSessionVm } from "./recovery.ts";

export type VmState = "starting" | "running" | "stopping" | "stopped" | "orphaned" | "unknown";
export interface VmRecord {
  version: 1;
  id: string;
  repo: string;
  kind: "session" | "prepare" | "mcp";
  sessionId: string | null;
  provider: string | null;
  workload: string;
  state: VmState;
  createdAt: string;
  stoppedAt: string | null;
  observedAt: string;
  source: "owner" | "inventory";
  paths: {
    workspace: string;
    runtime: string;
    state: string;
    session: string | null;
    profile: string | null;
    backend: string | null;
    base: string | null;
  };
  error: string | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const vmInventoryHome = () =>
  canonicalHostPath(
    join(Deno.env.get("XDG_STATE_HOME") || join(homedir(), ".local/state"), "loom/vms"),
  );
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
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
  const info = await Deno.lstat(path);
  if (
    !info.isDirectory ||
    info.isSymlink ||
    info.uid !== Deno.uid() ||
    (await Deno.realPath(path)) !== path
  )
    throw new Error("Unsafe VM inventory directory: " + path);
};
const json = async (path: string): Promise<unknown> => {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink || info.uid !== Deno.uid() || info.size > 65536)
    throw new Error("Invalid VM metadata: " + path);
  return JSON.parse(await Deno.readTextFile(path));
};
const recordPath = (home: string, id: string) => {
  if (!uuid.test(id)) throw new Error("Invalid VM instance ID");
  return join(home, id);
};
const read = async (home: string, id: string): Promise<VmRecord> => {
  await directory(home);
  const dir = recordPath(home, id);
  await directory(dir);
  const r = (await json(join(dir, "record.json"))) as VmRecord;
  if (
    !r ||
    r.version !== 1 ||
    r.id !== id ||
    !["session", "prepare", "mcp"].includes(r.kind) ||
    !["starting", "running", "stopping", "stopped", "orphaned", "unknown"].includes(r.state) ||
    typeof r.repo !== "string" ||
    !isAbsolute(r.repo) ||
    typeof r.workload !== "string" ||
    typeof r.createdAt !== "string" ||
    !Number.isFinite(Date.parse(r.createdAt)) ||
    typeof r.observedAt !== "string" ||
    !Number.isFinite(Date.parse(r.observedAt)) ||
    !["owner", "inventory"].includes(r.source) ||
    ![r.sessionId, r.provider, r.error, r.stoppedAt].every(
      (v) => v === null || typeof v === "string",
    ) ||
    !r.paths ||
    ![r.paths.workspace, r.paths.runtime, r.paths.state].every(
      (p) => typeof p === "string" && isAbsolute(p),
    ) ||
    ![r.paths.session, r.paths.profile, r.paths.backend, r.paths.base].every(
      (p) => p === null || (typeof p === "string" && isAbsolute(p)),
    )
  )
    throw new Error("Invalid VM inventory record: " + id);
  return r;
};
/** Open existing locks only: list/inspect must never create files or recover machines. */
const ownerActive = async (home: string, id: string): Promise<boolean> => {
  const path = join(home, ".locks", id);
  await directory(join(home, ".locks"));
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink || info.uid !== Deno.uid()) throw new Error("Unsafe VM lock");
  const file = await Deno.open(path, { read: true, write: true });
  try {
    return !(await file.tryLock(true));
  } finally {
    file.close();
  }
};
const takeLock = async (home: string, id: string, createNew = false) => {
  recordPath(home, id);
  await directory(home);
  await directory(join(home, ".locks"));
  const path = join(home, ".locks", id);
  if (await exists(path)) {
    const info = await Deno.lstat(path);
    if (!info.isFile || info.isSymlink || info.uid !== Deno.uid())
      throw new Error("Unsafe VM lock");
  }
  // Recreating a missing lock could split ownership from a still-open unlinked inode.
  // Instance UUIDs are single-use, even after their inventory record is removed.
  const file = await Deno.open(path, { createNew, read: true, write: true, mode: 0o600 });
  if (!(await file.tryLock(true))) {
    file.close();
    throw new Error("VM is still owned by a live process");
  }
  return file;
};
export const inspectVm = async (id: string, home = vmInventoryHome()): Promise<VmRecord> => {
  const r = await read(home, id);
  try {
    const active = await ownerActive(home, id);
    if (!active && r.state !== "stopped") {
      r.state = "orphaned";
      r.source = "inventory";
      r.error = "Owner exited; shutdown and cleanup have not been confirmed";
    } else if (active && r.state !== "stopped" && Date.now() - Date.parse(r.observedAt) > 10_000) {
      r.state = "unknown";
      r.source = "inventory";
      r.error = "Owner holds its lock but is not updating status";
    }
  } catch (error) {
    r.state = "unknown";
    r.source = "inventory";
    r.error = message(error);
  }
  return r;
};
export const listVms = async (repo?: string, home = vmInventoryHome()) => {
  const vms: VmRecord[] = [];
  const errors: string[] = [];
  try {
    if (!(await exists(home))) return { version: 1 as const, vms, errors };
    await directory(home);
    for await (const entry of Deno.readDir(home)) {
      if (!uuid.test(entry.name)) continue;
      try {
        const vm = await inspectVm(entry.name, home);
        if (!repo || vm.repo === repo) vms.push(vm);
      } catch (error) {
        errors.push(entry.name + ": " + message(error));
      }
    }
  } catch (error) {
    errors.push(message(error));
  }
  vms.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  return { version: 1 as const, vms, errors };
};
export const resolveVm = async (prefix: string, repo?: string, home = vmInventoryHome()) => {
  if (!/^[0-9a-f-]+$/.test(prefix)) throw new Error("Invalid VM ID prefix");
  if (uuid.test(prefix)) {
    const vm = await inspectVm(prefix, home);
    if (repo && vm.repo !== repo) throw new Error("VM not found in selected repository: " + prefix);
    return vm;
  }
  const result = await listVms(repo, home);
  if (result.errors.length) throw new Error(result.errors.join("\n"));
  const matches = result.vms.filter((vm) => vm.id.startsWith(prefix));
  if (matches.length !== 1)
    throw new Error(
      matches.length ? "Ambiguous VM ID; use a longer prefix" : "VM not found: " + prefix,
    );
  return matches[0]!;
};
export interface VmOwner {
  update(patch: Partial<Pick<VmRecord, "state" | "workload" | "paths">>): Promise<void>;
  serve(
    stop: () => Promise<void>,
    observe: () => Promise<Partial<Pick<VmRecord, "state" | "workload" | "paths">>>,
  ): void;
  finish(error?: unknown): Promise<void>;
}
/** Register before spawning. The lock lives outside the removable instance directory. */
export const registerVm = async (record: VmRecord, home = vmInventoryHome()): Promise<VmOwner> => {
  await Deno.mkdir(join(home, ".locks"), { recursive: true, mode: 0o700 });
  await directory(home);
  const guard = await takeLock(home, record.id, true);
  const dir = recordPath(home, record.id);
  try {
    await Deno.mkdir(dir, { mode: 0o700 });
    await writeRecoveryFile(dir, "record.json", record);
  } catch (error) {
    guard.close();
    throw error;
  }
  let closed = false;
  let finishing: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let chain = Promise.resolve();
  let stopping = false;
  let polling = false;
  const update = (patch: Partial<VmRecord>) => {
    const op = chain.then(async () => {
      if (closed) return;
      // Poll control promptly, but fsync unchanged heartbeat metadata at most every 2s.
      if (
        Date.now() - Date.parse(record.observedAt) < 2000 &&
        Object.entries(patch).every(
          ([key, value]) => JSON.stringify(record[key as keyof VmRecord]) === JSON.stringify(value),
        )
      )
        return;
      record = { ...record, ...patch, observedAt: new Date().toISOString() };
      await writeRecoveryFile(dir, "record.json", record);
    });
    chain = op.catch(() => {});
    return op;
  };
  return {
    update,
    serve(stop, observe) {
      timer = setInterval(() => {
        if (polling || closed) return;
        polling = true;
        void (async () => {
          if (!stopping && (await exists(join(dir, "stop.json")))) {
            const request = (await json(join(dir, "stop.json"))) as { id?: string };
            if (request.id !== record.id)
              throw new Error("VM stop request has the wrong instance ID");
            stopping = true;
            await update({ state: "stopping", error: null });
            // Do not hold the metadata queue while shutdown itself publishes completion.
            void stop().catch((error) => update({ error: message(error) }).catch(() => {}));
          }
          if (!stopping) await update(await observe());
          else await update({});
        })()
          .catch((error) => update({ error: message(error) }).catch(() => {}))
          .finally(() => {
            polling = false;
          });
      }, 500);
      timer.unref();
    },
    finish(error) {
      return (finishing ??= (async () => {
        clearInterval(timer);
        try {
          await update(
            error
              ? { state: "orphaned", error: message(error) }
              : {
                  state: "stopped",
                  workload: record.kind === "mcp" ? record.workload : "stopped",
                  stoppedAt: new Date().toISOString(),
                  error: null,
                },
          );
        } finally {
          closed = true;
          guard.close();
        }
      })());
    },
  };
};
/** Requests are instance-scoped; no PID signalling and no daemon autostart. */
export const stopVm = async (id: string, home = vmInventoryHome(), timeoutMs = 60_000) => {
  let vm = await inspectVm(id, home);
  if (vm.state === "stopped") return vm;
  if (await ownerActive(home, id)) {
    await writeRecoveryFile(recordPath(home, id), "stop.json", { id });
    const deadline = Date.now() + timeoutMs;
    while (await ownerActive(home, id)) {
      vm = await inspectVm(id, home);
      if (Date.now() >= deadline)
        throw new Error("Timed out waiting for VM cleanup: " + vm.paths.state);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const guard = await takeLock(home, id);
  try {
    vm = await read(home, id);
    if (vm.state === "stopped") return vm;
    if (!vm.paths.session)
      throw new Error("No recovery binding; retained VM state: " + vm.paths.state);
    // Never recover a replacement instance that happens to share the session profile.
    await directory(vm.paths.session);
    const lock = await lockSessionState(vm.paths.session);
    try {
      const binding = await readRecovery(vm.paths.session);
      if (binding && (binding.token !== id || binding.state !== vm.paths.state))
        throw new Error("Session state belongs to a different VM instance");
      if (binding) await recoverSessionVm(vm.paths.session);
      else if (await exists(vm.paths.state))
        throw new Error("Missing recovery binding; retained VM state: " + vm.paths.state);
    } finally {
      lock.close();
    }
    vm = {
      ...vm,
      state: "stopped",
      workload: "stopped",
      stoppedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      source: "inventory",
      error: null,
    };
    await writeRecoveryFile(recordPath(home, id), "record.json", vm);
    return vm;
  } finally {
    guard.close();
  }
};
export const removeVm = async (id: string, home = vmInventoryHome()) => {
  const guard = await takeLock(home, id);
  try {
    const vm = await read(home, id);
    if (vm.state !== "stopped")
      throw new Error("VM must be stopped before removal; run loom vm stop " + id);
    if (await exists(vm.paths.state))
      throw new Error("VM state still exists; cleanup must finish before removal");
    // Only inventory is instance-owned after cleanup. Provider history and prepared
    // bases can share a sessionDirectory and must never be recursively removed here.
    await Deno.remove(recordPath(home, id), { recursive: true });
  } finally {
    guard.close();
  }
};

/** Forget old, confirmed-clean runtime records; never delete workspace or profile data. */
export const pruneVmInventory = async (
  repo?: string,
  home = vmInventoryHome(),
  now = Date.now(),
) => {
  const { vms } = await listVms(repo, home);
  let removed = 0;
  for (const vm of vms) {
    if (vm.state !== "stopped" || !vm.stoppedAt || now - Date.parse(vm.stoppedAt) < 60 * 60_000)
      continue;
    try {
      // Rechecks state and missing runtime directory under the owner lock.
      await removeVm(vm.id, home);
      removed++;
    } catch {
      /* Keep active, damaged and recoverable states for explicit recovery. */
    }
  }
  return removed;
};

/** Report pre-inventory temporary states explicitly; never infer ownership from a PID. */
export const legacyVmStates = async (known: VmRecord[], temporary = "/tmp") => {
  const paths: string[] = [];
  const registered = new Set(known.map((vm) => vm.paths.state));
  for await (const entry of Deno.readDir(temporary)) {
    if (!/^loom-(?:session-vm|svm|vm)-[a-z0-9]+$/.test(entry.name)) continue;
    const path = canonicalHostPath(join(temporary, entry.name));
    if ((await Deno.lstat(path)).uid === Deno.uid() && !registered.has(path)) paths.push(path);
  }
  return paths.sort();
};
