/** Real Git in a linked worktree, using only a disposable host repository. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { gitFixture } from "./lib/git-fixture.ts";
import { launchTestSessionVm } from "./lib/session-launch.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { chainHookScript } from "../backend/daemon/src/daemon/worktrees.ts";
const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm, "Pass rebuilt AISDK runtime and smolvm");
const f = await gitFixture();
// Keep this run's VM inventory and session state out of the user's.
Deno.env.set("XDG_STATE_HOME", join(f.root, "xdg-state"));
// Like Loom, point the worktree's hooks at a host directory outside the repository
// whose wrappers delegate to the repository's own hooks.
const loomHooks = join(f.root, "loom-hooks");
await Deno.mkdir(loomHooks);
await Deno.writeTextFile(join(loomHooks, "pre-commit"), chainHookScript(f.commonDir + "/hooks"), {
  mode: 0o755,
});
await f.git("-C", f.repo, "config", "extensions.worktreeConfig", "true");
await f.git("-C", f.workspace, "config", "--worktree", "core.hooksPath", loomHooks);
try {
  const worker = await launchTestSessionVm({
    workspace: f.workspace,
    repoRoot: f.repo,
    artifact,
    smolvm,
    auth: {},
    providerHosts: [],
    // An author-only session identity; the committer falls through to Git config.
    gitIdentity: { GIT_AUTHOR_NAME: "VM Author", GIT_AUTHOR_EMAIL: "author@example.com" },
  });
  try {
    const { session } = await RemoteWorkerSession.connect(
      "git-test",
      "mock",
      mockLaunchSpec(f.workspace),
      () => worker,
      120000,
    );
    try {
      await session.start({
        method: "create",
        args: [
          {
            sessionId: "git-test",
            cwd: f.workspace,
            prompt: "test",
            mode: "default",
            mcpServers: [],
            initHooks: {
              env: {},
              hooks: [
                {
                  name: "Git acceptance",
                  timeoutMs: 30000,
                  run: `exec >git-setup.log 2>&1
set -eu
git rev-parse --show-toplevel > git-root
if touch "$(git rev-parse --git-path hooks)/agent-written" 2>/dev/null; then
  echo 'Loom hooks are writable from the guest' >&2
  exit 1
fi
hooks="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"
cat > "$hooks/pre-commit" <<'HOOK'
#!/bin/sh
echo native-hook-ran >> hook-runs
if test -f reject-commit; then
  echo native-hook-rejected >&2
  exit 1
fi
HOOK
chmod +x "$hooks/pre-commit"
git config user.name 'VM test'
git config user.email 'vm@example.invalid'
echo from-vm > file.txt
git add file.txt
touch reject-commit
if git commit -m 'Must be rejected' > rejected-output 2>&1; then
  echo 'Git ignored the rejecting hook' >&2
  exit 1
fi
grep -q native-hook-rejected rejected-output
rm reject-commit
git commit -m 'Commit from VM'
git clone --bare . /storage/dependency.git
git -C /storage/dependency.git rev-parse HEAD > dependency-head`,
                },
              ],
            },
          },
        ],
      });
      assert.equal((await Deno.readTextFile(f.workspace + "/git-root")).trim(), f.workspace);
      assert.equal(
        await f.git("-C", f.workspace, "log", "-1", "--format=%s|%an <%ae>|%cn <%ce>"),
        "Commit from VM|VM Author <author@example.com>|VM test <vm@example.invalid>",
      );
      assert.equal(
        (await Deno.readTextFile(f.workspace + "/dependency-head")).trim(),
        await f.git("-C", f.workspace, "rev-parse", "HEAD"),
      );
      assert((await Deno.stat(f.commonDir + "/hooks/pre-commit")).isFile);
      assert.equal(
        await Deno.readTextFile(f.workspace + "/hook-runs"),
        "native-hook-ran\nnative-hook-ran\n",
      );
      assert.match(
        await Deno.readTextFile(f.workspace + "/rejected-output"),
        /native-hook-rejected/,
      );
      console.log(
        "Passed: real Git root discovery, read-only Loom hooks chaining to native hook execution and rejection, shared config, host-visible commit and guest dependency clone",
      );
    } finally {
      await session.close();
    }
  } catch (error) {
    console.error(
      await Deno.readTextFile(f.workspace + "/git-setup.log").catch(() => "No setup output"),
    );
    throw error;
  } finally {
    worker.terminate();
    await worker.cleanup?.();
  }
} finally {
  await f.close();
}
