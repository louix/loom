/** Durable private workspaces. Host code copies bytes, never executes workspace Git. */
import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const guestWorkspace = "/workspace";
export const guestCheckout = "/workspace/checkout";
export const guestCache = "/workspace/cache";
export const workspaceVersion = 1;

export const privateWorkspacePath = (directory: string) => join(directory, "workspace");

/** Only the new layout is remapped. Existing clone sessions keep their original paths. */
export const workspaceMount = (checkout: string) =>
  checkout.endsWith("/workspace/checkout")
    ? { host: dirname(checkout), guest: guestWorkspace, checkout: guestCheckout }
    : { host: checkout, guest: checkout, checkout };

export const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

/**
 * Copy a stopped, private tree. Reflink when available; otherwise copy bytes.
 * Preserve hard-link groups inside the destination, never between trees.
 * Symlinks are copied as symlinks, never followed.
 */
export const copyWorkspace = async (source: string, destination: string): Promise<void> => {
  if (!(await Deno.lstat(source)).isDirectory || (await Deno.realPath(source)) !== source)
    throw new Error("Prepared workspace must be a real directory");
  await Deno.mkdir(destination, { mode: 0o700 });
  const links = new Map<string, string>();
  const copy = async (from: string, to: string): Promise<void> => {
    for await (const entry of Deno.readDir(from)) {
      const src = join(from, entry.name),
        dst = join(to, entry.name);
      const info = await Deno.lstat(src);
      if (info.isSymlink) {
        await Deno.symlink(await Deno.readLink(src), dst);
      } else if (info.isDirectory) {
        await Deno.mkdir(dst, { mode: 0o700 });
        await copy(src, dst);
        if (info.mode !== null) await Deno.chmod(dst, info.mode & 0o777);
      } else if (info.isFile) {
        const key = info.nlink !== null && info.nlink > 1 ? info.dev + ":" + info.ino : undefined;
        const previous = key ? links.get(key) : undefined;
        if (previous) await Deno.link(previous, dst);
        else {
          await copyFile(src, dst, constants.COPYFILE_FICLONE);
          if (key) links.set(key, dst);
        }
        if (info.mode !== null) await Deno.chmod(dst, info.mode & 0o777);
        if (info.mtime) await Deno.utime(dst, info.atime ?? info.mtime, info.mtime);
      } else throw new Error("Prepared workspace contains a special file: " + entry.name);
    }
  };
  await copy(source, destination);
};

/** Publish once, before any VM mounts the directory. Existing work is never overwritten. */
export const initializeWorkspace = async (
  directory: string,
  prepared?: string,
): Promise<string> => {
  const target = privateWorkspacePath(directory);
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await Deno.realPath(directory)) !== directory)
    throw new Error("Workspace parent must be canonical");
  if (await exists(target)) {
    if (!(await Deno.lstat(target)).isDirectory || (await Deno.realPath(target)) !== target)
      throw new Error("Session workspace must be a real directory");
    return target;
  }
  const staging = await Deno.makeTempDir({ dir: directory, prefix: ".workspace-init-" });
  const tree = join(staging, "workspace");
  try {
    if (prepared) await copyWorkspace(prepared, tree);
    else await Deno.mkdir(tree, { mode: 0o700 });
    for (const name of ["checkout", "cache"]) {
      const path = join(tree, name);
      await Deno.mkdir(path, { recursive: true });
      if ((await Deno.realPath(path)) !== path) throw new Error("Unsafe prepared workspace layout");
    }
    const marker = join(tree, ".loom-workspace.json");
    if (await exists(marker)) await Deno.remove(marker);
    await Deno.writeTextFile(marker, JSON.stringify({ version: workspaceVersion }), {
      createNew: true,
    });
    await Deno.rename(tree, target);
    return target;
  } finally {
    await Deno.remove(staging, { recursive: true });
  }
};
