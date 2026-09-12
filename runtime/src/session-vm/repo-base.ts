/** One immutable prepared disk pair per repo. Readers only lock while cloning. */
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
import { writeRecoveryFile } from "./persistence.ts";

export const repoBaseDirectory = (repo: string) =>
  canonicalHostPath(
    join(
      Deno.env.get("XDG_STATE_HOME") || join(homedir(), ".local/state"),
      "loom/environments",
      createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 32),
    ),
  );
export const currentRepoBase = async (home: string) => {
  let value;
  try {
    value = JSON.parse(await Deno.readTextFile(join(home, "current.json")));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
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
export const seedRepoBase = async (
  home: string,
  sessionDirectory: string,
  b: VmBinding,
  signal?: AbortSignal,
) => {
  const held = await lock(home, false);
  try {
    const base = await currentRepoBase(home);
    if (!base) return false;
    const disks = join(base, "disks");
    try {
      if (!(await readSessionDisks(disks, b)))
        throw new Error("Prepared environment disks are missing");
    } catch (error) {
      if (error instanceof SavedDiskCompatibilityError) return false;
      throw error;
    }
    if (b.preparationOnly)
      await saveSessionDisks(join(sessionDirectory, "disks"), disks, b, signal);
    else await createSessionDisks(join(sessionDirectory, "disks"), disks, b.smolvm, signal);
    await Deno.writeTextFile(join(b.state, "base-generation"), basename(base));
    return true;
  } finally {
    held.close();
  }
};
export const publishRepoBase = async (home: string, candidate: string, signal: AbortSignal) => {
  if (
    dirname(candidate) !== home ||
    !/^base-[a-z0-9]+$/.test(basename(candidate)) ||
    (await Deno.realPath(candidate)) !== candidate
  )
    throw new Error("Invalid prepared environment candidate");
  const held = await lock(home, true);
  try {
    const previous = await currentRepoBase(home);
    for (const stem of ["storage", "overlay"])
      await Deno.chmod(join(candidate, "disks", `${stem}.raw`), 0o400);
    signal.throwIfAborted();
    await writeRecoveryFile(home, "current.json", { directory: basename(candidate) }, signal);
    // Launches retain immutable backing bytes through their private hard links.
    if (previous && previous !== candidate)
      await Deno.remove(previous, { recursive: true }).catch(() => {});
  } finally {
    held.close();
  }
};
