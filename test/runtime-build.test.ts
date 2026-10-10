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
  removeBuiltRuntimes,
  type BuildDependencies,
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
    assert.equal(
      await buildDependencies.run(builder, output, log, (line) => seen.push(line)),
      true,
    );
    assert.deepEqual(seen, [`start ${output}`, "secret=none tmp=/tmp"]);
    assert.equal(await Deno.readTextFile(log), `start ${output}\nsecret=none tmp=/tmp\n`);
    await Deno.writeTextFile(builder, "#!/bin/sh\necho failing\nexit 3\n");
    assert.equal(await buildDependencies.run(builder, output, log, () => {}), false);
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
