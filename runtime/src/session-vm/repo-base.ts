/** Immutable prepared disks per repo and runtime. Readers only lock while cloning. */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalHostPath } from "../../../core/src/host-path.ts";
import type { VmBinding } from "../packaged/vm.ts";
import {
  readSessionDisks,
  saveSessionDisks,
  createSessionDisks,
  SavedDiskCompatibilityError,
} from "./disks.ts";
import { initializeWorkspace, privateWorkspacePath, exists } from "./workspace.ts";
import { environmentIdentity } from "./environment-identity.ts";
import { writeRecoveryFile, lockSessionState, assertNoActiveVm } from "./persistence.ts";
import { referencedBases } from "../packaged/maintenance.ts";

export const repoBaseDirectory = (repo: string) =>
  canonicalHostPath(
    join(
      Deno.env.get("XDG_STATE_HOME") || join(homedir(), ".local/state"),
      "loom/environments",
      createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 32),
    ),
  );
const selectionFile = async (artifact?: string) =>
  artifact
    ? `current-${createHash("sha256")
        .update(await environmentIdentity(artifact))
        .digest("hex")
        .slice(0, 32)}.json`
    : "current.json";

export const currentRepoBase = async (
  home: string,
  artifact?: string,
): Promise<string | undefined> => {
  let value;
  try {
    value = JSON.parse(await Deno.readTextFile(join(home, await selectionFile(artifact))));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // Existing single-runtime preparations remain usable after upgrading.
      if (artifact) {
        const legacy = await currentRepoBase(home);
        if (legacy) {
          const identity = JSON.parse(await Deno.readTextFile(join(legacy, "disks/identity.json")));
          if (identity.artifact === (await environmentIdentity(artifact))) return legacy;
        }
      }
      return;
    }
    throw error;
  }
  if (!value || typeof value.directory !== "string" || !/^base-[a-z0-9]+$/.test(value.directory))
    throw new Error("Invalid prepared environment selection");
  const path = join(home, value.directory);
  if ((await Deno.realPath(path)) !== path)
    throw new Error("Prepared environment must not be a symlink");
  return path;
};
const lock = async (home: string, exclusive: boolean) => {
  await Deno.mkdir(home, { recursive: true, mode: 0o700 });
  if ((await Deno.realPath(home)) !== home)
    throw new Error("Prepared environment directory must not be a symlink");
  const file = await Deno.open(join(home, "publication.lock"), {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  try {
    await file.lock(exclusive);
    return file;
  } catch (error) {
    file.close();
    throw error;
  }
};
/** Caller holds the publication lock while inspecting or consuming the selection. */
const compatibleRepoBase = async (
  home: string,
  b: Pick<VmBinding, "artifact" | "smolvm" | "writableNix">,
) => {
  const base = await currentRepoBase(home, b.artifact);
  if (!base) return;
  try {
    if (!(await readSessionDisks(join(base, "disks"), b)))
      throw new Error("Prepared environment disks are missing");
  } catch (error) {
    if (error instanceof SavedDiskCompatibilityError) return;
    throw error;
  }
  return base;
};

/** Check before launching a supervisor; seeding revalidates under the same lock. */
export const hasCompatibleRepoBase = async (
  home: string,
  b: Pick<VmBinding, "artifact" | "smolvm" | "writableNix">,
) => {
  const held = await lock(home, false);
  try {
    return (await compatibleRepoBase(home, b)) !== undefined;
  } finally {
    held.close();
  }
};

/** Copy a published workspace while holding the base publication lock. */
export const seedRepoWorkspace = async (home: string, directory: string, artifact?: string) => {
  if (await exists(privateWorkspacePath(directory))) return await initializeWorkspace(directory);
  const held = await lock(home, false);
  try {
    const base = await currentRepoBase(home, artifact);
    const prepared = base ? privateWorkspacePath(base) : undefined;
    return await initializeWorkspace(
      directory,
      prepared && (await exists(prepared)) ? prepared : undefined,
    );
  } finally {
    held.close();
  }
};

export const seedRepoBase = async (
  home: string,
  sessionDirectory: string,
  b: VmBinding,
  signal?: AbortSignal,
) => {
  const held = await lock(home, false);
  try {
    const base = await compatibleRepoBase(home, b);
    if (!base) return false;
    const disks = join(base, "disks");
    if (b.preparationOnly)
      await saveSessionDisks(join(sessionDirectory, "disks"), disks, b, signal);
    else await createSessionDisks(join(sessionDirectory, "disks"), disks, b.smolvm, signal);
    await Deno.writeTextFile(join(b.state, "base-generation"), basename(base));
    return true;
  } finally {
    held.close();
  }
};
export const publishRepoBase = async (
  home: string,
  candidate: string,
  signal: AbortSignal,
  artifact?: string,
) => {
  if (
    dirname(candidate) !== home ||
    !/^base-[a-z0-9]+$/.test(basename(candidate)) ||
    (await Deno.realPath(candidate)) !== candidate
  )
    throw new Error("Invalid prepared environment candidate");
  const held = await lock(home, true);
  try {
    const previous = await currentRepoBase(home, artifact);
    for (const stem of ["storage", "overlay"])
      await Deno.chmod(join(candidate, "disks", `${stem}.raw`), 0o400);
    signal.throwIfAborted();
    await writeRecoveryFile(
      home,
      await selectionFile(artifact),
      { directory: basename(candidate) },
      signal,
    );
    // Launches retain immutable backing bytes through their private hard links.
    // Keep the legacy selection valid until it is explicitly replaced.
    const legacy = artifact ? await currentRepoBase(home) : undefined;
    const inUse = await referencedBases().catch(() => undefined);
    if (
      previous &&
      previous !== candidate &&
      previous !== legacy &&
      inUse &&
      !inUse.has(basename(previous))
    )
      await Deno.remove(previous, { recursive: true }).catch(() => {});
  } finally {
    held.close();
  }
};

/** Keep configured selections and VM references; obsolete runtime keys need no replacement. */
export const pruneRepoBases = async (
  home: string,
  bindings: Array<Pick<VmBinding, "artifact" | "smolvm" | "writableNix">> | undefined,
  temporary = "/tmp",
  dryRun = false,
): Promise<{
  removed: number;
  retained: number;
  retainedBases: Array<{ directory: string; reason: string }>;
}> => {
  const preparing = await lockSessionState(join(home, "preparation"));
  try {
    const held = await lock(home, true);
    try {
      const selections = new Set<string>();
      const inUse = await referencedBases(temporary);
      const keep = new Set<string>();
      for (const binding of bindings ?? []) {
        // Pruning follows the configured image identity, not whether setup has
        // already succeeded for every runtime/backend/Nix setting. One missing
        // replacement must not pin all historical image selections.
        selections.add(await selectionFile(binding.artifact));
        const base = await currentRepoBase(home, binding.artifact);
        if (base && (await currentRepoBase(home)) === base) selections.add("current.json");
      }
      // Validate all selections before changing anything. An unknown format is not garbage.
      const obsolete: string[] = [];
      for await (const entry of Deno.readDir(home)) {
        if (!/^(?:current|current-[a-f0-9]{32})\.json$/.test(entry.name)) continue;
        const path = join(home, entry.name);
        const info = await Deno.lstat(path);
        if (!info.isFile || info.isSymlink || info.size > 16384)
          throw new Error("Invalid environment selection");
        const value = JSON.parse(await Deno.readTextFile(path));
        if (
          !value ||
          typeof value.directory !== "string" ||
          !/^base-[a-z0-9]+$/.test(value.directory)
        )
          throw new Error("Invalid environment selection");
        if (bindings === undefined || selections.has(entry.name)) keep.add(value.directory);
        else obsolete.push(path);
      }
      if (!dryRun) for (const path of obsolete) await Deno.remove(path);
      let removed = 0;
      const retainedBases: Array<{ directory: string; reason: string }> = [];
      const retain = (directory: string, reason: string) =>
        retainedBases.push({ directory, reason });
      for await (const entry of Deno.readDir(home)) {
        if (!/^base-[a-z0-9]+$/.test(entry.name)) continue;
        const path = join(home, entry.name);
        const info = await Deno.lstat(path);
        if (!info.isDirectory || info.isSymlink) {
          retain(entry.name, "not a real base directory");
          continue;
        }
        if (keep.has(entry.name)) {
          retain(entry.name, "current selection");
          continue;
        }
        if (inUse.has(entry.name)) {
          retain(entry.name, "referenced by a running or recoverable VM");
          continue;
        }
        let owner: Deno.FsFile | undefined;
        try {
          owner = await lockSessionState(path);
          await assertNoActiveVm(path);
          // Also protect Linux launches from older versions which retained backing links.
          for (const stem of ["storage", "overlay"]) {
            try {
              if ((await Deno.lstat(join(path, "disks", stem + ".raw"))).nlink! > 1)
                throw new Error("Base still has live backing links");
            } catch (error) {
              if (!(error instanceof Deno.errors.NotFound)) throw error;
            }
          }
          if (!dryRun) await Deno.remove(path, { recursive: true });
          removed++;
        } catch (error) {
          retain(entry.name, error instanceof Error ? error.message : String(error));
        } finally {
          owner?.close();
        }
      }
      retainedBases.sort((a, b) => a.directory.localeCompare(b.directory));
      return { removed, retained: retainedBases.length, retainedBases };
    } finally {
      held.close();
    }
  } finally {
    preparing.close();
  }
};
