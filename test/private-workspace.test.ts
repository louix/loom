import assert from "node:assert/strict";
import { join } from "node:path";
import {
  copyWorkspace,
  initializeWorkspace,
  workspaceMount,
} from "../runtime/src/session-vm/workspace.ts";

Deno.test("private workspaces preserve internal hard links without sharing writable inodes", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  try {
    const base = join(root, "base");
    await Deno.mkdir(join(base, "checkout"), { recursive: true });
    await Deno.mkdir(join(base, "cache"));
    await Deno.writeTextFile(join(base, "cache/package"), "original");
    await Deno.link(join(base, "cache/package"), join(base, "checkout/installed"));
    await Deno.symlink("../cache/package", join(base, "checkout/link"));
    const a = await initializeWorkspace(join(root, "a"), base);
    const b = await initializeWorkspace(join(root, "b"), base);
    const cache = await Deno.stat(join(a, "cache/package"));
    assert.equal((await Deno.stat(join(a, "checkout/installed"))).ino, cache.ino);
    assert.notEqual((await Deno.stat(join(base, "cache/package"))).ino, cache.ino);
    await Deno.writeTextFile(join(a, "checkout/installed"), "changed");
    assert.equal(await Deno.readTextFile(join(a, "cache/package")), "changed");
    assert.equal(await Deno.readTextFile(join(b, "cache/package")), "original");
    assert.equal(await Deno.readTextFile(join(base, "cache/package")), "original");
    assert.equal(await initializeWorkspace(join(root, "a"), base), a);
    assert.equal(await Deno.readTextFile(join(a, "checkout/installed")), "changed");
    assert.equal(await Deno.readLink(join(a, "checkout/link")), "../cache/package");
    assert.deepEqual(workspaceMount(join(a, "checkout")), {
      host: a,
      guest: "/workspace",
      checkout: "/workspace/checkout",
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("workspace initialization is atomic and refuses symlink roots", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  try {
    const unsafe = join(root, "unsafe");
    await Deno.mkdir(unsafe);
    await Deno.symlink(root, join(unsafe, "checkout"));
    await assert.rejects(initializeWorkspace(join(root, "session"), unsafe), /Unsafe/);
    await assert.rejects(Deno.stat(join(root, "session/workspace")), Deno.errors.NotFound);
    assert.deepEqual([...Deno.readDirSync(join(root, "session"))], []);
    await Deno.symlink(unsafe, join(root, "alias"));
    await assert.rejects(copyWorkspace(join(root, "alias"), join(root, "copy")), /real directory/);
    const empty = await initializeWorkspace(join(root, "session"));
    assert((await Deno.stat(join(empty, "checkout"))).isDirectory);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
