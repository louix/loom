/** Live preparation -> private copies -> current branch -> init -> resume. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { gitFixture } from "./lib/git-fixture.ts";
import { normalizeConfig } from "../backend/daemon/src/config/config.ts";
import { prepareRuntimeEnvironment } from "../cli/src/environment.ts";
import {
  currentRepoBase,
  repoBaseDirectory,
  seedRepoWorkspace,
} from "../runtime/src/session-vm/repo-base.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { sessionCheckoutPath } from "../runtime/src/session-vm/clone.ts";

const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm, "Pass rebuilt session runtime and smolvm");
const f = await gitFixture();
const home = repoBaseDirectory(f.repo);
const config = normalizeConfig({
  hooks: [
    {
      name: "prepare fixture",
      on: "workspace_prepare",
      run: 'mkdir -p "$LOOM_CACHE/fixture" node_modules; printf prepared > "$LOOM_CACHE/fixture/payload"; ln "$LOOM_CACHE/fixture/payload" node_modules/payload; git rev-parse --show-toplevel > "$LOOM_CACHE/prepared-path"',
    },
    {
      name: "start fixture",
      on: "workspace_start",
      run: 'test -f node_modules/payload; test "$LOOM_CHECKOUT" = "$PWD"; echo initialized >> "$LOOM_CACHE/init-count"; git rev-parse HEAD > "$LOOM_CACHE/started-head"',
    },
  ],
  session: {
    isolation: {
      checkout: { mode: "clone" },
    },
  },
});
const boot = async (directory: string, branch: string) => {
  const checkout = sessionCheckoutPath(directory);
  const worker = await launchSessionVm({
    workspace: checkout,
    repoRoot: f.repo,
    sessionDirectory: directory,
    artifact,
    smolvm,
    auth: {},
    providerHosts: [],
    environment: config.isolation.environment!,
    clone: { branch, base: "main", identity: { name: "Loom test", email: "test@localhost" } },
  });
  try {
    const { session } = await RemoteWorkerSession.connect(
      branch,
      "mock",
      mockLaunchSpec("/workspace/checkout"),
      () => worker,
      300_000,
    );
    try {
      await session.start({
        method: "create",
        args: [
          {
            sessionId: branch,
            cwd: "/workspace/checkout",
            prompt: "test",
            mode: "default",
            mcpServers: [],
            initHooks: {
              hooks: config.hooks.filter((h) => h.on.includes("workspace_start")),
              env: {},
            },
          },
        ],
      });
    } finally {
      await session.close();
    }
  } finally {
    worker.terminate();
    await worker.cleanup?.();
  }
};
let completed = false;
try {
  await prepareRuntimeEnvironment(f.repo, config, { artifact, smolvm });
  const base = (await currentRepoBase(home, artifact))!;
  assert.equal(
    (await Deno.readTextFile(join(base, "workspace/cache/prepared-path"))).trim(),
    "/workspace/checkout",
  );
  await f.git("-C", f.repo, "commit", "--allow-empty", "-m", "base moved after preparation");
  const head = await f.git("-C", f.repo, "rev-parse", "HEAD");
  const directories = [join(f.root, "a"), join(f.root, "b")];
  for (const [index, directory] of directories.entries()) {
    await seedRepoWorkspace(home, directory, artifact);
    const branch = "loom/prepared-" + index;
    await f.git("-C", f.repo, "branch", branch, "main");
    await boot(directory, branch);
    const workspace = join(directory, "workspace");
    assert.equal((await Deno.readTextFile(join(workspace, "cache/started-head"))).trim(), head);
    const installed = await Deno.stat(join(workspace, "checkout/node_modules/payload"));
    const cached = await Deno.stat(join(workspace, "cache/fixture/payload"));
    assert.equal(installed.ino, cached.ino);
    assert.equal(installed.dev, cached.dev);
  }
  await Deno.writeTextFile(
    join(directories[0]!, "workspace/checkout/node_modules/payload"),
    "private edit",
  );
  for (const directory of [directories[1]!, base])
    assert.equal(
      await Deno.readTextFile(join(directory, "workspace/cache/fixture/payload")),
      "prepared",
    );
  await boot(directories[0]!, "loom/prepared-0");
  assert.equal(
    await Deno.readTextFile(join(directories[0]!, "workspace/checkout/node_modules/payload")),
    "private edit",
  );
  assert.equal(
    await Deno.readTextFile(join(directories[0]!, "workspace/cache/init-count")),
    "initialized\ninitialized\n",
  );
  console.log(
    "Passed: clean VM preparation, stable paths, current host branch, private hard links, independent writes, init and resume.",
  );
  completed = true;
} finally {
  if (completed) {
    await Deno.remove(home, { recursive: true });
    await f.close();
  } else console.error("Failed probe retained fixture and recovery state:", f.root, home);
}
