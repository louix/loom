import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, normalizeConfig } from "../backend/daemon/src/config/config.ts";
import { detectNixActivation, nixActivationCommand } from "../core/src/nix-activation.ts";
import { normalizeSessionEnvironment } from "../core/src/session-environment.ts";
import {
  activateLocalEnvironment,
  applyEnvironmentChanges,
} from "../backend/daemon/src/daemon/local-environment.ts";
import { ProviderRegistry } from "../backend/daemon/src/daemon/provider-registry.ts";
import { WorkerProvider } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import {
  activateSessionEnvironment,
  prepareEnvironment,
} from "../runtime/src/session-vm/environment.ts";
import type { AgentSession } from "../core/src/types.ts";

const settings = true;
const signal = () => new AbortController().signal;
const transcript = {
  load: () => [],
  count: () => 0,
  append() {},
  replaceFrom() {},
  clear() {},
  copyTo() {},
};

const fixture = async () => {
  const root = await Deno.makeTempDir({ prefix: "loom-nix-test-" });
  const bin = join(root, "nix-bin");
  await Deno.mkdir(bin);
  const script = String.raw`#!/bin/sh
set -e
printf '%s\n' "$*" >> .activation-log
if test -f .fail; then echo 'broken dev shell' >&2; exit 17; fi
if test -f .wait; then sleep 20; fi
IFS= read -r PROJECT_VALUE < .value
export PROJECT_VALUE
export HOME=/wrong-home TMPDIR=/deleted-nix-temp
export PATH="$PWD/bin:$PATH"
echo 'shell hook output'
if test "$1" = shell; then
  test "$2" = --
  shift 2
  exec "$@"
fi
if test "$1" = develop; then
  test "$3" = --no-write-lock-file
  test "$4" = --command
  shift 4
  exec "$@"
fi
test "$1" = ./shell.nix || test "$1" = ./default.nix
test -f "$1"
test "$2" = --run
exec /bin/sh -c "$3"
`;
  for (const name of ["nix", "nix-shell", "devenv"]) {
    await Deno.writeTextFile(join(bin, name), script);
    await Deno.chmod(join(bin, name), 0o755);
  }
  const previous = Deno.env.get("PATH");
  Deno.env.set("PATH", bin + ":" + (previous ?? "/usr/bin:/bin"));
  const checkout = async (name: string, file = "flake.nix") => {
    const cwd = join(root, name);
    await Deno.mkdir(join(cwd, "bin"), { recursive: true });
    await Deno.writeTextFile(join(cwd, file), "");
    await Deno.writeTextFile(join(cwd, ".value"), name + "\n");
    await Deno.writeTextFile(
      join(cwd, "bin/project-tool"),
      '#!/bin/sh\nprintf "%s" "$PROJECT_VALUE"\n',
    );
    await Deno.chmod(join(cwd, "bin/project-tool"), 0o755);
    return cwd;
  };
  return {
    root,
    bin,
    checkout,
    async close() {
      if (previous === undefined) Deno.env.delete("PATH");
      else Deno.env.set("PATH", previous);
      await Deno.remove(root, { recursive: true });
    },
  };
};

test("Nix is opt-in, independent of downloads, and repo overrides merge before validation", async () => {
  assert.equal(normalizeConfig({}).autoNix, false);
  assert.equal(
    normalizeConfig({ session: { isolation: { network_presets: ["nix"] } } }).autoNix,
    false,
  );
  assert.deepEqual(
    normalizeConfig({ session: { auto_nix: true } }).isolation.extraAllowedHosts,
    [],
  );
  const f = await fixture();
  try {
    const repo = await f.checkout("repo");
    const configPath = join(f.root, "config.jsonc");
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        session: { auto_nix: false },
        repos: [{ path: repo, session: { auto_nix: true } }],
      }),
    );
    assert.equal(loadConfig(repo, configPath).autoNix, true);
    assert.equal(loadConfig(repo, configPath).isolation.environment?.autoNix, true);
    assert.equal(loadConfig(f.root, configPath).autoNix, false);
    for (const auto_nix of ["yes", {}, null, 1]) {
      assert.throws(() => normalizeConfig({ session: { auto_nix } }), /session.auto_nix/);
    }
    assert.throws(
      () =>
        normalizeConfig({
          session: { environment: { nix: { auto_activate: true } } },
        }),
      /replaced by session.auto_nix/,
    );
    assert.throws(
      () =>
        normalizeConfig({
          session: { isolation: { environment: { nix: true } } },
        }),
      /supplies the writable Nix store automatically/,
    );
    assert.equal(detectNixActivation(repo, false), undefined);
  } finally {
    await f.close();
  }
});

