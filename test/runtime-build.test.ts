import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  builtRuntimePath,
  bundledRuntime,
  bundledRuntimeBuild,
  resolveRuntime,
  runtimeBuildFor,
  type RuntimeBuild,
} from "../runtime/src/packaged/artifact.ts";
import {
  buildDependencies,
  classifyBuildFailure,
  ensureBuiltRuntime,
  ensureRuntimeArtifact,
  builtRuntimeRetentionMs,
  removeBuiltRuntimes,
  succeeded,
  type BuildDependencies,
  type BuilderProcess,
} from "../runtime/src/packaged/build.ts";

const build = (identity = "a".repeat(32)): RuntimeBuild => ({
  version: 1,
  identity,
  builder: `/nix/store/${"b".repeat(32)}-loom-build-runtime/bin/loom-build-runtime`,
});

/** A builder writing a fake artifact, and a "store" that is a fixture directory. */
const fixture = async () => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "loom-runtime-build-test-" }));
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  const store = join(root, "store");
  await Deno.mkdir(temporary, { recursive: true });
  await Deno.mkdir(store, { recursive: true });
  const calls = { run: 0, register: 0 };
  let release: () => void = () => {};
  const gate = { wait: Promise.resolve() };
  const dependencies: BuildDependencies = {
    async run(_builder, output, _log, onLine) {
      calls.run++;
      onLine("copying path '/nix/store/x-glibc' from 'https://cache.nixos.org'...");
      await gate.wait;
      await Deno.mkdir(output, { recursive: true });
      await Deno.writeTextFile(join(output, "manifest.json"), "{}");
      return true;
    },
    async register(directory, link) {
      calls.register++;
      const path = join(store, `${calls.register}-lvm`);
      await Deno.rename(directory, path);
      await Deno.symlink(path, link);
      return path;
    },
    inspect: async () => {},
    freeBytes: async () => undefined,
    alive: async () => false,
  };
  return {
    root,
    home,
    temporary,
    calls,
    dependencies,
    hold: () => (gate.wait = new Promise<void>((resolve) => (release = resolve))),
    release: () => release(),
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
};

test("an on-demand runtime builds once, reports progress and is reused", async () => {
  const f = await fixture();
  try {
    const progress: string[] = [];
    const options = {
      home: f.home,
      temporary: f.temporary,
      dependencies: f.dependencies,
      progressIntervalMs: 0,
      onProgress: (message: string) => progress.push(message),
    };
    const artifact = await ensureBuiltRuntime(build(), options);
    assert.equal(artifact, join(f.root, "store/1-lvm"));
    assert.equal(await Deno.realPath(builtRuntimePath(build(), f.home)), artifact);
    assert.match(progress[0]!, /Building the VM runtime.*15–60 minutes/);
    assert.ok(progress.some((m) => /elapsed\): copying path/.test(m)));
    assert.match(progress.at(-1)!, /VM runtime ready/);
    // The successful build's log and scratch output are gone.
    const scratch = (await Array.fromAsync(Deno.readDir(f.temporary))).filter((e) =>
      e.name.startsWith("loom-runtime-build-"),
    );
    assert.deepEqual(scratch, []);
    await assert.rejects(Deno.lstat(builtRuntimePath(build(), f.home) + ".log"));

    progress.length = 0;
    assert.equal(await ensureBuiltRuntime(build(), options), artifact);
    assert.deepEqual(f.calls, { run: 1, register: 1 });
    assert.deepEqual(progress, []);
  } finally {
    await f.cleanup();
  }
});

