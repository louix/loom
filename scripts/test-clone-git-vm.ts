/** Live guest-shell Git, hooks and process-group cancellation; no provider credentials. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { gitFixture } from "./lib/git-fixture.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { sessionCheckoutPath } from "../runtime/src/session-vm/clone.ts";
import { vmCommand } from "../runtime/src/session-vm/command.ts";
import { CloneGit } from "../backend/daemon/src/daemon/clone-git.ts";
const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm);
const f = await gitFixture();
try {
  const branch = "loom/git-test";
  await f.git("-C", f.repo, "branch", branch, "main");
  const directory = join(f.root, "state"),
    cwd = sessionCheckoutPath(directory);
  await Deno.mkdir(cwd, { recursive: true });
  const worker = await launchSessionVm({
    workspace: cwd,
    repoRoot: f.repo,
    sessionDirectory: directory,
    artifact,
    smolvm,
    auth: {},
    providerHosts: [],
    clone: { branch, base: "main", identity: { name: "test", email: "test@localhost" } },
  });
  try {
    const { session } = await RemoteWorkerSession.connect(
      "git-test",
      "mock",
      mockLaunchSpec("/workspace/checkout"),
      () => worker,
      300000,
    );
    try {
      await session.start({
        method: "create",
        args: [
          {
            sessionId: "git-test",
            cwd: "/workspace/checkout",
            mode: "default",
            prompt: "test",
            mcpServers: [],
          },
        ],
      });
      const signal = new AbortController().signal;
      const run = (command: string, ms = 10000, s = signal, env = {}) =>
        vmCommand(worker.binding, command, ms, s, env);
      const git = new CloneGit(run);
      assert.equal((await git.facts("main", signal)).git.dirty, false);
      const env = await run(
        'test "$LOOM_CHECKOUT" = "$PWD"; printf "%s" "$TEST_VALUE"',
        10000,
        signal,
        { TEST_VALUE: "a quote ' and $(not executed)" },
      );
      assert.equal(env.code, 0);
      assert.equal(env.output, "a quote ' and $(not executed)");
      assert.equal((await run("printf private >work")).code, 0);
      assert.equal((await git.facts("main", signal)).git.dirty, true);
      assert.equal((await run("git add work && git commit -qm work")).code, 0);
      await f.git("-C", f.repo, "commit", "--allow-empty", "-m", "base moved");
      assert.equal((await git.sync(branch, "main", "rebase", signal)).outcome, "updated");
      assert.equal((await git.facts("main", signal)).git.behindBase, 0);
      assert.equal(
        await f.git("-C", f.repo, "rev-parse", branch),
        (await git.facts("main", signal)).head,
      );
      const fail = await run("echo check-failed; exit 7");
      assert.equal(fail.code, 7);
      assert.match(fail.output, /check-failed/);
      const timed = await run("(sleep 2; touch timeout-leak) & wait", 200);
      assert(timed.timedOut);
      const cancel = new AbortController();
      const pending = run("(sleep 2; touch cancel-leak) & wait", 10000, cancel.signal);
      setTimeout(() => cancel.abort(), 200);
      await pending;
      await new Promise((r) => setTimeout(r, 2500));
      for (const name of ["timeout-leak", "cancel-leak"])
        await assert.rejects(Deno.stat(join(cwd, name)), Deno.errors.NotFound);
      assert.equal((await run("printf responsive")).output, "responsive");
      console.log(
        "Passed: real VM Git facts, rebase/publication, guest environment, hook failure, timeout/cancellation kill descendants.",
      );
    } finally {
      await session.close();
    }
  } finally {
    worker.terminate();
    await worker.cleanup?.();
  }
} finally {
  await f.close();
}
