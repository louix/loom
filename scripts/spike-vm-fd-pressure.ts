/** Reproduce shared-filesystem descriptor pressure without a live provider or real credentials.
 * Usage: deno run -A scripts/spike-vm-fd-pressure.ts ARTIFACT SMOLVM [FILES=120000]
 * See docs/claude-vm-auth-investigation.md for the reduced-limit reproduction.
 */
import { join } from "node:path";
import assert from "node:assert/strict";
import { gitFixture } from "./lib/git-fixture.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { vmEnvironment, sessionVmName } from "../runtime/src/packaged/vm.ts";

assert(Deno.build.os === "linux", "This diagnostic uses Linux /proc and guest drop_caches.");
const [artifact, smolvm, countArg = "120000"] = Deno.args;
assert(artifact && smolvm, "Pass a compatible session runtime artifact and smolvm executable.");
const count = Number(countArg);
assert(Number.isSafeInteger(count) && count > 0 && count <= 200000);
const inventory = (await Deno.readTextFile(join(artifact, "store-paths"))).trim().split("\n");
const denoStore = inventory.find((p) => /-deno-[0-9]/.test(p));
assert(denoStore, "The runtime must contain Deno.");
const deno = join(denoStore, "bin/deno");
const existingPids = new Set<string>();
for await (const entry of Deno.readDir("/proc")) existingPids.add(entry.name);

const f = await gitFixture();
let worker: Awaited<ReturnType<typeof launchSessionVm>> | undefined;
let session: RemoteWorkerSession | undefined;
try {
  const files = join(f.workspace, "files");
  await Deno.mkdir(files);
  for (let i = 0; i < count; i++) Deno.writeTextFileSync(join(files, String(i)), "");
  worker = await launchSessionVm({
    workspace: f.workspace,
    artifact,
    smolvm,
    auth: {
      claudeAiOauth: {
        accessToken: "diagnostic-not-a-real-token",
        expiresAt: Date.now() + 3600000,
        scopes: [],
      },
    },
    onProgress: (message) => console.log(JSON.stringify({ progress: message })),
  });
  session = (
    await RemoteWorkerSession.connect(
      "fd-pressure",
      "mock",
      mockLaunchSpec(f.workspace),
      () => worker!,
      120000,
      { connector: "@loom/connector-mock", config: {} },
    )
  ).session;

  // One long-lived guest process avoids trying to launch a binary after its
  // shared libraries become unreadable. It never logs credential contents.
  const code = `
    function probe() {
      try {
        const value = JSON.parse(Deno.readTextFileSync("/run/loom/private/auth.json"));
        return { readable: !!value.claudeAiOauth.accessToken };
      } catch (error) {
        return { error: error.message };
      }
    }
    console.log(JSON.stringify({
      stage: "before", auth: probe(),
      limits: Deno.readTextFileSync("/proc/self/limits").split("\\n")
        .find(line => line.startsWith("Max open files")),
    }));
    let errors = 0, firstError;
    for (let i = 0; i < ${count}; i++) {
      try { Deno.statSync(${JSON.stringify(files)} + "/" + i); }
      catch (error) {
        errors++;
        firstError ??= { file: i, message: error.message };
        if (errors >= 20) break;
      }
    }
    let ownFds = 0;
    for (const _ of Deno.readDirSync("/proc/self/fd")) ownFds++;
    console.log(JSON.stringify({ stage: "after", errors, firstError, auth: probe(), ownFds }));
    await new Promise(resolve => setTimeout(resolve, 3000));

    // This affects ONLY this disposable guest, never the host's caches.
    try {
      Deno.writeTextFileSync("/proc/sys/vm/drop_caches", "2");
      await new Promise(resolve => setTimeout(resolve, 1000));
      console.log(JSON.stringify({ stage: "after-cache-drop", auth: probe() }));
    } catch (error) {
      console.log(JSON.stringify({ stage: "cache-drop-error", error: error.message }));
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  `;
  const child = new Deno.Command(smolvm, {
    args: [
      "machine",
      "exec",
      "--name",
      sessionVmName,
      "-i",
      "--",
      deno,
      "eval",
      "--no-config",
      code,
    ],
    clearEnv: true,
    env: vmEnvironment(worker.binding.state),
    stdin: "piped",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* Already exited. */
    }
  }, 60000);
  const monitor = setInterval(async () => {
    for await (const entry of Deno.readDir("/proc")) {
      if (!/^[0-9]+$/.test(entry.name) || existingPids.has(entry.name)) continue;
      try {
        const path = "/proc/" + entry.name;
        if (!(await Deno.readTextFile(path + "/comm")).includes("libkrun")) continue;
        console.log(
          JSON.stringify({
            pid: entry.name,
            // FDSize is allocated table capacity, not an exact open-descriptor count.
            status: (await Deno.readTextFile(path + "/status"))
              .split("\n")
              .filter((line) => /^(Name|FDSize):/.test(line)),
            limit: (await Deno.readTextFile(path + "/limits"))
              .split("\n")
              .find((line) => line.startsWith("Max open files")),
          }),
        );
      } catch {
        /* A backend may exit during sampling. */
      }
    }
  }, 2000);
  try {
    assert((await child.status).success, "The diagnostic process failed or timed out.");
  } finally {
    clearInterval(monitor);
    clearTimeout(timeout);
  }
} finally {
  try {
    await session?.close();
  } finally {
    worker?.terminate();
    try {
      await worker?.cleanup?.();
    } finally {
      await f.close();
    }
  }
}
