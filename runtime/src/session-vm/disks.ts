/** Immutable prepared raw disks and disposable per-launch writable disks. */
import { dirname, join, isAbsolute } from "node:path";
import { link } from "node:fs/promises";
import type { VmBinding } from "../packaged/vm.ts";
import { writeRecoveryFile } from "./persistence.ts";
import { environmentIdentity } from "./environment-identity.ts";
import { reportStartup } from "./progress.ts";

const diskGiB = { storage: 32, overlay: 8 };
export const sessionDiskSizes = Object.entries(diskGiB).flatMap(([name, size]) => [
  `--${name}`,
  String(size),
]);
const stems = ["storage", "overlay"] as const;
/** Caller holds ownership and has confirmed shutdown; profiles and host files are separate. */
export const discardSessionDisks = async (home: string, dryRun = false): Promise<boolean> => {
  let removed = false;
  for await (const entry of Deno.readDir(home)) {
    if (
      !["disks", "disk-runtime-root", "disk-backend-root"].includes(entry.name) &&
      !/^\.disk-init-[a-z0-9]+$/.test(entry.name)
    )
      continue;
    if (!dryRun) await Deno.remove(join(home, entry.name), { recursive: true });
    removed = true;
  }
  return removed;
};
type Identity = Pick<VmBinding, "artifact" | "smolvm" | "writableNix">;
export class SavedDiskCompatibilityError extends Error {}
const identity = async (b: Identity) => ({
  version: 1,
  // Legacy/custom images retain exact artifact matching.
  artifact: await environmentIdentity(b.artifact),
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
  for (const [key, value] of Object.entries(await identity(b))) {
    if (saved[key] !== value)
      throw new SavedDiskCompatibilityError(
        "Prepared VM disks require a different runtime or Nix setting. Prepare the environment again.",
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
export const copyDisk = async (from: string, to: string, signal?: AbortSignal, minimumSize = 0) => {
  reportStartup("copy");
  const result = await new Deno.Command(Deno.build.os === "darwin" ? "/bin/cp" : "cp", {
    args:
      Deno.build.os === "darwin"
        ? ["-c", from, to]
        : ["--reflink=auto", "--sparse=always", "--", from, to],
    stdin: "null",
    stdout: "null",
    stderr: "piped",
    ...(signal ? { signal } : {}),
  }).output();
  if (!result.success)
    throw new Error(
      `Could not copy the VM disk: ${new TextDecoder().decode(result.stderr).trim().slice(-2048)}`,
    );
  await Deno.chmod(to, 0o600);
  const file = await Deno.open(to, { write: true });
  try {
    // Sparse backend disks can end before the filesystem's declared capacity.
    // Restore the logical length before creating a qcow2 overlay from this file.
    if ((await file.stat()).size < minimumSize) await file.truncate(minimumSize);
    await file.sync();
  } finally {
    file.close();
  }
};

/** Linux uses the same libkrun disk creator as smolvm; macOS uses APFS clones.
 * Backing-file hard links keep the immutable bytes alive even after a failed
 * supervisor or base replacement. Only the private overlay is ever writable.
 */
export const createSessionDisks = async (
  dir: string,
  base: string,
  smolvm: string,
  signal?: AbortSignal,
) => {
  await Deno.mkdir(dir, { mode: 0o700 });
  reportStartup("clone");
  if (Deno.build.os !== "linux") {
    for (const stem of stems)
      await copyDisk(
        join(base, `${stem}.raw`),
        join(dir, `${stem}.raw`),
        signal,
        diskGiB[stem] * 1024 ** 3,
      );
    return;
  }
  const root = dirname(dirname(smolvm));
  const library = [join(root, "libexec/smolvm/lib/libkrun.so"), join(root, "lib/libkrun.so")];
  let path: string | undefined;
  for (const candidate of library) {
    try {
      path = await Deno.realPath(candidate);
      break;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  if (!path)
    throw new Error("The configured smolvm has no bundled libkrun for writable disk creation");
  const lib = Deno.dlopen(path, {
    krun_create_disk_overlay: { parameters: ["buffer", "buffer", "u32"], result: "i32" },
  });
  const cstring = (value: string) => new TextEncoder().encode(value + "\0");
  try {
    for (const stem of stems) {
      signal?.throwIfAborted();
      const source = join(base, `${stem}.raw`);
      const backing = join(dir, `base-${stem}.raw`);
      const size = diskGiB[stem] * 1024 ** 3;
      if ((await Deno.stat(source)).size < size) {
        await copyDisk(source, backing, signal, size);
      } else {
        try {
          await link(source, backing);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          await copyDisk(source, backing, signal, size);
        }
      }
      const overlay = join(dir, `${stem}.qcow2`);
      const result = lib.symbols.krun_create_disk_overlay(cstring(overlay), cstring(backing), 0);
      if (result < 0) throw new Error(`Could not create writable VM disk (${result})`);
      await Deno.chmod(overlay, 0o600);
    }
  } finally {
    lib.close();
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
      await copyDisk(
        join(source, `${stem}.raw`),
        join(staging, `${stem}.raw`),
        signal,
        diskGiB[stem] * 1024 ** 3,
      );
    await writeRecoveryFile(staging, "identity.json", await identity(b));
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

/** Attach a prepared candidate or launch-local writable pair to smolvm. */
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
    let ext = "raw";
    try {
      await Deno.lstat(join(dir, `${stem}.qcow2`));
      ext = "qcow2";
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await Deno.symlink(join(dir, `${stem}.${ext}`), join(target, `${stem}.${ext}`));
    await Deno.writeTextFile(join(target, `${stem}.formatted`), "1");
  }
};
