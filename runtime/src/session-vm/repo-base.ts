/** One immutable prepared disk pair per repo. Readers only lock while cloning. */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalHostPath } from "../../../core/src/host-path.ts";
import type { VmBinding } from "../packaged/vm.ts";
import { readSessionDisks, saveSessionDisks, SavedDiskCompatibilityError } from "./disks.ts";
import { writeRecoveryFile } from "./persistence.ts";

export const repoBaseDirectory = (repo: string) =>
  canonicalHostPath(
    join(
      Deno.env.get("XDG_STATE_HOME") || join(homedir(), ".local/state"),
      "loom/environments",
      createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 32),
    ),
  );
const current = async (home: string) => {
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
    const base = await current(home);
    if (!base) return false;
    const disks = join(base, "disks");
    try {
      if (!(await readSessionDisks(disks, b)))
        throw new Error("Prepared environment disks are missing");
    } catch (error) {
      if (error instanceof SavedDiskCompatibilityError) return false;
      throw error;
    }
    await saveSessionDisks(join(sessionDirectory, "disks"), disks, b, signal);
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
    const previous = await current(home);
    signal.throwIfAborted();
    await writeRecoveryFile(home, "current.json", { directory: basename(candidate) }, signal);
    // All readers have completed their independent copies; no live disk depends on this base.
    if (previous && previous !== candidate)
      await Deno.remove(previous, { recursive: true }).catch(() => {});
  } finally {
    held.close();
  }
};
