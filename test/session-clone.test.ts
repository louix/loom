import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { gitFixture } from "../scripts/lib/git-fixture.ts";
import { vmCreateArguments, vmGitArguments, type VmBinding } from "../runtime/src/packaged/vm.ts";
import {
  prepareCloneBinding,
  sessionCheckoutPath,
  writeGitPolicy,
} from "../runtime/src/session-vm/clone.ts";

const identity = { name: "Loom (test)", email: "loom+test@localhost" };

Deno.test("clone sessions mount the clone and the relay socket, never the repository", () => {
  const sessionDirectory = "/home/test/.local/state/loom/session-vms/hash/id";
  const path = sessionCheckoutPath(sessionDirectory);
  const b: VmBinding = {
    version: 1,
    workspace: path,
    privateWorkspace: dirname(path),
    artifact: "/nix/store/runtime",
    state: "/tmp/loom-session-vm-test",
    smolvm: "/bin/smolvm",
    token: "test",
    sessionDirectory,
    mounts: [],
    manifest: {
      version: 1,
      system: "x86_64-linux",
      backend: "smolvm",
      entrypoint: "/nix/store/runtime/bin/worker",
      args: [],
    },
    git: {
      dir: "/home/test/repo/.git",
      policy: join(sessionDirectory, "git-policy.json"),
      checkout: { path: "/workspace/checkout", branch: "loom/abc", base: "main", identity },
    },
  };
  assert.deepEqual(vmGitArguments(b), [
    "--mount-socket",
    "/tmp/loom-session-vm-test/git.sock:/run/loom/git.sock",
  ]);
  const create = [...vmCreateArguments(b), ...vmGitArguments(b)];
  assert.ok(
    !create.some((arg) => arg.includes("/home/test/repo")),
    "the repository is not mounted",
  );
  assert.equal(create[create.indexOf("-w") + 1], "/workspace/checkout");
  assert.ok(create.includes(`${dirname(path)}:/workspace`));
  const { git: _, ...mounted } = b;
  assert.deepEqual(vmGitArguments(mounted), []);

  const git = b.git!;
  for (const broken of [
    { ...b, mounts: ["/home/test/repo"] },
    { ...b, mounts: undefined },
    { ...b, packageCache: "/home/test/repo/.loom/package-cache" },
    { ...b, preparationOnly: true },
    { ...b, workspace: "/home/test/repo" },
    { ...b, sessionDirectory: undefined },
    { ...b, git: { ...git, checkout: { ...git.checkout, path: "/home/test/repo" } } },
  ])
    assert.throws(() => vmGitArguments(broken as VmBinding));
});

Deno.test("host preparation writes the policy and never opens the clone with Git", async () => {
  const f = await gitFixture();
  try {
    const sessionDirectory = join(f.root, "state/session");
    await Deno.mkdir(sessionDirectory, { recursive: true });
    // Linked worktrees resolve to the shared repository, which is what the relay serves.
    const git = await prepareCloneBinding(f.workspace, sessionDirectory, {
      branch: "loom/abc",
      base: "main",
      identity,
    });
    assert.equal(git.dir, f.commonDir);
    const path = sessionCheckoutPath(sessionDirectory);
    assert.equal(git.checkout.path, "/workspace/checkout");
    assert.deepEqual([...Deno.readDirSync(path)], []);
    assert.deepEqual(JSON.parse(await Deno.readTextFile(git.policy)), {
      branch: "loom/abc",
      base: "main",
      visible: [],
    });
    assert.equal((await Deno.stat(git.policy)).mode! & 0o777, 0o600);

    // An agent-written .git in the clone must not influence the host.
    await Deno.writeTextFile(join(path, ".git"), "gitdir: /nonexistent\n");
    const again = await prepareCloneBinding(f.repo, sessionDirectory, {
      branch: "loom/renamed",
      base: "main",
      visible: ["refs/tags/"],
      identity,
      maxPushBytes: 1024,
    });
    assert.equal(again.dir, f.commonDir);
    assert.equal(again.maxPushBytes, 1024);
    assert.equal(JSON.parse(await Deno.readTextFile(again.policy)).branch, "loom/renamed");

    await assert.rejects(
      writeGitPolicy(sessionDirectory, { branch: "-x", base: "main", visible: [] }),
    );
    await assert.rejects(
      prepareCloneBinding(f.repo, sessionDirectory, { branch: "a..b", base: "main", identity }),
    );
    assert.equal(JSON.parse(await Deno.readTextFile(again.policy)).branch, "loom/renamed");

    await Deno.remove(path, { recursive: true });
    await Deno.symlink(f.repo, path);
    await assert.rejects(
      prepareCloneBinding(f.repo, sessionDirectory, { branch: "loom/abc", base: "main", identity }),
      /symlink/,
    );
  } finally {
    await f.close();
  }
});

Deno.test("tool VMs for a clone session mount the clone without running Git in it", async () => {
  const { mcpWorkspaceMounts } = await import("../backend/daemon/src/daemon/runtime-mcp.ts");
  const { sessionVmDirectory } = await import("../backend/daemon/src/daemon/session-vm-state.ts");
  const f = await gitFixture();
  const previous = Deno.env.get("XDG_STATE_HOME");
  Deno.env.set("XDG_STATE_HOME", join(f.root, "state"));
  try {
    const clone = sessionCheckoutPath(sessionVmDirectory(f.repo, "session-1"));
    await Deno.mkdir(clone, { recursive: true });
    const marker = join(f.root, "ran-on-host");
    await f.git("init", "-q", clone);
    // A redirected Git directory and an executing config are both agent-writable.
    await f.git("-C", clone, "config", "core.fsmonitor", `touch ${marker}; false`);
    assert.deepEqual(await mcpWorkspaceMounts(clone, f.repo), [dirname(clone)]);
    await assert.rejects(Deno.stat(marker), Deno.errors.NotFound);
    // A host worktree still gets the repository and its Git directory.
    assert.deepEqual(await mcpWorkspaceMounts(f.workspace, f.repo), [f.workspace, f.repo]);
  } finally {
    if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
    else Deno.env.set("XDG_STATE_HOME", previous);
    await f.close();
  }
});
