import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { stageGuestImage, type VmBinding } from "../runtime/src/packaged/vm.ts";

test("guest image staging preserves cache identity across sessions without sharing writable files", async () => {
  const root = await Deno.makeTempDir();
  const artifact = join(root, "artifact");
  const binding: VmBinding = {
    version: 1,
    artifact,
    state: join(root, "first"),
    workspace: join(root, "work"),
    smolvm: "/backend/bin/smolvm",
    token: "test",
    manifest: {
      version: 1,
      backend: "smolvm",
      system: "x86_64-linux",
      entrypoint: "/nix/store/test/bin/test",
      args: [],
      guestImage: "guest-image.tar",
    },
  };
  try {
    await Deno.mkdir(artifact);
    const original = join(artifact, "guest-image.tar");
    await Deno.writeTextFile(original, "test archive");
    for (const state of [binding.state, join(root, "second")]) {
      await Deno.mkdir(state);
      await stageGuestImage({ ...binding, state });
      const path = join(state, "guest-image.tar");
      const info = await Deno.stat(path);
      assert.equal(info.mtime?.getTime(), 1000);
      assert.equal(info.mode! & 0o777, 0o400);
      assert.equal(await Deno.readTextFile(path), "test archive");
      await Deno.chmod(path, 0o600);
      await Deno.writeTextFile(path, "modified private copy");
      assert.equal(await Deno.readTextFile(original), "test archive");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