test("concurrent starts share one build, and a cancelled start leaves it running", async () => {
  const f = await fixture();
  try {
    f.hold();
    const settings = { home: f.home, temporary: f.temporary, dependencies: f.dependencies };
    const cancel = new AbortController();
    const seen: string[] = [];
    const first = ensureRuntimeArtifact(
      "unused",
      { signal: cancel.signal, onProgress: (m) => seen.push(m) },
      build(),
      settings,
    );
    const second = ensureRuntimeArtifact("unused", {}, build(), settings);
    await new Promise((resolve) => setTimeout(resolve, 20));
    cancel.abort(new Error("stopped"));
    await assert.rejects(first, /stopped/);
    f.release();
    await second;
    assert.deepEqual(f.calls, { run: 1, register: 1 });
    assert.match(seen[0]!, /Building the VM runtime/);
  } finally {
    await f.cleanup();
  }
});

test("build failures are actionable and keep the log", async () => {
  const f = await fixture();
  try {
    const failing = (line: string): BuildDependencies => ({
      ...f.dependencies,
      async run(_builder, _output, log, onLine) {
        await Deno.writeTextFile(log, line + "\n", { append: true });
        onLine(line);
        return false;
      },
    });
    const options = { home: f.home, temporary: f.temporary };
    await assert.rejects(
      ensureBuiltRuntime(build(), {
        ...options,
        dependencies: failing(
          "error: unable to download 'https://cache.nixos.org/nar/x': Couldn't resolve host name (6)",
        ),
      }),
      (error: Error) =>
        /needs network access/.test(error.message) &&
        error.message.includes(builtRuntimePath(build(), f.home) + ".log"),
    );
    assert.match(
      await Deno.readTextFile(builtRuntimePath(build(), f.home) + ".log"),
      /unable to download/,
    );
    await assert.rejects(
      ensureBuiltRuntime(build(), {
        ...options,
        dependencies: failing("tar: write error: No space left on device"),
      }),
      /ran out of disk space/,
    );
    await assert.rejects(
      ensureBuiltRuntime(build(), { ...options, dependencies: failing("mkfs.erofs: bad option") }),
      /Building the VM runtime failed[^]*mkfs\.erofs: bad option/,
    );
    // Too little space fails before a VM starts.
    await assert.rejects(
      ensureBuiltRuntime(build(), {
        ...options,
        dependencies: { ...f.dependencies, freeBytes: async () => 2 * 1024 ** 3 },
      }),
      /needs about 20 GB free in .*2\.0 GB is available/,
    );
    assert.equal(f.calls.run, 0);
    await assert.rejects(Deno.lstat(builtRuntimePath(build(), f.home)));
  } finally {
    await f.cleanup();
  }
});

test("the builder writes to its log, not to Loom, and sees no inherited environment", async () => {
  const f = await fixture();
  const secret = "LOOM_BUILD_TEST_SECRET";
  Deno.env.set(secret, "leaked");
  try {
    const builder = join(f.root, "builder");
    // Builtins only: the builder gets no PATH from Loom.
    await Deno.writeTextFile(
      builder,
      `#!/bin/sh\necho "start $1"\necho "secret=\${${secret}:-none} tmp=$TMPDIR" >&2\n: > "$1"\nexit "\${FAIL:-0}"\n`,
      { mode: 0o755 },
    );
    const log = join(f.root, "build.log");
    await Deno.writeTextFile(log, "");
    const seen: string[] = [];
    const output = join(f.root, "out");
    let recorded: BuilderProcess | undefined;
    assert.equal(
      await buildDependencies.run(
        builder,
        output,
        log,
        (line) => seen.push(line),
        undefined,
        async (process) => {
          recorded = process;
        },
      ),
      true,
    );
    assert.deepEqual(seen, [`start ${output}`, "secret=none tmp=/tmp"]);
    assert.equal(await Deno.readTextFile(log), `start ${output}\nsecret=none tmp=/tmp\n`);
    // Success is marked for a Loom that outlives this one; the exited builder is not alive.
    await Deno.lstat(succeeded(output));
    assert.equal(await buildDependencies.alive(recorded!), false);
    await Deno.remove(succeeded(output));
    await Deno.writeTextFile(builder, "#!/bin/sh\necho failing\nexit 3\n");
    assert.equal(await buildDependencies.run(builder, output, log, () => {}), false);
    await assert.rejects(Deno.lstat(succeeded(output)));
  } finally {
    Deno.env.delete(secret);
    await f.cleanup();
  }
});

