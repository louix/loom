/** Live CLI/base acceptance, with a tiny Deno repo and no provider credentials. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitFixture } from "./lib/git-bridge-fixture.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { normalizeSessionEnvironment } from "../core/src/session-environment.ts";
import { repoBaseDirectory } from "../runtime/src/session-vm/repo-base.ts";

const [runtime, backend] = Deno.args;
assert(runtime && backend, "Pass a rebuilt AISDK runtime and pinned smolvm");
const artifact = await Deno.realPath(runtime);
const smolvm = await Deno.realPath(backend);
const f = await gitFixture();
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
command_prefix=${JSON.stringify(["sh", "-c", 'echo activation-output; exec "$@"', "activation"])}
prepare=${JSON.stringify(prepare)}
timeout_seconds=60
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
  const timer = setTimeout(() => child.kill("SIGTERM"), 90000);
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
  const selected = await Deno.readTextFile(join(home, "current.json"));
  // A fresh worktree must materialize dependencies entirely from the VM cache.
  const directory = join(f.root, "session");
  const environment = normalizeSessionEnvironment({
    prepare:
      "cp /storage/project-deno.lock deno.lock; deno install --cached-only --frozen; cat /storage/base-count > base-count; echo private > /storage/session-only",
  });
  const start = async () => {
    const worker = await launchSessionVm({
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
        assert.equal((await Deno.readTextFile(join(f.workspace, "base-count"))).trim(), "1");
        assert((await Deno.stat(join(f.workspace, "node_modules/zod/package.json"))).isFile);
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
  await start();
  await config("echo 999 > /storage/base-count; echo deliberate-failure >&2; exit 7");
  const failed = await cli();
  assert(
    !failed.success &&
      failed.output.includes("deliberate-failure") &&
      failed.output.includes("status 7"),
  );
  assert.equal(await Deno.readTextFile(join(home, "current.json")), selected);
  await config("echo cancel-ready; sleep 60");
  const cancelled = await cli(true);
  assert(cancelled.cancelled && !cancelled.success);
  assert.equal(await Deno.readTextFile(join(home, "current.json")), selected);
  await config(setup);
  const refreshed = await cli();
  assert(refreshed.success && refreshed.output.includes("warm disk"));
  assert.notEqual(await Deno.readTextFile(join(home, "current.json")), selected);
  // Refreshing the repo base cannot mutate or replace an existing session disk.
  await start();
  console.log(
    "Passed: live stdout/stderr, cached Deno install into a new worktree without network, refresh, failure, cancellation, and existing-session isolation.",
  );
} finally {
  if (oldState === undefined) Deno.env.delete("XDG_STATE_HOME");
  else Deno.env.set("XDG_STATE_HOME", oldState);
  await f.close();
}
