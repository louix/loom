/** Live CLI/base acceptance, with a tiny Deno repo and no provider credentials. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitFixture } from "./lib/git-fixture.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { normalizeSessionEnvironment } from "../core/src/session-environment.ts";
import { repoBaseDirectory, currentRepoBase } from "../runtime/src/session-vm/repo-base.ts";
import { startupStages } from "../runtime/src/session-vm/progress.ts";

const [runtime, backend, option] = Deno.args;
assert(runtime && backend, "Pass a rebuilt AISDK runtime and pinned smolvm");
assert(option === undefined || option === "--nix", "Optional third argument: --nix");
const nix = option === "--nix";
const artifact = await Deno.realPath(runtime);
const smolvm = await Deno.realPath(backend);
const f = await gitFixture();
// Keep the worktree outside the repo: split runtimes then need four shares
// during preparation and five with a session profile. Exercise the x86 IRQ
// regression without hiding a device by coalescing nested repository mounts.
const oldState = Deno.env.get("XDG_STATE_HOME");
Deno.env.set("XDG_STATE_HOME", join(f.root, "persistent"));
const configHome = join(f.root, "config");
const setup = `deno install
cp deno.lock /storage/project-deno.lock
count=$(cat /storage/base-count 2>/dev/null || echo 0)
echo $((count+1)) > /storage/base-count
echo setup-output
echo setup-stderr >&2
sleep 1`;
const config = async (prepare: string) => {
  await Deno.mkdir(join(configHome, "loom"), { recursive: true });
  await Deno.writeTextFile(
    join(configHome, "loom/config.toml"),
    `default_provider="openai"
[custom-provider.openai]
base_url="https://api.openai.com/v1"
[isolation]
extra_allowed_hosts=["registry.npmjs.org"]
[isolation.claude]
enabled=false
[isolation.codex]
enabled=false
[isolation.aisdk]
artifact=${JSON.stringify(artifact)}
smolvm=${JSON.stringify(smolvm)}
[isolation.environment]
nix=${nix}
command_prefix=${JSON.stringify(["sh", "-c", 'echo activation-output; exec "$@"', "activation"])}
prepare=${JSON.stringify(prepare)}
timeout_seconds=180
`,
  );
};
const cli = async (cancel = false) => {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      fileURLToPath(new URL("../cli/src/loom.ts", import.meta.url)),
      "--repo",
      f.repo,
      "environment",
      "prepare",
    ],
    env: { XDG_CONFIG_HOME: configHome },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let output = "",
    cancelled = false,
    finished = false,
    streamed = false;
  const status = child.status.then((result) => {
    finished = true;
    return result;
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 240000);
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      const text = new TextDecoder().decode(chunk);
      output = (output + text).slice(-65536);
      if (output.includes("setup-output") && !finished) streamed = true;
      if (cancel && output.includes("cancel-ready") && !cancelled) {
        cancelled = true;
        child.kill("SIGINT");
      }
    }
  };
  try {
    await Promise.all([drain(child.stdout), drain(child.stderr)]);
  } finally {
    clearTimeout(timer);
  }
  const result = await status;
  console.log(output);
  return { ...result, output, streamed, cancelled };
};
try {
  await Deno.writeTextFile(
    join(f.repo, "deno.json"),
    JSON.stringify({ nodeModulesDir: "auto", imports: { zod: "npm:zod@4.5.4" } }),
  );
  await f.git("-C", f.repo, "add", "deno.json");
  await f.git("-C", f.repo, "commit", "-m", "Deno fixture");
  await f.git("-C", f.workspace, "reset", "--hard", "main");
  await config(setup);
  const initial = await cli();
  assert(initial.success, initial.output);
  assert(
    initial.streamed &&
      initial.output.includes("activation-output") &&
      initial.output.includes("setup-stderr"),
  );
  const home = repoBaseDirectory(f.repo);
  const selected = await currentRepoBase(home, artifact);
  // A fresh worktree must materialize dependencies entirely from the VM cache.
  const directory = join(f.root, "session");
  const environment = normalizeSessionEnvironment({
    nix,
    prepare: "exit 99", // A session must never evaluate preparation against its worktree.
  });
  const start = async (expectedBase: number, during?: () => Promise<void>) => {
    const progress: string[] = [];
    const worker = await launchSessionVm({
      onProgress: (message) => progress.push(message),
      workspace: f.workspace,
      repoRoot: f.repo,
      artifact,
      smolvm,
      sessionDirectory: directory,
      environment,
      auth: {},
      providerHosts: [],
      extraAllowedHosts: [],
    });
    try {
      const { session } = await RemoteWorkerSession.connect(
        "prepared-test",
        "mock",
        mockLaunchSpec(f.workspace),
        () => worker,
        120000,
      );
      try {
        session.onStartupProgress = (message) => progress.push(message);
        await session.start({
          method: "create",
          args: [
            {
              sessionId: "prepared-test",
              cwd: f.workspace,
              prompt: "test",
              mode: "default",
              mcpServers: [],
              initHooks: {
                env: {},
                hooks: [
                  {
                    name: "install",
                    timeoutMs: 120000,
                    run: 'test ! -e /storage/session-only; cp /storage/project-deno.lock deno.lock; deno install --cached-only --frozen; cat /storage/base-count > base-count; echo private > /storage/session-only; echo cached > "$DENO_DIR/persistent-marker"',
                  },
                  {
                    name: "broken setup",
                    timeoutMs: 1000,
                    run: "echo invalid-package >&2; exit 7",
                  },
                ],
              },
            },
          ],
        });
        assert(
          progress.some(
            (message) => message.includes("exited 7") && message.includes("invalid-package"),
          ),
        );
        assert.equal(
          (await Deno.readTextFile(join(f.workspace, "base-count"))).trim(),
          String(expectedBase),
        );
        for (const stage of ["runtime", "clone", "boot", "restore", "init", "provider"] as const)
          assert(
            progress.includes(startupStages[stage]),
            `Missing startup phase ${stage}: ${progress.join("; ")}`,
          );
        assert((await Deno.stat(join(f.workspace, "node_modules/zod/package.json"))).isFile);
        if (during) {
          await during();
          assert.equal(
            session.snapshot().providerRef,
            "fake-prepared-test",
            "preparation leaves the old VM alive",
          );
        }
        assert.deepEqual(
          (await worker.status()).network,
          [],
          "Cached installation must make no network requests",
        );
      } finally {
        await session.close();
      }
    } finally {
      worker.terminate();
      await worker.cleanup!();
    }
  };
  await start(1, async () => {
    await config("echo 999 > /storage/base-count; echo deliberate-failure >&2; exit 7");
    const failed = await cli();
    assert(
      !failed.success &&
        failed.output.includes("deliberate-failure") &&
        failed.output.includes("status 7"),
    );
    assert.equal(await currentRepoBase(home, artifact), selected);
    await config("echo cancel-ready; sleep 60");
    const cancelled = await cli(true);
    assert(cancelled.cancelled && !cancelled.success);
    assert.equal(await currentRepoBase(home, artifact), selected);
    await config(setup);
    const refreshed = await cli();
    assert(
      refreshed.success &&
        refreshed.output.indexOf("Copying VM disks") >= 0 &&
        refreshed.output.indexOf("Copying VM disks") < refreshed.output.indexOf("Starting VM"),
    );
    assert.notEqual(await currentRepoBase(home, artifact), selected);
  });
  assert.equal(
    await Deno.readTextFile(join(f.repo, ".loom/package-cache/deno/persistent-marker")),
    "cached\n",
  );
  // A new launch uses the new base and retains its host worktree.
  await start(2);
  console.log(
    "Passed: live stdout/stderr, cached Deno install without network, refresh, failure, cancellation, and fresh disks on resume.",
  );
} finally {
  if (oldState === undefined) Deno.env.delete("XDG_STATE_HOME");
  else Deno.env.set("XDG_STATE_HOME", oldState);
  await f.close();
}