test("build failure classification", () => {
  assert.equal(
    classifyBuildFailure("curl: (6) Could not resolve host: cache.nixos.org"),
    "network",
  );
  assert.equal(classifyBuildFailure("error: writing to file: No space left on device"), "space");
  assert.equal(
    classifyBuildFailure("builder for '/nix/store/x.drv' failed with exit code 1"),
    "builder",
  );
});

test("superseded built runtimes go unless protected or newest", async () => {
  const f = await fixture();
  try {
    const directory = join(f.home, "built");
    await Deno.mkdir(directory, { recursive: true });
    const ids = ["1", "2", "3"].map((c) => c.repeat(32));
    for (const id of ids) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await Deno.mkdir(join(f.root, "store", id), { recursive: true });
      await Deno.symlink(join(f.root, "store", id), join(directory, id));
      await Deno.writeTextFile(join(directory, `${id}.log`), "log");
    }
    const protectedArtifact = join(f.root, "store", ids[0]!);
    assert.equal(
      await removeBuiltRuntimes(f.home, (_link, artifact) => artifact === protectedArtifact),
      1,
    );
    // The protected one and the newest stay, with their logs.
    const left = (await Array.fromAsync(Deno.readDir(directory))).map((e) => e.name).sort();
    assert.deepEqual(left, [ids[0]!, `${ids[0]}.log`, ids[2]!, `${ids[2]}.log`].sort());
  } finally {
    await f.cleanup();
  }
});

test("runtimes another Loom used lately stay; prune and age remove them", async () => {
  const f = await fixture();
  try {
    const directory = join(f.home, "built");
    await Deno.mkdir(directory, { recursive: true });
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const [recent, stale, newest] = ["1", "2", "3"].map((c) => c.repeat(32));
    for (const [id, usedAgo] of [
      [recent!, day],
      [stale!, 30 * day],
      [newest!, 0],
    ] as const) {
      await Deno.mkdir(join(f.root, "store", id), { recursive: true });
      await Deno.symlink(join(f.root, "store", id), join(directory, id));
      await Deno.writeTextFile(join(directory, `${id}.used`), "");
      const at = new Date(now - usedAgo);
      await Deno.utime(join(directory, `${id}.used`), at, at);
    }
    const left = async () =>
      (await Array.fromAsync(Deno.readDir(directory))).map((e) => e.name).sort();
    // After a build: only what no Loom used within the retention window goes.
    assert.equal(
      await removeBuiltRuntimes(f.home, () => false, false, builtRuntimeRetentionMs, now),
      1,
    );
    assert.deepEqual(await left(), [recent!, `${recent}.used`, newest!, `${newest}.used`].sort());
    // `loom runtime prune` keeps only the most recently used.
    assert.equal(await removeBuiltRuntimes(f.home, () => false), 1);
    assert.deepEqual(await left(), [newest!, `${newest}.used`]);
  } finally {
    await f.cleanup();
  }
});

test("building a second identity keeps the first while it is in use", async () => {
  const f = await fixture();
  try {
    const options = { home: f.home, temporary: f.temporary, dependencies: f.dependencies };
    const [first, second, third] = ["a", "c", "e"].map((c) => build(c.repeat(32)));
    const firstArtifact = await ensureBuiltRuntime(first!, options);
    // Another installed Loom builds its own runtime; the first stays for its user.
    await ensureBuiltRuntime(second!, options);
    assert.equal(await ensureBuiltRuntime(first!, options), firstArtifact);
    assert.equal(f.calls.run, 2);
    // Once the first has gone unused for long enough, the next build removes it.
    const long = new Date(Date.now() - builtRuntimeRetentionMs - 60_000);
    await Deno.utime(builtRuntimePath(first!, f.home) + ".used", long, long);
    await ensureBuiltRuntime(third!, options);
    await assert.rejects(Deno.lstat(builtRuntimePath(first!, f.home)));
    await Deno.lstat(builtRuntimePath(second!, f.home));
  } finally {
    await f.cleanup();
  }
});

