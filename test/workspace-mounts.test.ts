import assert from "node:assert/strict";
import { gitFixture } from "../scripts/lib/git-fixture.ts";
import { workspaceMounts } from "../runtime/src/packaged/workspace.ts";
import { vmArguments, type VmBinding } from "../runtime/src/packaged/vm.ts";

Deno.test("repo mounts retain external worktree pointers without mounting their common parent", async () => {
  const f = await gitFixture();
  try {
    assert.deepEqual(await workspaceMounts(f.workspace, f.repo), [f.workspace, f.repo]);
    assert.deepEqual(await workspaceMounts(f.repo), [f.repo]);
    const nested = f.repo + "/nested";
    await Deno.mkdir(nested);
    assert.deepEqual(await workspaceMounts(nested), [f.repo]);
  } finally {
    await f.close();
  }
});

Deno.test("repository mounts cannot expose private state or replace guest system paths", () => {
  const b: VmBinding = {
    version: 1,
    workspace: "/home/test/repo/worktree",
    state: "/tmp/loom-state",
    artifact: "/nix/store/runtime",
    smolvm: "/bin/smolvm",
    token: "test",
    manifest: {
      version: 1,
      system: "x86_64-linux",
      backend: "smolvm",
      entrypoint: "/nix/store/runtime/bin/worker",
      args: [],
    },
  };
  const args = vmArguments({ ...b, mounts: ["/home/test/repo"] });
  assert(args.includes("/home/test/repo:/home/test/repo"));
  assert.equal(args[args.indexOf("-w") + 1], b.workspace);
  assert(!args.includes("--mount-socket"));
  for (const path of ["/", "/tmp", "/nix/store", "/run/loom", "relative", "/home/repo:ro"])
    assert.throws(() => vmArguments({ ...b, mounts: [path] }));
});
