/** Credential-free acceptance: this repo's Nix shell and configured setup in a VM. */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitFixture } from "./lib/git-bridge-fixture.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import {
  normalizeSessionEnvironment,
  sessionStartupTimeout,
} from "../core/src/session-environment.ts";
import { expandNetworkPresets } from "../runtime/src/session-vm/network-policy.ts";

const [artifact, smolvm = "smolvm"] = Deno.args;
assert(artifact, "Pass a rebuilt session runtime and optionally the smolvm executable");
const source = fileURLToPath(new URL("../", import.meta.url));
const f = await gitFixture();
try {
  // Copy current source, including new files, without the host's Git metadata,
  // ignored caches, credentials or sockets. Git operations use the fixture repo.
  const inventory = await new Deno.Command("git", {
    args: ["-C", source, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(inventory.success, "Could not enumerate source checkout");
  for (const path of new TextDecoder().decode(inventory.stdout).split("\0").filter(Boolean)) {
    const from = join(source, path);
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.lstat(from);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) continue;
      throw e;
    }
    if (!stat.isFile) continue;
    const to = join(f.workspace, path);
    await Deno.mkdir(dirname(to), { recursive: true });
    await Deno.copyFile(from, to);
  }
  const environment = normalizeSessionEnvironment({
    nix: true,
    // This credential-free fixture retains setup diagnostics for a failed test.
    command_prefix: [
      "bash",
      "-c",
      'exec nix develop path:. --no-write-lock-file --command "$@" > .environment-setup.log 2>&1',
      "environment-check",
    ],
    prepare: 'deno install --frozen\ncommand -v node > .environment-node\ntest -n "$COREPACK_HOME"',
    timeout_seconds: 900,
  });
  const worker = await launchSessionVm({
    workspace: f.workspace,
    artifact,
    smolvm,
    auth: {},
    environment,
    providerHosts: [],
    extraAllowedHosts: expandNetworkPresets(["nix", "javascript"]),
  });
  try {
    const { session } = await RemoteWorkerSession.connect(
      "environment-check",
      "mock",
      mockLaunchSpec(f.workspace),
      () => worker,
      sessionStartupTimeout(environment),
    );
    try {
      assert((await Deno.stat(join(f.workspace, "node_modules/zod/package.json"))).isFile);
      assert.match(
        await Deno.readTextFile(join(f.workspace, ".environment-node")),
        /^\/nix\/store\/.+\/bin\/node\s*$/,
      );
      const status = await worker.status();
      assert(!status.network.some((entry) => !entry.allowed), JSON.stringify(status.network));
      console.log("Nix shell activated; repo dependencies installed before worker readiness.");
    } finally {
      await session.close();
    }
  } catch (error) {
    const log = await Deno.readTextFile(join(f.workspace, ".environment-setup.log")).catch(
      () => "",
    );
    console.error(log.slice(-16000));
    throw error;
  } finally {
    worker.terminate();
    await worker.cleanup?.();
  }
} finally {
  await f.close();
}