test("builds for different runtime homes leave each other's scratch output alone", async () => {
  const f = await fixture();
  try {
    f.hold();
    const scratch = async () =>
      (await Array.fromAsync(Deno.readDir(f.temporary)))
        .map((e) => e.name)
        .filter((name) => name.startsWith("loom-runtime-build-"));
    const first = ensureBuiltRuntime(build(), {
      home: f.home,
      temporary: f.temporary,
      dependencies: f.dependencies,
    });
    let held: string[] = [];
    for (let i = 0; i < 100 && !held.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      held = await scratch();
    }
    assert.equal(held.length, 1);
    // Another XDG_DATA_HOME has its own lock, so its build runs meanwhile.
    await ensureBuiltRuntime(build(), {
      home: join(f.root, "other-home"),
      temporary: f.temporary,
      dependencies: {
        ...f.dependencies,
        run: async (_builder, output) => {
          await Deno.mkdir(output);
          return true;
        },
      },
    });
    assert.deepEqual(await scratch(), held);
    f.release();
    await first;
    assert.deepEqual(await scratch(), []);
  } finally {
    await f.cleanup();
  }
});

/** A builder that runs until `go` (succeeds) or `fail` (fails) appears beside it. */
const blockingBuilder = async (root: string) => {
  const sleep = new TextDecoder()
    .decode(
      (await new Deno.Command("/bin/sh", { args: ["-c", "command -v sleep"] }).output()).stdout,
    )
    .trim();
  const builder = join(root, "builder");
  await Deno.writeTextFile(
    builder,
    [
      "#!/bin/sh",
      `echo start >>"${root}/starts"`,
      'echo "building $1"',
      `while [ ! -e "${root}/go" ] && [ ! -e "${root}/fail" ]; do ${sleep} 0.05; done`,
      `[ -e "${root}/fail" ] && exit 1`,
      'echo built >"$1"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return builder;
};
const starts = (root: string) =>
  Deno.readTextFile(join(root, "starts")).then(
    (text) => text.trim().split("\n").length,
    () => 0,
  );
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition did not settle");
};
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Start a build in another Loom process, and kill that with SIGKILL once its builder runs. */
const crashMidBuild = async (f: Fixture, builder: string) => {
  const script = join(f.root, "loom.ts");
  const module = new URL("../runtime/src/packaged/build.ts", import.meta.url).href;
  await Deno.writeTextFile(
    script,
    `import { buildDependencies, ensureBuiltRuntime } from ${JSON.stringify(module)};
const [home, temporary, builder] = Deno.args;
await ensureBuiltRuntime(
  { version: 1, identity: ${JSON.stringify(build().identity)}, builder },
  { home, temporary, dependencies: { ...buildDependencies, freeBytes: async () => undefined } },
);
`,
  );
  const loom = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--no-config", "--no-lock", script, f.home, f.temporary, builder],
    cwd: f.root,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  const record = join(f.home, "built/.build");
  await until(
    async () =>
      (await starts(f.root)) === 1 &&
      (await Deno.lstat(record).then(
        () => true,
        () => false,
      )),
  );
  loom.kill("SIGKILL");
  await loom.status;
  return JSON.parse(await Deno.readTextFile(record)) as BuilderProcess & { scratch: string };
};
/** Real builder processes; a fixture store stands in for Nix. */
const realBuilder = (f: Fixture): BuildDependencies => ({
  ...buildDependencies,
  register: f.dependencies.register,
  inspect: async () => {},
  freeBytes: async () => undefined,
});

test("a build whose Loom died is waited for and finished, not started again", async () => {
  const f = await fixture();
  try {
    const builder = await blockingBuilder(f.root);
    const orphan = await crashMidBuild(f, builder);
    // The builder outlived its Loom.
    assert.equal(await buildDependencies.alive(orphan), true);
    const progress: string[] = [];
    const next = ensureBuiltRuntime(
      { ...build(), builder },
      {
        home: f.home,
        temporary: f.temporary,
        dependencies: realBuilder(f),
        progressIntervalMs: 0,
        onProgress: (message) => progress.push(message),
      },
    );
    await until(async () => progress.some((m) => /building \//.test(m)));
    assert.match(progress[0]!, /Waiting for the VM runtime build an earlier Loom process started/);
    // Its scratch output is still the running build's.
    await Deno.lstat(orphan.scratch);
    await Deno.writeTextFile(join(f.root, "go"), "");
    const artifact = await next;
    assert.equal(await Deno.readTextFile(artifact), "built\n");
    assert.equal(await Deno.realPath(builtRuntimePath(build(), f.home)), artifact);
    assert.equal(await starts(f.root), 1);
    await assert.rejects(Deno.lstat(orphan.scratch));
    await assert.rejects(Deno.lstat(join(f.home, "built/.build")));
  } finally {
    await Deno.writeTextFile(join(f.root, "go"), "").catch(() => {});
    await f.cleanup();
  }
});

test("a dead builder's leftovers go and the build starts again", async () => {
  const f = await fixture();
  try {
    const builder = await blockingBuilder(f.root);
    const orphan = await crashMidBuild(f, builder);
    await Deno.writeTextFile(join(f.root, "fail"), "");
    await until(async () => !(await buildDependencies.alive(orphan)));
    await Deno.remove(join(f.root, "fail"));
    await Deno.writeTextFile(join(f.root, "go"), "");
    const artifact = await ensureBuiltRuntime(
      { ...build(), builder },
      { home: f.home, temporary: f.temporary, dependencies: realBuilder(f) },
    );
    assert.equal(await Deno.readTextFile(artifact), "built\n");
    assert.equal(await starts(f.root), 2);
    await assert.rejects(Deno.lstat(orphan.scratch));
  } finally {
    await Deno.writeTextFile(join(f.root, "go"), "").catch(() => {});
    await f.cleanup();
  }
});

test("a package without a pinned runtime names where it builds one", async () => {
  const f = await fixture();
  const before = Deno.env.get("LOOM_BUNDLED_RUNTIMES");
  try {
    const file = join(f.root, "bundle.json");
    const entry = (source: string) => ({
      version: 1,
      source,
      smolvm: `/nix/store/${"c".repeat(32)}-smolvm/bin/smolvm`,
      preparedAt: "on-demand",
      build: build(),
    });
    await Deno.writeTextFile(
      file,
      JSON.stringify({ claude: entry("claude"), codex: entry("codex") }),
    );
    Deno.env.set("LOOM_BUNDLED_RUNTIMES", file);
    const lock = bundledRuntime("claude")!;
    assert.equal(lock.artifact, builtRuntimePath(build()));
    assert.deepEqual(bundledRuntimeBuild(), build());
    assert.deepEqual(runtimeBuildFor(lock.artifact), build());
    assert.equal(runtimeBuildFor("/nix/store/" + "d".repeat(32) + "-other"), undefined);
    await assert.rejects(
      resolveRuntime("claude", f.home),
      /not been built for this Loom version yet.*Run loom runtime update/,
    );
    await Deno.writeTextFile(
      file,
      JSON.stringify({ claude: { ...entry("claude"), build: { ...build(), identity: "../x" } } }),
    );
    assert.throws(() => bundledRuntime("claude"), /Invalid runtime build/);
  } finally {
    if (before === undefined) Deno.env.delete("LOOM_BUNDLED_RUNTIMES");
    else Deno.env.set("LOOM_BUNDLED_RUNTIMES", before);
    await f.cleanup();
  }
});
