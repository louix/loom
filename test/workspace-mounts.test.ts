import assert from "node:assert/strict";
import { gitFixture } from "../scripts/lib/git-fixture.ts";
import { gitHookMounts, workspaceMounts } from "../runtime/src/packaged/workspace.ts";
import { vmArguments, type VmBinding } from "../runtime/src/packaged/vm.ts";

Deno.test("repo mounts retain external worktree pointers without mounting the main checkout", async () => {
  const f = await gitFixture();
  try {
    const sibling = f.root + "/sibling";
    await f.git("-C", f.repo, "worktree", "add", "-b", "sibling", sibling);
    const mounts = await workspaceMounts(f.workspace);
    assert.deepEqual(mounts, [f.workspace, f.commonDir]);
    assert.ok(!mounts.some((path) => sibling === path || sibling.startsWith(path + "/")));
    assert.ok(!mounts.includes(f.repo));
    assert.equal(await f.git("-C", f.workspace, "rev-parse", "--git-common-dir"), f.commonDir);
    assert.deepEqual(await workspaceMounts(f.repo), [f.repo]);
    const nested = f.repo + "/nested";
    await Deno.mkdir(nested);
    assert.deepEqual(await workspaceMounts(nested), [f.repo]);
  } finally {
    await f.close();
  }
});

Deno.test("hook directories outside the mounts are found for read-only mounting", async () => {
  const f = await gitFixture();
  try {
    const mounts = await workspaceMounts(f.workspace);
    // Unset: the common dir's hooks, already mounted.
    assert.deepEqual(await gitHookMounts(f.workspace, mounts), []);
    const loomHooks = f.root + "/loom-hooks";
    const shared = f.root + "/shared-hooks";
    await Deno.mkdir(loomHooks);
    await Deno.mkdir(shared);
    await f.git("-C", f.repo, "config", "extensions.worktreeConfig", "true");
    await f.git("-C", f.workspace, "config", "--worktree", "core.hooksPath", loomHooks);
    // A relative path resolves inside the mounted worktree.
    await f.git("-C", f.repo, "config", "core.hooksPath", ".githooks");
    assert.deepEqual(await gitHookMounts(f.workspace, mounts), [loomHooks]);
    // An absolute one, which Loom's wrappers delegate to.
    await f.git("-C", f.repo, "config", "core.hooksPath", shared);
    assert.deepEqual(await gitHookMounts(f.workspace, mounts), [loomHooks, shared]);
    assert.deepEqual(await gitHookMounts(f.workspace, [...mounts, f.root]), []);
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
  const args = vmArguments({
    ...b,
    mounts: ["/home/test/repo"],
    readOnlyMounts: ["/home/test/hooks"],
  });
  assert(args.includes("/home/test/repo:/home/test/repo"));
  assert(args.includes("/home/test/hooks:/home/test/hooks:ro"));
  assert.equal(args[args.indexOf("-w") + 1], b.workspace);
  assert(!args.includes("--mount-socket"));
  for (const path of ["/", "/tmp", "/nix/store", "/run/loom", "relative", "/home/repo:ro"]) {
    assert.throws(() => vmArguments({ ...b, mounts: [path] }));
    assert.throws(() => vmArguments({ ...b, mounts: [], readOnlyMounts: [path] }));
  }
});
