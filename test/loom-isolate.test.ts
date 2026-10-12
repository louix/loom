/** loom-isolate's command surface, ownership and signal handling, over a fake VM backend. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutionLeases } from "@loom/isolation/execution-leases";
import { isolateCli } from "../cli/src/isolate/cli.ts";
import { environmentId } from "../cli/src/isolate/state.ts";
import { fakeDependencies } from "./fixtures/loom-isolate-backend.ts";

const fixture = fileURLToPath(new URL("./fixtures/loom-isolate-fake.ts", import.meta.url));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

interface Fixture {
  root: string;
  workspace: string;
  state: string;
  env: Record<string, string>;
  events(): Promise<Array<Record<string, unknown>>>;
}
const setup = async (): Promise<Fixture> => {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-isolate-test-" }),
  );
  const workspace = join(root, "workspace");
  await Deno.mkdir(workspace);
  const smolvm = join(root, "smolvm");
  // Fake `smolvm machine exec`: run the guest argv here, with the VM's /tmp in its state.
  await Deno.writeTextFile(
    smolvm,
    `#!/bin/sh
PATH='${Deno.env.get("PATH")}'
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  if [ "$1" = "-w" ]; then cd "$2" || exit 125; fi
  shift
done
shift 5
tmp="$(dirname "$HOME")/tmp/"
interpreter=$1
wrapper=$(printf '%s' "$3" | sed "s|/tmp/|$tmp|g")
shift 3
exec "$interpreter" -c "$wrapper" "$@"
`,
    { mode: 0o755 },
  );
  const log = join(root, "events.jsonl");
  await Deno.writeTextFile(log, "");
  return {
    root,
    workspace,
    state: join(root, "xdg-state"),
    env: {
      XDG_STATE_HOME: join(root, "xdg-state"),
      // Never the user's own environment.jsonc.
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      LOOM_ISOLATE_FAKE_LOG: log,
      LOOM_ISOLATE_FAKE_SMOLVM: smolvm,
      LOOM_ISOLATE_ARTIFACT: join(root, "artifact"),
      LOOM_ISOLATE_SMOLVM: smolvm,
      NO_COLOR: "1",
    },
    events: async () =>
      (await Deno.readTextFile(log))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
};

const cliArgs = (f: Fixture, args: string[]) => [
  "run",
  "-A",
  "--deny-net",
  fixture,
  ...args.slice(0, 1),
  "-q",
  "-w",
  f.workspace,
  ...args.slice(1),
];
const run = async (f: Fixture, args: string[], stdin?: string) => {
  const child = new Deno.Command(Deno.execPath(), {
    args: cliArgs(f, args),
    env: f.env,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const result = await child.output();
  return { code: result.code, stdout: decode(result.stdout), stderr: decode(result.stderr) };
};

/** A CLI process whose output can be awaited while it runs. */
const start = (f: Fixture, args: string[], wrap?: (argv: string[]) => string[]) => {
  const argv = [Deno.execPath(), ...cliArgs(f, args)];
  const [command, ...rest] = wrap ? wrap(argv) : argv;
  const child = spawn(command!, rest, {
    env: { ...f.env, PATH: Deno.env.get("PATH") ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : null))),
  );
  return {
    child,
    exited,
    // Not ChildProcess.kill: Deno would then report that signal as the exit cause.
    signal: (signal: Deno.Signal) => Deno.kill(child.pid!, signal),
    output: () => ({ stdout, stderr }),
    async waitFor(pattern: RegExp) {
      const deadline = Date.now() + 20_000;
      while (!pattern.test(stdout)) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${stdout}\n${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return stdout.match(pattern)!;
    },
  };
};
const alive = (pid: number) => {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
};
const waitUntil = async (condition: () => boolean | Promise<boolean>, what: string) => {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const environmentDirectory = async (f: Fixture, name = "default") =>
  join(f.state, "loom-isolate/environments", environmentId(await Deno.realPath(f.workspace), name));
/** Every VM this run launched was closed, and none is left running. */
const assertStopped = async (f: Fixture) => {
  const events = await f.events();
  const launches = events.filter((event) => event.event === "launch").length;
  assert(launches > 0, "an environment was launched");
  assert.equal(events.filter((event) => event.event === "close").length, launches);
  for (const event of events.filter((event) => event.event === "launch"))
    await assert.rejects(Deno.lstat(join(event.directory as string, "fake-running")));
};
const withFixture = (name: string, body: (f: Fixture) => Promise<void>) =>
  Deno.test(name, async () => {
    const f = await setup();
    try {
      await body(f);
    } finally {
      await Deno.remove(f.root, { recursive: true });
    }
  });

withFixture(
  "exec passes argv literally and stdio through, and propagates exit status",
  async (f) => {
    const values = [
      "two words",
      "'quoted'",
      "$(touch injected)",
      "`touch injected`",
      "*",
      "--",
      "-x",
    ];
    const result = await run(
      f,
      [
        "exec",
        "--",
        "sh",
        "-c",
        'printf "<%s>\\n" "$@"; while read line; do echo "in:$line"; done; echo oops >&2; exit 7',
        "sh",
        ...values,
      ],
      "first\nsecond\n",
    );
    assert.equal(result.code, 7, result.stderr);
    assert.equal(
      result.stdout,
      values.map((value) => `<${value}>\n`).join("") + "in:first\nin:second\n",
    );
    assert.equal(result.stderr, "oops\n");
    await assert.rejects(Deno.lstat(join(f.workspace, "injected")), Deno.errors.NotFound);
    const [launch] = await f.events();
    assert.deepEqual(launch?.extraAllowedHosts, [], "no network grants by default");
    assert.equal(launch?.workspace, await Deno.realPath(f.workspace));
    assert.equal(launch?.activity, "loom-isolate exec");
    await assertStopped(f);

    assert.equal(
      (await run(f, ["exec", "--no-stdin", "--", "sh", "-c", "kill -TERM $$"])).code,
      143,
    );
    assert.equal((await run(f, ["exec", "--", "true"])).code, 0);
    await assertStopped(f);
  },
);

withFixture("usage errors exit 2 before touching state", async (f) => {
  for (const args of [
    ["exec"],
    ["exec", "--", "-c", "true"],
    ["exec", "sh"],
    ["exec", "--tty", "--", "sh"],
    ["exec", "--tty", "--no-stdin", "--", "sh"],
    ["exec", "--allow-host", "https://example.com", "--", "true"],
    ["exec", "--allow-host", "*.example.com", "--", "true"],
    ["prepare", "--allow-host", "example.com"],
    ["inspect", "--", "true"],
    ["cleanup", "--json"],
    ["exec", "--name", "../escape", "--", "true"],
    ["bogus"],
    ["run"],
    ["config"],
    ["config", "bogus"],
    ["exec", "--profile", "x", "--", "true"],
    ["inspect", "--ignore-project"],
    ["prepare", "--", "true"],
  ]) {
    const result = await run(f, args);
    assert.equal(result.code, 2, args.join(" ") + "\n" + result.stderr);
  }
  await assert.rejects(Deno.lstat(f.state), Deno.errors.NotFound);
  const help = await run(f, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /prepare[\s\S]*exec[\s\S]*inspect[\s\S]*cleanup/);
});

withFixture("without configuration, network access is granted only by --allow-host", async (f) => {
  const result = await run(f, [
    "exec",
    "--allow-host",
    "Example.COM",
    "--allow-host",
    "api.example.org",
    "--",
    "true",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const [launch] = await f.events();
  assert.deepEqual(launch?.extraAllowedHosts, ["example.com", "api.example.org"]);
});

withFixture("Ctrl-C is forwarded to the command, which decides how to exit", async (f) => {
  const cli = start(f, [
    "exec",
    "--",
    "sh",
    "-c",
    'trap "echo got-INT; exit 9" INT; echo started; while :; do sleep 0.05; done',
  ]);
  await cli.waitFor(/started/);
  cli.signal("SIGINT");
  assert.equal(await cli.exited, 9, cli.output().stderr);
  assert.match(cli.output().stdout, /got-INT/);
  await assertStopped(f);

  // A command without a handler ends as it would at a local terminal.
  const plain = start(f, ["exec", "--", "sh", "-c", "echo started; exec sleep 30"]);
  await plain.waitFor(/started/);
  plain.signal("SIGINT");
  assert.equal(await plain.exited, 130, plain.output().stderr);
  await assertStopped(f);
});

withFixture("termination stops a command that ignores it, then the environment", async (f) => {
  const cli = start(f, [
    "exec",
    "--",
    "sh",
    "-c",
    'trap "echo ignored" TERM; echo started; while :; do sleep 0.05; done',
  ]);
  await cli.waitFor(/started/);
  cli.signal("SIGTERM");
  assert.equal(await cli.exited, 143);
  assert.match(cli.output().stdout, /ignored/);
  await assertStopped(f);
});

withFixture("interrupting startup cancels it without running the command", async (f) => {
  f.env.LOOM_ISOLATE_FAKE_BOOT_MS = "10000";
  const cli = start(f, ["exec", "--", "sh", "-c", "echo ran"]);
  await waitUntil(
    async () => (await f.events()).some((event) => event.event === "launch"),
    "launch",
  );
  cli.signal("SIGINT");
  assert.equal(await cli.exited, 130);
  assert.doesNotMatch(cli.output().stdout, /ran/);
  await assertStopped(f);
});

withFixture("losing the parent process ends the command and stops the environment", async (f) => {
  // The CLI's parent shell exits abruptly; the CLI is reparented, not signalled.
  const cli = start(
    f,
    [
      "exec",
      "--",
      "sh",
      "-c",
      'trap "echo hangup; exit 4" TERM; echo started; while :; do sleep 0.05; done',
    ],
    (argv) => ["/bin/sh", "-c", '"$@" & echo "cli=$!"; wait', "parent", ...argv],
  );
  const pid = Number((await cli.waitFor(/cli=(\d+)/))[1]);
  await cli.waitFor(/started/);
  cli.signal("SIGKILL");
  await waitUntil(() => !alive(pid), "the reparented CLI to exit");
  await waitUntil(() => /hangup/.test(cli.output().stdout), "the command to see SIGTERM");
  await assertStopped(f);
});

withFixture("one owner per environment; names and other workspaces are independent", async (f) => {
  const first = start(f, [
    "exec",
    "--",
    "sh",
    "-c",
    'trap "exit 0" INT; echo started; while :; do sleep 0.05; done',
  ]);
  await first.waitFor(/started/);
  const busy = await run(f, ["exec", "--", "true"]);
  assert.equal(busy.code, 125);
  assert.match(
    busy.stderr,
    new RegExp(`in use by another loom-isolate process \\(pid ${first.child.pid}\\)`),
  );
  const cleanup = await run(f, ["cleanup"]);
  assert.equal(cleanup.code, 125);
  assert.match(cleanup.stderr, /in use/);
  const inspect = JSON.parse((await run(f, ["inspect", "--json"])).stdout);
  assert.equal(inspect.environments[0].inUse, true);
  assert.equal(inspect.environments[0].ownerPid, first.child.pid);
  assert.equal((await run(f, ["exec", "--name", "second", "--", "true"])).code, 0);
  first.signal("SIGINT");
  assert.equal(await first.exited, 0);
  assert.equal((await run(f, ["exec", "--", "true"])).code, 0);
  await assertStopped(f);
});

withFixture("Loom-owned state is never mounted, adopted or removed", async (f) => {
  const loom = join(f.state, "loom/session-vms/0123/session");
  await Deno.mkdir(join(loom, "checkout"), { recursive: true });
  await Deno.writeTextFile(join(loom, "active.json"), "{}");
  for (const workspace of [join(loom, "checkout"), f.root]) {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", fixture, "exec", "-q", "-w", workspace, "--", "true"],
      env: f.env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(result.code, 125, decode(result.stderr));
    assert.match(decode(result.stderr), /Refusing to mount .*overlaps (Loom's|loom-isolate's)/);
  }
  // A directory at an environment's path that this tool did not create is left alone.
  const directory = await environmentDirectory(f);
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(join(directory, "active.json"), "{}");
  for (const args of [["exec", "--", "true"], ["prepare"], ["cleanup"]]) {
    const result = await run(f, args);
    assert.equal(result.code, 125, args.join(" "));
    assert.match(result.stderr, /Refusing to adopt/);
  }
  assert.equal(await Deno.readTextFile(join(directory, "active.json")), "{}");
  await Deno.remove(join(f.state, "loom-isolate"), { recursive: true });
  // Nor is the namespace reached through a link into Loom's own state.
  await Deno.symlink(join(f.state, "loom"), join(f.state, "loom-isolate"));
  for (const args of [
    ["exec", "--", "true"],
    ["cleanup", "--all"],
  ]) {
    const result = await run(f, args);
    assert.notEqual(result.code, 0, args.join(" "));
  }
  assert.equal(await Deno.readTextFile(join(loom, "active.json")), "{}");
  assert.deepEqual(await f.events(), [], "no environment was launched");
});

withFixture(
  "prepare records the runtime; inspect reports; cleanup removes only its state",
  async (f) => {
    const prepared = await run(f, ["prepare", "--artifact", join(f.root, "prepared-runtime")]);
    assert.equal(prepared.code, 0, prepared.stderr);
    assert.match(prepared.stdout, /^Prepared w[0-9a-f]{24}-default /);
    const launches = (await f.events()).filter((event) => event.event === "launch");
    assert.equal(launches[0]?.activity, "loom-isolate prepare");
    await assertStopped(f);
    const report = JSON.parse((await run(f, ["inspect", "--json"])).stdout);
    assert.equal(report.stateRoot, join(f.state, "loom-isolate"));
    const [environment] = report.environments;
    assert.equal(environment.exists, true);
    assert.equal(environment.inUse, false);
    assert.equal(environment.vmActive, false);
    assert.equal(environment.record.workspace, await Deno.realPath(f.workspace));
    assert.equal(environment.record.runtime.artifact, join(f.root, "prepared-runtime"));
    assert.notEqual(environment.record.preparedAt, null);
    // The packaged default still wins over the last prepare, and flags over both.
    assert.equal(environment.runtime.artifact, join(f.root, "artifact"));
    assert.match((await run(f, ["inspect"])).stdout, /owner +free/);

    await run(f, ["exec", "--name", "other", "--", "true"]);
    const all = JSON.parse((await run(f, ["inspect", "--all", "--json"])).stdout);
    assert.equal(all.environments.length, 2);
    const removed = await run(f, ["cleanup"]);
    assert.equal(removed.code, 0, removed.stderr);
    assert.match(removed.stdout, /^removed w[0-9a-f]{24}-default\n$/);
    await assert.rejects(Deno.lstat(await environmentDirectory(f)), Deno.errors.NotFound);
    assert.equal((await run(f, ["cleanup"])).stdout, "nothing to clean up\n");
    await Deno.remove(f.workspace, { recursive: true });
    const rest = await run(f, ["cleanup", "--all"]);
    assert.equal(rest.code, 0, rest.stderr);
    assert.match(rest.stdout, /removed w[0-9a-f]{24}-other/);
    await assert.rejects(Deno.lstat(join(f.state, "loom-isolate")), Deno.errors.NotFound);
  },
);

Deno.test("an exec holds one execution lease and releases it with the environment", async () => {
  const f = await setup();
  const saved = Object.fromEntries(Object.keys(f.env).map((key) => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(f.env)) Deno.env.set(key, value);
  try {
    const leases = new ExecutionLeases();
    const id = environmentId(await Deno.realPath(f.workspace), "default");
    const code = await isolateCli(
      ["exec", "-q", "--no-stdin", "-w", f.workspace, "--", "sh", "-c", "exit 3"],
      { ...fakeDependencies, leases },
    );
    assert.equal(code, 3);
    assert(leases.lastActivity(id) > 0, "the command held a lease");
    assert.equal(leases.has(id), false, "the lease was released");
    await assertStopped(f);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    await Deno.remove(f.root, { recursive: true });
  }
});

/** Write the fixture's environment.jsonc and, optionally, the workspace's loom.json. */
const writeConfig = async (f: Fixture, user: unknown, project?: unknown) => {
  await Deno.mkdir(join(f.root, "xdg-config/loom"), { recursive: true });
  await Deno.writeTextFile(join(f.root, "xdg-config/loom/environment.jsonc"), JSON.stringify(user));
  if (project !== undefined)
    await Deno.writeTextFile(join(f.workspace, "loom.json"), JSON.stringify(project));
};
const commands = async (f: Fixture) =>
  (await f.events())
    .filter((event) => event.event === "command")
    .map((event) => [event.command, (event.env as Record<string, string>).LOOM_HOOK_EVENT]);

withFixture("project intent and user grants resolve into launch options", async (f) => {
  // Relative to the workspace, where guest hooks and commands run.
  const marker = "started";
  await writeConfig(
    f,
    {
      version: 1,
      environment: { resources: { cpus: 2 }, prepare: [{ run: "echo never" }] },
      access: { network: { allowedHosts: ["user.example"] } },
      repos: [
        {
          path: f.workspace,
          grants: { setup: true, network: { allowedHosts: ["project.example"] } },
        },
      ],
    },
    {
      version: 1,
      environment: { start: [{ name: "mark", run: `echo started >> '${marker}'` }] },
      access: { network: { allowedHosts: ["project.example"] } },
    },
  );
  const result = await run(f, [
    "exec",
    "--allow-host",
    "flag.example",
    "--",
    "sh",
    "-c",
    `cat '${marker}'`,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "started\n", "start hooks run before the command");
  const [launch] = await f.events();
  assert.deepEqual(launch?.extraAllowedHosts, ["user.example", "project.example", "flag.example"]);
  assert.deepEqual(launch?.environment, {
    autoNix: false,
    commandPrefix: [],
    timeoutMs: 900_000,
    cpus: 2,
    memoryMiB: 2048,
  });
  // exec runs start hooks only; preparation is the prepare command's.
  assert.deepEqual(await commands(f), [[`echo started >> '${marker}'`, "workspace_start"]]);
  await assertStopped(f);
});

withFixture("a project cannot grant itself setup or network", async (f) => {
  await writeConfig(f, { version: 1 }, { version: 1, environment: { start: [{ run: "true" }] } });
  const setup = await run(f, ["exec", "--", "true"]);
  assert.equal(setup.code, 125);
  assert.match(setup.stderr, /environment\.start, which needs repos\[\]\.grants\.setup/);
  await Deno.writeTextFile(
    join(f.workspace, "loom.json"),
    JSON.stringify({ version: 1, access: { network: { allowedHosts: ["exfil.example"] } } }),
  );
  const network = await run(f, ["exec", "--", "true"]);
  assert.equal(network.code, 125);
  assert.match(network.stderr, /not granted: exfil\.example/);
  await Deno.writeTextFile(
    join(f.workspace, "loom.json"),
    JSON.stringify({ version: 1, repos: [{ path: f.workspace, grants: { setup: true } }] }),
  );
  assert.match((await run(f, ["exec", "--", "true"])).stderr, /Unrecognized key: "repos"/);
  // Nothing was created or launched for a rejected configuration.
  await assert.rejects(Deno.lstat(f.state), Deno.errors.NotFound);
  assert.deepEqual(await f.events(), []);
  // Ignoring the project only removes requests.
  const ignored = await run(f, ["exec", "--ignore-project", "--", "true"]);
  assert.equal(ignored.code, 0, ignored.stderr);
  assert.deepEqual((await f.events())[0]?.extraAllowedHosts, []);
});

withFixture("Loom's config.jsonc is never read as environment config", async (f) => {
  const old = join(f.root, "config.jsonc");
  await Deno.writeTextFile(old, '{"session":{"isolation":{"enabled":true}}}');
  // Beside the default path it is ignored; named explicitly it is rejected.
  await Deno.mkdir(join(f.root, "xdg-config/loom"), { recursive: true });
  await Deno.copyFile(old, join(f.root, "xdg-config/loom/config.jsonc"));
  assert.equal((await run(f, ["exec", "--", "true"])).code, 0);
  const result = await run(f, ["exec", "--user-config", old, "--", "true"]);
  assert.equal(result.code, 125);
  assert.match(result.stderr, /expected version: 1.*loom config convert/);
});

withFixture("config inspect shows the resolution and its sources", async (f) => {
  await writeConfig(
    f,
    {
      version: 1,
      environment: { timeoutSeconds: 60 },
      access: { network: { presets: ["python"] } },
      lifecycle: { execution: "none" },
      repos: [
        { path: f.workspace, grants: { setup: true }, environment: { resources: { cpus: 3 } } },
      ],
    },
    {
      version: 1,
      environment: { nix: { auto: true }, start: [{ run: "make dev" }] },
      skills: ["skills/project"],
    },
  );
  const text = await run(f, ["config", "inspect"]);
  assert.equal(text.code, 0, text.stderr);
  for (const line of [
    `user config     ${join(f.root, "xdg-config/loom/environment.jsonc")}`,
    `project config  ${join(f.workspace, "loom.json")}`,
    `repository      ${f.workspace}`,
    "lifecycle       execution=none (not used by loom-isolate)",
    "  nix.auto        true (project)",
    "  timeout         60s (user)",
    "  cpus            3 (repository)",
    "  memory          2048 MiB (default)",
    "  pypi.org (user)",
    "start hooks (project)",
    "  start 1: make dev  [900s]",
    "prepare hooks  none",
    "unsupported (ignored)",
    "  skills: skills/project",
  ])
    assert(text.stdout.includes(line + "\n"), line + "\n---\n" + text.stdout);
  const json = JSON.parse((await run(f, ["config", "inspect", "--json"])).stdout);
  assert.equal(json.sources.cpus, "repository");
  assert.equal(json.sources.projectFile.present, true);
  assert.deepEqual(json.start, [{ name: "start 1", run: "make dev", timeoutMs: 900_000 }]);
  // Inspection touches no state and launches nothing.
  await assert.rejects(Deno.lstat(f.state), Deno.errors.NotFound);
  assert.deepEqual(await f.events(), []);
});

withFixture("run launches a profile's entrypoint with its runtime and environment", async (f) => {
  await writeConfig(f, {
    version: 1,
    profiles: {
      greet: {
        entrypoint: ["sh", "-c", 'echo "profile $0 $1"', "zero"],
        artifact: "/nix/store/profile-runtime",
        environment: { resources: { memoryMiB: 4096 } },
      },
    },
  });
  const result = await run(f, ["run", "greet", "--", "one"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "profile zero one\n");
  const [launch] = await f.events();
  assert.equal(launch?.artifact, "/nix/store/profile-runtime", "configuration beats the package");
  assert.equal((launch!.environment as { memoryMiB: number }).memoryMiB, 4096);
  assert.equal(launch?.activity, "loom-isolate run greet");
  const flagged = await run(f, ["run", "--artifact", "/flag/runtime", "greet"]);
  assert.equal(flagged.code, 0, flagged.stderr);
  assert.equal((await f.events()).at(-2)?.artifact, "/flag/runtime", "flags beat configuration");
  const missing = await run(f, ["run", "absent"]);
  assert.equal(missing.code, 125);
  assert.match(missing.stderr, /Unknown launch profile: absent/);
});

withFixture("prepare runs prepare hooks, then start hooks", async (f) => {
  await writeConfig(f, {
    version: 1,
    environment: { prepare: [{ run: "echo prepared" }], start: [{ run: "echo started" }] },
  });
  const result = await run(f, ["prepare"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await commands(f), [
    ["echo prepared", "workspace_prepare"],
    ["echo started", "workspace_start"],
  ]);
  await writeConfig(f, { version: 1, environment: { prepare: [{ run: "exit 4" }] } });
  const failed = await run(f, ["prepare"]);
  assert.equal(failed.code, 125);
  assert.match(failed.stderr, /workspace_prepare hook prepare 1 exited 4/);
  await assertStopped(f);
});
