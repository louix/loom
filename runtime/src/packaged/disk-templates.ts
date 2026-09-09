/** Reuse immutable smolvm base disks, never writable VM disks or profiles.
 * Cache beside disposable VM state so publication is an atomic hard link,
 * preserving sparse files without copying tens of gigabytes of zeroes. */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const names = ["storage-template.ext4", "overlay-template.ext4"];
const cacheDirectory = async (state: string, binary: string): Promise<string> => {
  const uid = Deno.uid();
  const root = join(dirname(state), `loom-vm-templates-${uid}`);
  await Deno.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await Deno.lstat(root);
  if (!stat.isDirectory || stat.uid !== uid || (stat.mode! & 0o077) !== 0)
    throw new Error("Unsafe VM template cache directory");
  const key = createHash("sha256")
    .update(await Deno.realPath(binary))
    .digest("hex")
    .slice(0, 32);
  const dir = join(root, key);
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await Deno.lstat(dir)).isDirectory) throw new Error("Unsafe VM template cache entry");
  return dir;
};

/** An unavailable cache is only a performance penalty; smolvm can unpack itself. */
export const attachDiskTemplates = async (state: string, binary: string): Promise<void> => {
  try {
    const cache = await cacheDirectory(state, binary);
    const home = join(state, "home/.smolvm");
    await Deno.mkdir(home, { recursive: true, mode: 0o700 });
    for (const name of names) {
      try {
        const path = join(cache, name);
        const stat = await Deno.lstat(path);
        if (stat.isFile && stat.uid === Deno.uid() && stat.size > 0 && (stat.mode! & 0o222) === 0)
          await Deno.symlink(path, join(home, name));
      } catch {
        /* Missing templates are populated after the first successful boot. */
      }
    }
  } catch {
    /* Cache unavailable: keep the independent cold-start path. */
  }
};

/** Called only after successful boot: smolvm has finished writing both bases. */
export const retainDiskTemplates = async (state: string, binary: string): Promise<void> => {
  try {
    const cache = await cacheDirectory(state, binary);
    for (const name of names) {
      try {
        const source = join(state, "cache/smolvm", name);
        if (!(await Deno.lstat(source)).isFile) continue;
        await Deno.chmod(source, 0o444);
        await Deno.link(source, join(cache, name));
      } catch {
        /* Existing winner, warm boot, or unavailable cache: no mutation. */
      }
    }
  } catch {
    /* Never fail a running VM because caching failed. */
  }
};
