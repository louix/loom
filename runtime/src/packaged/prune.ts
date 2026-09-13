/** Delete only Loom-owned cache generations. Nix itself collects released store paths. */
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { lockSessionState } from "../session-vm/persistence.ts";
import { vmMaintenanceLock, retainedVmStates } from "./maintenance.ts";

export interface CachePruneResult {
  generations: number;
  templates: number;
  deferred: boolean;
}

export const pruneRuntimeCache = async (
  home: string,
  protectedPaths: string[],
  temporary = "/tmp",
): Promise<CachePruneResult> => {
  const result = { generations: 0, templates: 0, deferred: false };
  const guard = await vmMaintenanceLock(true, temporary);
  if (!guard) return { ...result, deferred: true };
  try {
    // Old launchers and crashed supervisors have no live lease but leave private state.
    if ((await retainedVmStates(temporary)).length) return { ...result, deferred: true };
    const protectedSet = new Set(protectedPaths);
    const retainedBackends = new Set<string>();
    const entries = async (path: string) => {
      try {
        const info = await Deno.lstat(path);
        if (!info.isDirectory || info.isSymlink) throw new Error("Unsafe runtime cache directory");
        return await Array.fromAsync(Deno.readDir(path));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return [];
        throw error;
      }
    };
    for (const source of await entries(home)) {
      if (!/^[a-f0-9]{64}$/.test(source.name) || !source.isDirectory || source.isSymlink) continue;
      const parent = await Deno.realPath(join(home, source.name));
      let updating: Deno.FsFile | undefined;
      try {
        updating = await lockSessionState(parent);
        const current = await Deno.realPath(join(parent, "current"));
        if (dirname(current) !== parent || !/^generation-[a-z0-9]+$/.test(basename(current)))
          throw new Error("Invalid runtime selection");
        const currentPin = JSON.parse(await Deno.readTextFile(join(current, "lock.json")));
        if (
          currentPin.version !== 1 ||
          typeof currentPin.smolvm !== "string" ||
          typeof currentPin.artifact !== "string"
        )
          throw new Error("Invalid runtime lock");
        retainedBackends.add(currentPin.smolvm);
        for (const entry of await entries(parent)) {
          if (!/^generation-[a-z0-9]+$/.test(entry.name) || !entry.isDirectory || entry.isSymlink)
            continue;
          const path = join(parent, entry.name);
          if (path === current) continue;
          try {
            // An interrupted build may already have a GC root but no lock.json.
            const artifact = await Deno.realPath(join(path, "artifact")).catch((error) => {
              if (error instanceof Deno.errors.NotFound) return undefined;
              throw error;
            });
            if (artifact && protectedSet.has(artifact)) continue;
            const file = join(path, "lock.json");
            const info = await Deno.lstat(file);
            if (!info.isFile || info.isSymlink || info.size > 16384) continue;
            const pin = JSON.parse(await Deno.readTextFile(file));
            if (
              pin.version !== 1 ||
              typeof pin.artifact !== "string" ||
              typeof pin.smolvm !== "string"
            ) {
              result.deferred = true;
              continue;
            }
            if (
              protectedSet.has(pin.artifact) ||
              (protectedSet.has(pin.smolvm) && !retainedBackends.has(pin.smolvm))
            ) {
              retainedBackends.add(pin.smolvm);
              continue;
            }
          } catch (error) {
            // A generation interrupted before its lock was written cannot have been selected.
            if (!(error instanceof Deno.errors.NotFound)) continue;
          }
          await Deno.remove(path, { recursive: true });
          result.generations++;
        }
      } catch {
        result.deferred = true;
      } finally {
        updating?.close();
      }
    }
    const cache = join(temporary, `loom-vm-templates-${Deno.uid()}`);
    // Every retained runtime generation can still need its backend template.
    const keepTemplates = new Set<string>();
    for (const path of protectedPaths)
      keepTemplates.add(createHash("sha256").update(path).digest("hex").slice(0, 32));
    for (const source of await entries(home)) {
      if (!/^[a-f0-9]{64}$/.test(source.name) || !source.isDirectory || source.isSymlink) continue;
      for (const entry of await entries(join(home, source.name))) {
        if (!/^generation-[a-z0-9]+$/.test(entry.name) || !entry.isDirectory || entry.isSymlink)
          continue;
        try {
          const pin = JSON.parse(
            await Deno.readTextFile(join(home, source.name, entry.name, "lock.json")),
          );
          if (pin.version !== 1 || typeof pin.smolvm !== "string")
            throw new Error("Invalid runtime lock");
          keepTemplates.add(createHash("sha256").update(pin.smolvm).digest("hex").slice(0, 32));
        } catch {
          result.deferred = true;
        }
      }
    }
    if (!result.deferred)
      for (const entry of await entries(cache)) {
        if (
          !/^[a-f0-9]{32}$/.test(entry.name) ||
          !entry.isDirectory ||
          entry.isSymlink ||
          keepTemplates.has(entry.name)
        )
          continue;
        await Deno.remove(join(cache, entry.name), { recursive: true });
        result.templates++;
      }
    return result;
  } finally {
    guard.close();
  }
};
