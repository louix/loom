/** A clone session in a real guest: no repository mount, one remote, own branch only. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { gitFixture } from "./lib/git-fixture.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { sessionCheckoutPath } from "../runtime/src/session-vm/clone.ts";
const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm, "Pass rebuilt session runtime and smolvm");
const f = await gitFixture();
const identity = { name: "Loom (vm-test)", email: "loom+vm-test@localhost" };
try {
  // The fixture's linked worktree stands in for a sibling session the guest must not see.
  await Deno.writeTextFile(join(f.workspace, "sibling.txt"), "sibling\n");
  await f.git("-C", f.workspace, "add", "sibling.txt");
  await f.git("-C", f.workspace, "commit", "-m", "sibling work");
  const sibling = await f.git("-C", f.workspace, "rev-parse", "HEAD");
  await f.git("-C", f.repo, "branch", "loom/livetest", "main");
  const main = await f.git("-C", f.repo, "rev-parse", "main");
  const sessionDirectory = join(f.root, "state/session");
  const checkout = sessionCheckoutPath(sessionDirectory);
  await Deno.mkdir(checkout, { recursive: true });
  const worker = await launchSessionVm({
    workspace: checkout,
    repoRoot: f.repo,
    sessionDirectory,
    artifact,
    smolvm,
    auth: {},
    providerHosts: [],
    clone: { branch: "loom/livetest", base: "main", identity },
  });
  try {
    const { session } = await RemoteWorkerSession.connect(
      "clone-test",
      "mock",
      mockLaunchSpec(checkout),
      () => worker,
      120000,
    );
    try {
      await session.start({
        method: "create",
        args: [
          {
            sessionId: "clone-test",
            cwd: checkout,
            prompt: "test",
            mode: "default",
            mcpServers: [],
            initHooks: {
              env: {},
              hooks: [
                {
                  name: "Clone acceptance",
                  timeoutMs: 60000,
                  run: `exec >setup.log 2>&1
set -eu
git rev-parse --show-toplevel > git-root
git symbolic-ref --short HEAD > branch
git ls-remote origin | cut -f2 > refs
if test -e '${f.repo}'; then echo visible > repo-visible; fi
# Anything the agent plants in its own clone stays in the guest.
printf '#!/bin/sh\\ntouch %s\\n' '${f.root}/hook-ran-on-host' > .git/hooks/post-commit
chmod +x .git/hooks/post-commit
git config core.fsmonitor 'touch ${f.root}/config-ran-on-host'
echo from-vm > file.txt
git add file.txt
git commit -m 'Commit from VM'
git push
if git push origin HEAD:main; then echo main-accepted > policy; exit 1; fi
if git push origin HEAD:refs/heads/session; then echo sibling-accepted > policy; exit 1; fi
if git fetch origin ${sibling}; then echo hidden-served > policy; exit 1; fi
if git fetch origin session; then echo sibling-served > policy; exit 1; fi
echo enforced > policy`,
                },
              ],
            },
          },
        ],
      });
      const read = async (name: string) => (await Deno.readTextFile(join(checkout, name))).trim();
      assert.equal(await read("git-root"), checkout);
      assert.equal(await read("branch"), "loom/livetest");
      assert.equal(await read("refs"), "refs/heads/loom/livetest\nrefs/heads/main");
      assert.equal(await read("policy"), "enforced");
      await assert.rejects(Deno.stat(join(checkout, "repo-visible")), Deno.errors.NotFound);
      // Host assertions read host refs only; host Git never opens the clone.
      assert.equal(
        await f.git("-C", f.repo, "log", "-1", "--format=%s|%an|%ae", "loom/livetest"),
        `Commit from VM|${identity.name}|${identity.email}`,
      );
      assert.equal(await f.git("-C", f.repo, "rev-parse", "main"), main);
      assert.equal(await f.git("-C", f.repo, "rev-parse", "session"), sibling);
      await f.git("-C", f.repo, "status", "--porcelain");
      for (const name of ["hook-ran-on-host", "config-ran-on-host"])
        await assert.rejects(Deno.stat(join(f.root, name)), Deno.errors.NotFound);
      console.log(
        "Passed: clone in guest without a repository mount, exact ref visibility, own-branch push reaching the host, refused base and sibling pushes, hidden history refused, guest hooks and config inert on the host",
      );
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error(
      await Deno.readTextFile(join(checkout, "setup.log")).catch(() => "No setup output"),
    );
    throw error;
  } finally {
    worker.terminate();
    await worker.cleanup?.();
  }
} finally {
  await f.close();
}
