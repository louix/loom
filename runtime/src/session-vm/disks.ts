/** Host-only raw disks. Caller holds the session ownership lock for their lifetime. */
import { dirname, join, isAbsolute } from "node:path";
import type { VmBinding } from "../packaged/vm.ts";
import { writeRecoveryFile } from "./persistence.ts";

export const sessionDiskSizes = ["--storage", "32", "--overlay", "8"];
const stems = ["storage", "overlay"];
type Identity = Pick<VmBinding, "artifact" | "smolvm" | "writableNix">;
export class SavedDiskCompatibilityError extends Error {}
const identity = (b: Identity) => ({
  version: 1,
  // The immutable artifact includes its guest image. Changing from Alpine to
  // Debian (or updating Debian) changes this path and invalidates old bases.
  artifact: b.artifact,
  smolvm: b.smolvm,
  host: `${Deno.build.arch}-${Deno.build.os}`,
  writableNix: b.writableNix === true,
});
const directory = async (path: string) => {
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink || (await Deno.realPath(path)) !== path)
    throw new Error("Saved VM disks must be in a real directory");
};
export const readSessionDisks = async (dir: string, b: Identity): Promise<boolean> => {
  try {
    await Deno.lstat(dir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
  await directory(dir);
  const file = join(dir, "identity.json");
  const info = await Deno.lstat(file);
  if (!info.isFile || info.isSymlink || info.size > 16384)
    throw new Error("Invalid saved VM disk identity");
  const saved = JSON.parse(await Deno.readTextFile(file));
  if (!saved || typeof saved !== "object" || Array.isArray(saved))
    throw new Error("Invalid saved VM disk identity");
  for (const [key, value] of Object.entries(identity(b))) {
    if (saved[key] !== value)
      throw new SavedDiskCompatibilityError(
        "Saved VM disks require a different runtime or Nix setting. Fork the session to start with the current runtime; existing worktree and history are retained.",
      );
  }
  for (const stem of stems) {
    const info = await Deno.lstat(join(dir, `${stem}.raw`));
    if (!info.isFile || info.isSymlink || info.size < 1024 * 1024)
      throw new Error("Invalid saved VM disk");
  }
  return true;
};

/** Use supported sparse/reflink copies, never hard links between independent VMs. */
export const copyDisk = async (from: string, to: string, signal?: AbortSignal) => {
  const result = await new Deno.Command(Deno.build.os === "darwin" ? "/bin/cp" : "cp", {
    args:
      Deno.build.os === "darwin"
        ? ["-c", from, to]
        : ["--reflink=auto", "--sparse=always", "--", from, to],
    stdin: "null",
    stdout: "null",
    stderr: "null",
    ...(signal ? { signal } : {}),
  }).output();
  if (!result.success) throw new Error("Could not clone the stopped VM disk");
  await Deno.chmod(to, 0o600);
  const file = await Deno.open(to, { write: true });
  try {
    await file.sync();
  } finally {
    file.close();
  }
};

/** Publish a complete pair once. Initialization may safely be retried after interruption. */
export const saveSessionDisks = async (
  dir: string,
  source: string,
  b: Identity,
  signal?: AbortSignal,
) => {
  if (await readSessionDisks(dir, b)) throw new Error("Session disks already exist");
  const staging = await Deno.makeTempDir({ dir: dirname(dir), prefix: ".disk-init-" });
  try {
    for (const stem of stems)
      await copyDisk(join(source, `${stem}.raw`), join(staging, `${stem}.raw`), signal);
    await writeRecoveryFile(staging, "identity.json", identity(b));
    // Keep exact OverlayFS lower and backend alive through Nix garbage collection.
    for (const [name, path] of [
      ["runtime", b.artifact],
      ["backend", dirname(dirname(b.smolvm))],
    ]) {
      const result = await new Deno.Command("nix-store", {
        args: [
          "--add-root",
          join(dirname(dir), `disk-${name}-root`),
          "--indirect",
          "--realise",
          path!,
        ],
        stdin: "null",
        stdout: "null",
        stderr: "null",
        ...(signal ? { signal } : {}),
      }).output();
      if (!result.success) throw new Error("Could not retain the saved VM's Nix runtime");
    }
    signal?.throwIfAborted();
    await Deno.rename(staging, dir);
    const parent = await Deno.open(dirname(dir), { read: true });
    try {
      await parent.sync();
    } finally {
      parent.close();
    }
  } finally {
    await Deno.remove(staging, { recursive: true }).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });
  }
};

/** smolvm deletes launch-local links, while the owned disk pair remains private. */
export const attachSessionDisks = async (dir: string, target: string, state: string) => {
  if (!isAbsolute(target) || !target.startsWith(state + "/"))
    throw new Error("Unexpected smolvm disk directory");
  await Deno.mkdir(target, { recursive: true, mode: 0o700 });
  for (const stem of stems) {
    for (const ext of ["raw", "qcow2", "formatted"]) {
      await Deno.remove(join(target, `${stem}.${ext}`)).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
    await Deno.symlink(join(dir, `${stem}.raw`), join(target, `${stem}.raw`));
    await Deno.writeTextFile(join(target, `${stem}.formatted`), "1");
  }
};