test("detection is root-only, prefers flakes, and quotes legacy shell arguments", async () => {
  const f = await fixture();
  try {
    const cwd = await f.checkout("legacy", "shell.nix");
    assert.equal(detectNixActivation(cwd, settings)?.kind, "shell");
    const value = "a b ' $(touch injected)";
    const argv = nixActivationCommand({ kind: "shell" }, [
      "/bin/sh",
      "-c",
      'printf "%s" "$1"',
      "fixture",
      value,
    ]);
    const result = await new Deno.Command(argv[0]!, {
      args: argv.slice(1),
      cwd,
      stdout: "piped",
    }).output();
    assert(result.success);
    assert(new TextDecoder().decode(result.stdout).endsWith(value));
    await assert.rejects(Deno.stat(join(cwd, "injected")), Deno.errors.NotFound);
    await Deno.writeTextFile(join(cwd, "flake.nix"), "");
    assert.equal(detectNixActivation(cwd, settings)?.kind, "flake");
    assert.equal(detectNixActivation(join(cwd, "bin"), settings), undefined);
    const plain = await f.checkout("plain", "project.nix");
    assert.equal(await activateLocalEnvironment(plain, settings, signal()), undefined);
  } finally {
    await f.close();
  }
});

test("activation exports are isolated, protect launch state, and fail without fallback", async () => {
  const f = await fixture();
  const secret = "PROJECT_UNRELATED_DAEMON_SECRET";
  Deno.env.set(secret, "not-for-workers");
  try {
    const a = await f.checkout("first");
    const b = await f.checkout("second", "shell.nix");
    const originalPath = Deno.env.get("PATH");
    const [one, two] = await Promise.all([
      activateLocalEnvironment(a, true, signal()),
      activateLocalEnvironment(b, settings, signal()),
    ]);
    assert.equal(one?.set.PROJECT_VALUE, "first");
    assert.equal(two?.set.PROJECT_VALUE, "second");
    assert.equal(one?.set[secret], undefined);
    assert.equal(one?.set.HOME, undefined);
    assert.equal(one?.set.TMPDIR, undefined);
    assert.equal(Deno.env.get("PATH"), originalPath);
    assert.match(
      await Deno.readTextFile(join(a, ".activation-log")),
      /path:.#default --no-write-lock-file --command/,
    );
    await Deno.writeTextFile(join(a, ".fail"), "");
    await assert.rejects(
      activateLocalEnvironment(a, settings, signal()),
      /Nix activation exited 17.*\nbroken dev shell/,
    );
    await Deno.remove(join(a, ".fail"));
    await Deno.writeTextFile(join(a, ".wait"), "");
    await assert.rejects(
      activateLocalEnvironment(a, settings, signal(), undefined, 50),
      /timed out/,
    );
    const stop = new AbortController();
    const pending = activateLocalEnvironment(a, settings, stop.signal);
    setTimeout(() => stop.abort(), 50);
    await assert.rejects(pending, /aborted/);
    await Deno.remove(join(f.bin, "nix"));
    // Restrict PATH so a real Nix installation cannot satisfy the missing fixture.
    Deno.env.set("PATH", "/usr/bin:/bin");
    await assert.rejects(
      activateLocalEnvironment(a, settings, signal()),
      /Nix activation exited 127/,
    );
  } finally {
    Deno.env.delete(secret);
    await f.close();
  }
});

test("local hooks, fresh workers, resume and shell targets share activation", async () => {
  const f = await fixture();
  const sessions: AgentSession[] = [];
  let registry: ProviderRegistry | undefined;
  try {
    const cwd = await f.checkout("session");
    const config = normalizeConfig({
      session: { auto_nix: true },
      hooks: [
        {
          on: "workspace_start",
          run: "project-tool > init-environment; printf x >> init-count",
        },
      ],
    });
    // Use a real protocol worker whose provider executes a project tool on create and resume.
    registry = new ProviderRegistry(
      config,
      transcript,
      {
        "@loom/connector-mock": async () => ({
          createProvider: () =>
            WorkerProvider.create("fake", (workspace) => ({
              ...mockLaunchSpec(workspace),
              entrypoint: fileURLToPath(
                new URL("./fixtures/environment-worker.ts", import.meta.url),
              ),
              env: { PATH: Deno.env.get("PATH")!, TMPDIR: f.root },
              permissions: {
                read: [fileURLToPath(new URL("../", import.meta.url)), f.root],
                write: [f.root],
                run: true,
                env: true,
                net: [],
              },
            })),
        }),
      },
      cwd,
    );
    const provider = await registry.get("fake");
    sessions.push(
      await provider.createSession({
        sessionId: "activated",
        cwd,
        prompt: "test",
        mode: "default",
        mcpServers: [],
      }),
    );
    assert.equal(await Deno.readTextFile(join(cwd, "init-environment")), "session");
    assert.equal(await Deno.readTextFile(join(cwd, "worker-environment")), "session");
    assert.equal(await Deno.readTextFile(join(cwd, "worker-private")), f.root);
    const shell = await registry.shellEnvironment("activated", cwd, signal());
    const result = await new Deno.Command("project-tool", {
      cwd,
      clearEnv: true,
      env: applyEnvironmentChanges(Deno.env.toObject(), shell),
      stdout: "piped",
    }).output();
    assert.equal(new TextDecoder().decode(result.stdout), "session");
    await sessions[0]!.close();
    await Deno.writeTextFile(join(cwd, ".value"), "resumed\n");
    sessions.push(
      await provider.resumeSession({
        sessionId: "activated",
        providerRef: "activated",
        cwd,
      }),
    );
    assert.equal(await Deno.readTextFile(join(cwd, "worker-environment")), "resumed");
    assert.equal(await Deno.readTextFile(join(cwd, "init-count")), "xx");
    assert.equal(
      (await registry.shellEnvironment("activated", cwd, signal()))?.set.PROJECT_VALUE,
      "resumed",
    );
    await Deno.writeTextFile(join(cwd, ".fail"), "");
    await assert.rejects(
      provider.createSession({
        sessionId: "failed",
        cwd,
        prompt: "test",
        mode: "default",
        mcpServers: [],
      }),
      /Nix activation exited/,
    );
    assert.equal(await Deno.readTextFile(join(cwd, "init-count")), "xx");
  } finally {
    for (const session of sessions) await session.close();
    await registry?.close();
    await f.close();
  }
});

