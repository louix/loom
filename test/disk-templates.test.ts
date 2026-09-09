import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  attachDiskTemplates,
  retainDiskTemplates,
} from "../runtime/src/packaged/disk-templates.ts";

test("VM template cache preserves bases across cleanup without sharing writable state", async () => {
  const root = await Deno.makeTempDir();
  const a = join(root, "first");
  const b = join(root, "second");
  try {
    await Deno.mkdir(join(a, "cache/smolvm"), { recursive: true });
    await attachDiskTemplates(a, Deno.execPath());
    for (const name of ["storage-template.ext4", "overlay-template.ext4"])
      await Deno.writeTextFile(join(a, "cache/smolvm", name), `base ${name}`);
    await retainDiskTemplates(a, Deno.execPath());
    await Deno.remove(a, { recursive: true });
    await attachDiskTemplates(b, Deno.execPath());
    for (const name of ["storage-template.ext4", "overlay-template.ext4"]) {
      const path = join(b, "home/.smolvm", name);
      assert((await Deno.lstat(path)).isSymlink);
      assert.equal(await Deno.readTextFile(path), `base ${name}`);
      assert.equal((await Deno.stat(path)).mode! & 0o222, 0);
    }
    await assert.rejects(Deno.stat(join(b, "cache/smolvm/vms")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
