import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readSessionDisks } from "../runtime/src/session-vm/disks.ts";

test("saved disks reject incompatible runtimes and substituted files without discarding state", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const dir = join(root, "disks");
  const binding = {
    artifact: "/nix/store/runtime",
    smolvm: "/nix/store/backend/bin/smolvm",
    writableNix: true,
  };
  try {
    assert.equal(await readSessionDisks(dir, binding), false);
    await Deno.mkdir(dir);
    await Deno.writeTextFile(
      join(dir, "identity.json"),
      JSON.stringify({
        version: 1,
        ...binding,
        host: `${Deno.build.arch}-${Deno.build.os}`,
      }),
    );
    for (const stem of ["storage", "overlay"]) {
      const file = await Deno.open(join(dir, `${stem}.raw`), { createNew: true, write: true });
      await file.truncate(1024 * 1024);
      file.close();
    }
    assert.equal(await readSessionDisks(dir, binding), true);
    await assert.rejects(
      readSessionDisks(dir, { ...binding, artifact: "/nix/store/new" }),
      /different runtime/,
    );
    await assert.rejects(
      readSessionDisks(dir, { ...binding, writableNix: false }),
      /different runtime/,
    );
    await Deno.rename(join(dir, "storage.raw"), join(root, "outside.raw"));
    await Deno.symlink(join(root, "outside.raw"), join(dir, "storage.raw"));
    await assert.rejects(readSessionDisks(dir, binding), /Invalid saved VM disk/);
    assert.equal((await Deno.stat(join(root, "outside.raw"))).size, 1024 * 1024);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