test("VM activation is fresh without preparation, and explicit prefixes take precedence", async () => {
  const f = await fixture();
  try {
    const cwd = await f.checkout("vm");
    const environment = normalizeSessionEnvironment({}, true);
    const options = { cwd, shell: "/bin/sh" };
    assert.equal((await activateSessionEnvironment(environment, options))?.PROJECT_VALUE, "vm");
    await assert.rejects(Deno.stat(join(cwd, "prepared")), Deno.errors.NotFound);
    await prepareEnvironment(environment, options);
    await assert.rejects(Deno.stat(join(cwd, "prepared")), Deno.errors.NotFound);
    await Deno.writeTextFile(join(cwd, ".value"), "changed\n");
    assert.equal(
      (await activateSessionEnvironment(environment, options))?.PROJECT_VALUE,
      "changed",
    );
    await Deno.writeTextFile(join(cwd, ".fail"), "");
    await assert.rejects(activateSessionEnvironment(environment, options), /Nix activation failed/);
    const explicit = normalizeSessionEnvironment(
      {
        command_prefix: ["/bin/sh", "-c", 'export PROJECT_VALUE=explicit; exec "$@"', "activation"],
      },
      true,
    );
    assert.equal((await activateSessionEnvironment(explicit, options))?.PROJECT_VALUE, "explicit");
    assert.equal(
      await activateSessionEnvironment(normalizeSessionEnvironment(undefined), options),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("default.nix activates local and VM environments after flake.nix and shell.nix", async () => {
  const f = await fixture();
  try {
    const cwd = await f.checkout("fallback", "default.nix");
    assert.deepEqual(detectNixActivation(cwd, settings), { kind: "default" });
    const progress: string[] = [];
    const local = await activateLocalEnvironment(cwd, settings, signal(), (message) => {
      progress.push(message);
    });
    assert.equal(local?.set.PROJECT_VALUE, "fallback");
    assert.deepEqual(progress, ["Activating Nix default.nix…"]);
    const captured = await prepareEnvironment(normalizeSessionEnvironment(undefined, true), {
      cwd,
      shell: "/bin/sh",
    });
    assert.equal(captured?.PROJECT_VALUE, "fallback");
    assert.match(await Deno.readTextFile(join(cwd, ".activation-log")), /\.\/default\.nix --run/);
    assert.equal(await activateLocalEnvironment(cwd, false, signal()), undefined);
    await Deno.writeTextFile(join(cwd, "shell.nix"), "");
    assert.equal(detectNixActivation(cwd, settings)?.kind, "shell");
    await Deno.writeTextFile(join(cwd, "flake.nix"), "");
    assert.equal(detectNixActivation(cwd, settings)?.kind, "flake");
  } finally {
    await f.close();
  }
});

test("devenv takes precedence and activates local and VM sessions without starting services", async () => {
  const f = await fixture();
  try {
    const cwd = await f.checkout("devenv", "devenv.nix");
    await Deno.writeTextFile(join(cwd, "flake.nix"), "");
    assert.deepEqual(detectNixActivation(cwd, true), { kind: "devenv" });
    assert.equal(
      (await activateLocalEnvironment(cwd, true, signal()))?.set.PROJECT_VALUE,
      "devenv",
    );
    assert.equal(
      (
        await activateSessionEnvironment(normalizeSessionEnvironment(undefined, true), {
          cwd,
          shell: "/bin/sh",
        })
      )?.PROJECT_VALUE,
      "devenv",
    );
    const log = await Deno.readTextFile(join(cwd, ".activation-log"));
    assert.match(log, /^shell -- /);
    assert.equal((log.match(/^shell -- /gm) ?? []).length, 2);
    assert.doesNotMatch(log, /^develop |^up /m);
  } finally {
    await f.close();
  }
});
