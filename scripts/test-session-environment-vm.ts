import { repoBaseDirectory, publishRepoBase } from "../runtime/src/session-vm/repo-base.ts";
/** Credential-free acceptance: this repo's Nix shell and configured setup in a VM. */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitFixture } from "./lib/git-fixture.ts";
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
const oldState = Deno.env.get("XDG_STATE_HOME");
Deno.env.set("XDG_STATE_HOME", join(f.root, "persistent"));
const nested = join(f.repo, ".loom/trees/session");
await Deno.mkdir(dirname(nested), { recursive: true });
await f.git("-C", f.repo, "worktree", "move", f.workspace, nested);
f.workspace = nested;
const sessionDirectory = await Deno.realPath(
  await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-env-persist-" }),
);
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
    // This credential-free fixture retains setup diagnostics for a failed test.
    command_prefix: [
      "bash",
      "-c",
      'exec nix develop path:. --no-write-lock-file --command "$@" > .environment-setup.log 2>&1',
      "environment-check",
    ],
    timeout_seconds: 900,
  });
  const home = repoBaseDirectory(f.repo);
  await Deno.mkdir(home, { recursive: true });
  const candidate = await Deno.makeTempDir({ dir: home, prefix: "base-" });
  const preparation = await launchSessionVm({
    sessionDirectory: candidate,
    preparationOnly: true,
    prepareHooks: [
      {
        name: "fixture",
        run: 'command -v node > /storage/environment-node; test -n "$COREPACK_HOME"; echo 1 > /storage/loom-env-count',
        timeoutMs: 900_000,
      },
    ],
    repoRoot: f.repo,
    workspace: f.workspace,
    artifact,
    smolvm,
    auth: {},
    environment,
    providerHosts: [],
    extraAllowedHosts: expandNetworkPresets(["nix", "javascript"]),
  });
  try {
    await Promise.all([
      preparation.output.pipeTo(Deno.stdout.writable, { preventClose: true }),
      preparation.diagnostics!.pipeTo(Deno.stderr.writable, { preventClose: true }),
    ]);
    assert.equal(await preparation.exitCode, 0);
    await preparation.cleanup!();
    await publishRepoBase(home, candidate, new AbortController().signal);
  } finally {
    preparation.terminate();
    await preparation.cleanup!();
  }
  for (const launch of [1, 2]) {
    const started = performance.now();
    const worker = await launchSessionVm({
      sessionDirectory,
      repoRoot: f.repo,
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
        await session.start({
          method: "create",
          args: [
            {
              sessionId: "environment-check",
              cwd: f.workspace,
              prompt: "check",
              mode: "default",
              mcpServers: [],
              initHooks: {
                env: {},
                hooks: [
                  {
                    name: "dependencies",
                    timeoutMs: 600000,
                    run: "deno install --frozen; cp /storage/environment-node .environment-node; cp /storage/loom-env-count .environment-launch-count",
                  },
                ],
              },
            },
          ],
        });
        assert((await Deno.stat(join(f.workspace, "node_modules/zod/package.json"))).isFile);
        assert.equal(
          (await Deno.readTextFile(join(f.workspace, ".environment-launch-count"))).trim(),
          "1",
        );
        assert.match(
          await Deno.readTextFile(join(f.workspace, ".environment-node")),
          /^\/nix\/store\/.+\/bin\/node\s*$/,
        );
        const status = await worker.status();
        assert(!status.network.some((entry) => !entry.allowed), JSON.stringify(status.network));
        console.log(
          `Launch ${launch}: Nix shell and dependencies ready after ${((performance.now() - started) / 1000).toFixed(1)}s; cached base reused with fresh activation.`,
        );
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
  }
} finally {
  if (oldState === undefined) Deno.env.delete("XDG_STATE_HOME");
  else Deno.env.set("XDG_STATE_HOME", oldState);
  await Deno.remove(sessionDirectory, { recursive: true });
  await f.close();
}
