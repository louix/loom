import assert from "node:assert/strict";
import { join } from "node:path";
import { inspectGitShim } from "../runtime/src/packaged/artifact.ts";

Deno.test("Git shim validation uses the guest store and rejects escaping links", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const target = "/nix/store/00000000000000000000000000000000-guest-git/bin/git";
  try {
    await Deno.mkdir(join(root, "bin"));
    await Deno.mkdir(join(root, target, ".."), { recursive: true });
    await Deno.writeTextFile(join(root, "git-bridge-version"), "2\n");
    await Deno.writeTextFile(join(root, target), "guest executable\n", { mode: 0o755 });
    await Deno.symlink(target, join(root, "bin/git"));
    await inspectGitShim(root);
    await Deno.chmod(join(root, target), 0o644);
    await assert.rejects(inspectGitShim(root), /not executable/);
    await Deno.remove(join(root, target));
    await Deno.symlink("/bin/sh", join(root, target));
    await assert.rejects(inspectGitShim(root), /escapes artifact/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
