import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyIsolateCli, isolateCliGraph } from "../packaging/copy-isolate-cli.ts";

const source = fileURLToPath(new URL("../", import.meta.url));

Deno.test("loom-isolate's graph excludes Loom's application and conversation code", async () => {
  const { files } = await isolateCliGraph(source);
  for (const path of files) {
    assert.match(
      path,
      /^(cli\/src\/(loom-isolate\.ts|isolate\/)|core\/src\/|runtime\/src\/|isolation\/src\/)/,
    );
    assert.doesNotMatch(path, /^runtime\/src\/(worker|mcp)\//, path);
    assert.doesNotMatch(
      path,
      /^core\/src\/(types|events|wire|connector|worker|transcript|session-state)\.ts$/,
      path,
    );
  }
  assert(files.includes("isolation/src/coordinator.ts"), "built on the isolation library");
  assert(files.includes("runtime/src/session-vm/supervisor.ts"), "includes the spawned supervisor");
});

Deno.test("loom-isolate installs, checks and runs as a standalone package", async () => {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-isolate-package-" }),
  );
  const pkg = join(root, "package");
  const workspace = join(root, "workspace");
  await Deno.mkdir(workspace);
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const result = await new Deno.Command(Deno.execPath(), {
      args,
      cwd: pkg,
      env: { XDG_STATE_HOME: join(root, "state"), NO_COLOR: "1", ...env },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(60_000),
    }).output();
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  };
  const checked = async (args: string[]) => {
    const result = await run(args);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  const flags = [
    "run",
    "-A",
    "--deny-net",
    "--frozen",
    "--cached-only",
    "--node-modules-dir=manual",
  ];
  try {
    const files = await copyIsolateCli(source, pkg);
    await checked(["install", "--frozen", "--cached-only"]);
    await checked(["check", "--frozen", "--cached-only", ...files]);
    for (const absent of [
      "frontend",
      "client",
      "backend",
      "connectors",
      "aisdk",
      "harness",
      "runtime/src/worker",
      "runtime/src/mcp",
      "cli/src/loom.ts",
      "cli/src/loomd.ts",
      "core/src/wire.ts",
      "core/src/types.ts",
    ])
      await assert.rejects(Deno.stat(join(pkg, absent)), Deno.errors.NotFound, absent);
    assert.deepEqual(
      Object.keys(JSON.parse(await Deno.readTextFile(join(pkg, "deno.json"))).imports).filter(
        (name) => !name.startsWith("@loom/"),
      ),
      ["zod"],
    );

    assert.match(
      await checked([...flags, "cli/src/loom-isolate.ts", "--help"]),
      /exec \[options\] --/,
    );
    const missing = await run([
      ...flags,
      "cli/src/loom-isolate.ts",
      "exec",
      "-w",
      workspace,
      "--",
      "true",
    ]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /No VM runtime selected/);

    // Drive the packaged command surface end to end over the fake VM backend.
    for (const name of ["loom-isolate-backend.ts", "loom-isolate-fake.ts"]) {
      await Deno.mkdir(join(pkg, "test/fixtures"), { recursive: true });
      await Deno.copyFile(join(source, "test/fixtures", name), join(pkg, "test/fixtures", name));
    }
    const smolvm = join(root, "smolvm");
    await Deno.writeTextFile(
      smolvm,
      `#!/bin/sh\nPATH='${Deno.env.get("PATH")}'\nwhile [ "$1" != "--" ]; do shift; done\n# Skip both guest wrappers; run the literal argv.\nshift 9\nexec "$@"\n`,
      { mode: 0o755 },
    );
    const log = join(root, "events.jsonl");
    const fake = await run(
      [
        ...flags,
        "test/fixtures/loom-isolate-fake.ts",
        "exec",
        "-q",
        "-w",
        workspace,
        "--",
        "sh",
        "-c",
        "echo packaged; exit 3",
      ],
      {
        PATH: Deno.env.get("PATH") ?? "",
        LOOM_ISOLATE_FAKE_LOG: log,
        LOOM_ISOLATE_FAKE_SMOLVM: smolvm,
        LOOM_ISOLATE_ARTIFACT: join(root, "artifact"),
        LOOM_ISOLATE_SMOLVM: smolvm,
      },
    );
    assert.equal(fake.code, 3, fake.stderr);
    assert.equal(fake.stdout, "packaged\n");
    assert.deepEqual(
      (await Deno.readTextFile(log))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event),
      ["launch", "close"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
