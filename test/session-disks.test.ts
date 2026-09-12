import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { copyDisk, readSessionDisks } from "../runtime/src/session-vm/disks.ts";

test("disk copies restore sparse logical capacity without changing the immutable source", async () => {
  const root = await Deno.makeTempDir();
  try {
    const source = join(root, "base.raw"),
      target = join(root, "copy.raw");
    await Deno.writeTextFile(source, "filesystem data");
    await Deno.chmod(source, 0o400);
    await copyDisk(source, target, undefined, 1024 * 1024);
    assert.equal((await Deno.stat(target)).size, 1024 * 1024);
    assert.equal(await Deno.readTextFile(source), "filesystem data");
    const file = await Deno.open(target);
    try {
      const bytes = new Uint8Array(15);
      await file.read(bytes);
      assert.equal(new TextDecoder().decode(bytes), "filesystem data");
      await file.seek(-1, Deno.SeekMode.End);
      const tail = new Uint8Array(1);
      assert.equal(await file.read(tail), 1);
      assert.equal(tail[0], 0);
    } finally {
      file.close();
    }
    await copyDisk(source, target, undefined, 1);
    assert.equal(await Deno.readTextFile(target), "filesystem data");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

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
