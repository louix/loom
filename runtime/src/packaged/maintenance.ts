/** Serialize cache collection against managed VM lifetimes, across repositories. */
import { join } from "node:path";

export const vmMaintenanceLock = async (exclusive = false, temporary = "/tmp") => {
  const path = join(temporary, `loom-vm-maintenance-${Deno.uid()}.lock`);
  const file = await Deno.open(path, { create: true, read: true, write: true, mode: 0o600 });
  try {
    const info = await Deno.lstat(path);
    if (!info.isFile || info.isSymlink || info.uid !== Deno.uid())
      throw new Error("Unsafe VM maintenance lock");
    if (exclusive) {
      if (!(await file.tryLock(true))) {
        file.close();
        return undefined;
      }
    } else await file.lock(false);
    return file;
  } catch (error) {
    file.close();
    throw error;
  }
};

/** Retained state is evidence of use even if its supervisor crashed. Never follow symlinks. */
export const retainedVmStates = async (temporary = "/tmp"): Promise<string[]> => {
  const states: string[] = [];
  for await (const entry of Deno.readDir(temporary)) {
    if (!/^loom-(?:session-vm|svm|vm)-[a-z0-9]+$/.test(entry.name)) continue;
    const path = join(temporary, entry.name);
    const info = await Deno.lstat(path);
    if (info.uid === Deno.uid()) states.push(path);
  }
  return states;
};

export const referencedBases = async (temporary = "/tmp"): Promise<Set<string>> => {
  const bases = new Set<string>();
  for (const state of await retainedVmStates(temporary)) {
    const info = await Deno.lstat(state);
    if (!info.isDirectory || info.isSymlink) throw new Error("Unsafe retained VM state");
    try {
      const file = join(state, "base-generation");
      const stat = await Deno.lstat(file);
      if (!stat.isFile || stat.isSymlink || stat.size > 128)
        throw new Error("Invalid base reference");
      const name = await Deno.readTextFile(file);
      if (!/^base-[a-z0-9]+$/.test(name)) throw new Error("Invalid base reference");
      bases.add(name);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return bases;
};
