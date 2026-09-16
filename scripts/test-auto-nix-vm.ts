/** Credential-free acceptance: cold Nix startup, optional warming, fresh exports and offline cache reuse. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { gitFixture } from "./lib/git-fixture.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { normalizeSessionEnvironment } from "../core/src/session-environment.ts";
import { normalizeConfig } from "../backend/daemon/src/config/config.ts";
import { repoEnvironmentWarning } from "../cli/src/environment.ts";
import { publishRepoBase, repoBaseDirectory } from "../runtime/src/session-vm/repo-base.ts";

const [runtime, backend] = Deno.args;
assert(runtime && backend, "Pass a rebuilt session runtime and smolvm");
const artifact = await Deno.realPath(runtime);
const smolvm = await Deno.realPath(backend);
const f = await gitFixture();
const previousState = Deno.env.get("XDG_STATE_HOME");
Deno.env.set("XDG_STATE_HOME", join(f.root, "state"));
const environment = normalizeSessionEnvironment(undefined, true);
try {
  assert.equal(
    await repoEnvironmentWarning(
      f.repo,
      normalizeConfig({
        providers: { codex: { profiles: { default: {} } } },
        session: {
          auto_nix: true,
          provider_access: { only: ["codex"] },
          isolation: { enabled: true, codex: { artifact, smolvm } },
        },
      }),
    ),
    null,
  );
  await Deno.mkdir(join(f.workspace, "fixture-stdenv"));
  await Deno.writeTextFile(
    join(f.workspace, "fixture-stdenv/setup"),
    'runHook() { eval "${!1}"; }\n',
  );
  // Uses only the registered guest Bash closure: no nixpkgs fetch or provider access.
  await Deno.writeTextFile(
    join(f.workspace, "shell.nix"),
    [
      "let",
      '  bash = builtins.storePath (builtins.getEnv "LOOM_GUEST_SHELL");',
      "  cached = derivation {",
      '    name = "loom-activation-cache";',
      "    system = builtins.currentSystem;",
      "    builder = bash;",
      '    args = [ "-c" "echo cached > $out" ];',
      "  };",
      "in derivation {",
      '  name = "loom-activation-shell";',
      "  stdenv = builtins.path { path = ./fixture-stdenv; };",
      "  system = builtins.currentSystem;",
      "  builder = bash;",
      "  CACHE_PROBE = cached;",
      "  PROJECT_VALUE = builtins.readFile ./value;",
      "  shellHook = ''",
      '    export PROJECT_ROOT="$PWD"',
      "    echo activated >> activation-count",
      "  '';",
      "}",
    ].join("\n"),
  );
  const start = async (expected: string, cached: boolean) => {
    const progress: string[] = [];
    const worker = await launchSessionVm({
      artifact,
      smolvm,
      workspace: f.workspace,
      repoRoot: f.repo,
      sessionDirectory: join(f.root, "session"),
      environment,
      auth: {},
      providerHosts: [],
      extraAllowedHosts: [],
      onProgress: (message) => progress.push(message),
    });
    try {
      const { session } = await RemoteWorkerSession.connect(
        "nix-cache",
        "mock",
        mockLaunchSpec(f.workspace),
        () => worker,
        180_000,
      );
      try {
        await session.start({
          method: "create",
          args: [
            {
              sessionId: "nix-cache",
              cwd: f.workspace,
              prompt: "test",
              mode: "default",
              mcpServers: [],
              initHooks: {
                env: {},
                hooks: [
                  {
                    name: "check fresh activation",
                    timeoutMs: 30_000,
                    run: 'set -e; test "$PROJECT_ROOT" = "$PWD"; test "$(cat "$CACHE_PROBE")" = cached; printf "%s" "$PROJECT_VALUE" > activated-value',
                  },
                ],
              },
            },
          ],
        });
        assert.equal(await Deno.readTextFile(join(f.workspace, "activated-value")), expected);
        const network = (await worker.status()).network;
        if (cached) assert.deepEqual(network, []);
        else assert(network.every((request) => !request.allowed));
        assert(
          progress.some((message) =>
            message.includes(cached ? "Creating writable disks" : "No compatible prepared"),
          ),
        );
      } finally {
        await session.close();
      }
    } finally {
      worker.terminate();
      await worker.cleanup!();
    }
  };

  await Deno.writeTextFile(join(f.workspace, "value"), "cold");
  await start("cold", false);

  const home = repoBaseDirectory(f.repo);
  await Deno.mkdir(home, { recursive: true });
  const candidate = await Deno.makeTempDir({ dir: home, prefix: "base-" });
  const warm = await launchSessionVm({
    artifact,
    smolvm,
    workspace: f.workspace,
    repoRoot: f.repo,
    sessionDirectory: candidate,
    preparationOnly: true,
    environment,
    auth: {},
    providerHosts: [],
    extraAllowedHosts: [],
  });
  try {
    await Promise.all([
      warm.output.pipeTo(Deno.stdout.writable, { preventClose: true }),
      warm.diagnostics!.pipeTo(Deno.stderr.writable, { preventClose: true }),
    ]);
    assert.equal(await warm.exitCode, 0);
    await warm.cleanup!();
    await publishRepoBase(home, candidate, new AbortController().signal, artifact);
  } finally {
    warm.terminate();
    await warm.cleanup!();
  }

  await Deno.writeTextFile(join(f.workspace, "value"), "fresh");
  await start("fresh", true);
  await Deno.writeTextFile(join(f.workspace, "value"), "resumed");
  await start("resumed", true);
  assert.equal(
    (await Deno.readTextFile(join(f.workspace, "activation-count"))).trim().split("\n").length,
    4,
  );
  console.log(
    "Passed: cold startup, optional cache preparation, fresh checkout exports on resume, offline cache reuse.",
  );
} finally {
  if (previousState === undefined) Deno.env.delete("XDG_STATE_HOME");
  else Deno.env.set("XDG_STATE_HOME", previousState);
  await f.close();
}
