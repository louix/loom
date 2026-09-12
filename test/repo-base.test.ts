import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  hasCompatibleRepoBase,
  publishRepoBase,
  seedRepoBase,
} from "../runtime/src/session-vm/repo-base.ts";
import type { VmBinding } from "../runtime/src/packaged/vm.ts";

const rawDisks = async (base: string) => {
  await Deno.mkdir(join(base, "disks"), { recursive: true });
  for (const stem of ["storage", "overlay"]) {
    const disk = await Deno.open(join(base, "disks", `${stem}.raw`), { create: true, write: true });
    await disk.truncate(1024 * 1024);
    disk.close();
  }
};

test("a new guest image artifact skips the Alpine base without deleting it", async () => {
  const home = await Deno.realPath(await Deno.makeTempDir());
  const base = join(home, "base-alpine");
  const binding: VmBinding = {
    version: 1,
    artifact: "/nix/store/new-debian-runtime",
    smolvm: "/nix/store/backend/bin/smolvm",
    writableNix: true,
    manifest: {
      version: 1,
      backend: "smolvm",
      system: "x86_64-linux",
      entrypoint: "/nix/store/tool/bin/tool",
      args: [],
      guestImage: "guest-image.tar",
    },
    workspace: join(home, "worktree"),
    state: join(home, "state"),
    token: "test",
  };
  try {
    await rawDisks(base);
    await Deno.writeTextFile(
      join(base, "disks/identity.json"),
      JSON.stringify({
        version: 1,
        artifact: "/nix/store/old-alpine-runtime",
        smolvm: binding.smolvm,
        host: `${Deno.build.arch}-${Deno.build.os}`,
        writableNix: true,
      }),
    );
    await publishRepoBase(home, base, new AbortController().signal);
    assert.equal(await hasCompatibleRepoBase(home, binding), false);
    assert.equal(
      await hasCompatibleRepoBase(home, { ...binding, artifact: "/nix/store/old-alpine-runtime" }),
      true,
    );
    assert.equal(await seedRepoBase(home, join(home, "session"), binding), false);
    assert.equal(
      JSON.parse(await Deno.readTextFile(join(home, "current.json"))).directory,
      "base-alpine",
    );
    assert((await Deno.stat(base)).isDirectory);
    await assert.rejects(Deno.stat(join(home, "session/disks")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

test("base publication preserves the previous selection on cancellation and waits for readers", async () => {
  const home = await Deno.realPath(await Deno.makeTempDir());
  const first = join(home, "base-first"),
    next = join(home, "base-next");
  let reader: Deno.FsFile | undefined;
  try {
    await rawDisks(first);
    await rawDisks(next);
    const signal = new AbortController().signal;
    await publishRepoBase(home, first, signal);
    const selected = await Deno.readTextFile(join(home, "current.json"));
    await assert.rejects(publishRepoBase(home, next, AbortSignal.abort()));
    assert.equal(await Deno.readTextFile(join(home, "current.json")), selected);
    assert((await Deno.stat(first)).isDirectory);
    reader = await Deno.open(join(home, "publication.lock"), { read: true, write: true });
    await reader.lock(false);
    let published = false;
    const pending = publishRepoBase(home, next, signal).then(() => {
      published = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(published, false);
    assert.equal(await Deno.readTextFile(join(home, "current.json")), selected);
    reader.close();
    reader = undefined;
    await pending;
    assert.equal(
      JSON.parse(await Deno.readTextFile(join(home, "current.json"))).directory,
      "base-next",
    );
    await assert.rejects(Deno.stat(first), Deno.errors.NotFound);
  } finally {
    reader?.close();
    await Deno.remove(home, { recursive: true });
  }
});
