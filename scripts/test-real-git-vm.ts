/** Real Git in a linked worktree, using only a disposable host repository. */
import assert from "node:assert/strict";
import { gitFixture } from "./lib/git-fixture.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { normalizeSessionEnvironment } from "../core/src/session-environment.ts";
const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm, "Pass rebuilt AISDK runtime and smolvm");
const f = await gitFixture();
try {
  const worker = await launchSessionVm({
    workspace: f.workspace,
    repoRoot: f.repo,
    artifact,
    smolvm,
    auth: {},
    providerHosts: [],
    environment: normalizeSessionEnvironment({
      prepare: `exec >git-setup.log 2>&1
set -eu
git rev-parse --show-toplevel > git-root
hooks="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"
printf '#!/bin/sh\\nexit 0\\n' > "$hooks/pre-commit"
chmod +x "$hooks/pre-commit"
git config user.name 'VM test'
git config user.email 'vm@example.invalid'
echo from-vm > file.txt
git add file.txt
git commit -m 'Commit from VM'
git clone --bare . /storage/dependency.git
git -C /storage/dependency.git rev-parse HEAD > dependency-head`,
    }),
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
      assert.equal((await Deno.readTextFile(f.workspace + "/git-root")).trim(), f.workspace);
      assert.equal(await f.git("-C", f.workspace, "log", "-1", "--format=%s"), "Commit from VM");
      assert.equal(
        (await Deno.readTextFile(f.workspace + "/dependency-head")).trim(),
        await f.git("-C", f.workspace, "rev-parse", "HEAD"),
      );
      assert((await Deno.stat(f.commonDir + "/hooks/pre-commit")).isFile);
      console.log(
        "Passed: real Git root discovery, shared hooks/config, host-visible commit and guest dependency clone",
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
