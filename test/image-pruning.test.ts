import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  pruneRepoBases,
  publishRepoBase,
  currentRepoBase,
} from "../runtime/src/session-vm/repo-base.ts";
import { lockSessionState } from "../runtime/src/session-vm/persistence.ts";
import { pruneRuntimeCache } from "../runtime/src/packaged/prune.ts";
import { vmMaintenanceLock } from "../runtime/src/packaged/maintenance.ts";
import { loadAllRepoConfigs } from "../backend/daemon/src/config/config.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const exists = async (path: string) => {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};
const baseFixture = async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const home = join(root, "bases");
  const binding = { artifact: "/new-runtime", smolvm: "/backend", writableNix: true };
  const base = async (name: string, artifact: string) => {
    const path = join(home, name);
    await Deno.mkdir(join(path, "disks"), { recursive: true });
    for (const stem of ["storage", "overlay"]) {
      const file = await Deno.open(join(path, "disks", stem + ".raw"), {
        create: true,
        write: true,
      });
      await file.truncate(1024 * 1024);
      file.close();
    }
    await Deno.writeTextFile(
      join(path, "disks/identity.json"),
      JSON.stringify({
        version: 1,
        ...binding,
        artifact,
        host: `${Deno.build.arch}-${Deno.build.os}`,
      }),
    );
    await Deno.symlink("/old-nix-runtime", join(path, "disk-runtime-root"));
    await publishRepoBase(home, path, new AbortController().signal, artifact);
    return path;
  };
  const old = await base("base-old", "/old-runtime");
  const current = await base("base-current", binding.artifact);
  return { root, home, binding, base, old, current };
};

test("pruning retires incompatible selections but keeps live disks and their Nix roots until shutdown", async () => {
  const f = await baseFixture();
  try {
    const state = join(f.root, "loom-session-vm-live");
    await Deno.mkdir(state);
    await Deno.writeTextFile(join(state, "base-generation"), "base-old");
    const orphan = join(f.home, "base-orphan");
    await Deno.mkdir(orphan);
    const preview = await pruneRepoBases(f.home, [f.binding], f.root, true);
    assert(await exists(orphan));
    assert(await exists(join(f.home, "current-" + digest("/old-runtime").slice(0, 32) + ".json")));
    const report = await pruneRepoBases(f.home, [f.binding], f.root);
    assert.deepEqual(preview, report);
    assert.equal(report.removed, 1);
    assert.deepEqual(report.retainedBases, [
      { directory: "base-current", reason: "current selection" },
      { directory: "base-old", reason: "referenced by a running or recoverable VM" },
    ]);
    assert(await exists(join(f.old, "disk-runtime-root")));
    assert.equal(
      await exists(join(f.home, "current-" + digest("/old-runtime").slice(0, 32) + ".json")),
      false,
    );
    assert.equal(await currentRepoBase(f.home, f.binding.artifact), f.current);
    await Deno.remove(state, { recursive: true });
    assert.equal((await pruneRepoBases(f.home, undefined, f.root)).removed, 1);
    assert.equal(await exists(f.old), false);
    assert(await exists(f.current));
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

test("pruning respects preparation locks, recovery markers, backing links and valid legacy selections", async () => {
  const f = await baseFixture();
  try {
    const held = await lockSessionState(join(f.home, "preparation"));
    await assert.rejects(pruneRepoBases(f.home, [f.binding], f.root));
    held.close();
    assert(await exists(f.old));
    await Deno.writeTextFile(join(f.old, "active.json"), "{}");
    await pruneRepoBases(f.home, [f.binding], f.root);
    assert(await exists(f.old));
    await Deno.remove(join(f.old, "active.json"));
    const backing = join(f.root, "backing.raw");
    await Deno.link(join(f.old, "disks/storage.raw"), backing);
    await pruneRepoBases(f.home, undefined, f.root);
    assert(await exists(f.old));
    await Deno.remove(backing);
    await pruneRepoBases(f.home, undefined, f.root);
    assert.equal(await exists(f.old), false);
    await Deno.writeTextFile(
      join(f.home, "current.json"),
      JSON.stringify({ directory: "base-current" }),
    );
    await Deno.remove(join(f.home, "current-" + digest(f.binding.artifact).slice(0, 32) + ".json"));
    await pruneRepoBases(f.home, [f.binding], f.root);
    assert.equal(await currentRepoBase(f.home, f.binding.artifact), f.current);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

test("malformed selections fail closed and symlinked bases are never followed", async () => {
  const f = await baseFixture();
  try {
    const invalid = join(f.home, "current.json");
    await Deno.writeTextFile(invalid, JSON.stringify({ directory: "../outside" }));
    await assert.rejects(pruneRepoBases(f.home, [f.binding], f.root));
    assert(await exists(f.old));
    await Deno.remove(invalid);
    const outside = join(f.root, "outside");
    await Deno.mkdir(outside);
    await Deno.writeTextFile(join(outside, "important"), "keep");
    await Deno.symlink(outside, join(f.home, "base-link"));
    await pruneRepoBases(f.home, [f.binding], f.root);
    assert(await exists(join(outside, "important")));
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

test("runtime pruning defers for live leases and crash state, then removes only obsolete generations and templates", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const home = join(root, "runtimes"),
    source = join(home, "a".repeat(64));
  const oldBackend = "/old/bin/smolvm",
    backend = "/current/bin/smolvm";
  const generation = async (name: string, artifact: string, smolvm = backend) => {
    const dir = join(source, name);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "lock.json"),
      JSON.stringify({ version: 1, artifact, smolvm }),
    );
    await Deno.symlink(artifact, join(dir, "artifact"));
    return dir;
  };
  try {
    const old = await generation("generation-old", "/old-artifact", oldBackend);
    const sharedBackend = await generation("generation-shared", "/unused-artifact");
    const pinned = await generation("generation-pinned", "/configured-artifact");
    const current = await generation("generation-current", "/current-artifact");
    await Deno.symlink(current, join(source, "current"));
    const templates = join(root, `loom-vm-templates-${Deno.uid()}`);
    for (const binary of [oldBackend, backend])
      await Deno.mkdir(join(templates, digest(binary).slice(0, 32)), { recursive: true });
    const protect = ["/configured-artifact", backend];
    const lease = (await vmMaintenanceLock(false, root))!;
    assert((await pruneRuntimeCache(home, protect, root)).deferred);
    lease.close();
    const state = join(root, "loom-vm-crashed");
    await Deno.mkdir(state);
    assert((await pruneRuntimeCache(home, protect, root)).deferred);
    await Deno.remove(state);
    const updating = await lockSessionState(source);
    assert((await pruneRuntimeCache(home, protect, root)).deferred);
    updating.close();
    const preview = await pruneRuntimeCache(home, protect, root, true);
    assert(await exists(old));
    assert(await exists(sharedBackend));
    const result = await pruneRuntimeCache(home, protect, root);
    assert.deepEqual(preview, result);
    assert.deepEqual(result, { generations: 2, templates: 1, deferred: false });
    assert.equal(await exists(old), false);
    assert.equal(await exists(sharedBackend), false);
    assert(await exists(pinned));
    assert(await exists(current));
    assert(await exists(join(templates, digest(backend).slice(0, 32))));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("global pruning sees explicit pins in other trusted repos", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  try {
    const config = join(root, "config.jsonc");
    await Deno.writeTextFile(
      config,
      `{
  "repos": [
    {
      "path": "${root}/other",
      "session": {
        "isolation": {
          "claude": {
            "artifact": "/pinned-runtime",
            "smolvm": "/pinned/bin/smolvm"
          }
        }
      }
    }
  ]
}`,
    );
    const configs = loadAllRepoConfigs(root, config);
    assert(configs.some((c) => c.isolation.runtimes?.claude?.artifact === "/pinned-runtime"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("cache collection excludes new VM launches until its guard is released", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  let reader: Deno.FsFile | undefined;
  try {
    const collector = (await vmMaintenanceLock(true, root))!;
    let acquired = false;
    const launching = vmMaintenanceLock(false, root).then((file) => {
      acquired = true;
      return file;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(acquired, false);
    collector.close();
    reader = await launching;
    assert.equal(acquired, true);
  } finally {
    reader?.close();
    await Deno.remove(root, { recursive: true });
  }
});

test("malformed runtime selections defer cleanup and template symlinks never delete their targets", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const home = join(root, "runtimes"),
    source = join(home, "b".repeat(64));
  try {
    const old = join(source, "generation-old");
    await Deno.mkdir(old, { recursive: true });
    const outside = join(root, "outside");
    await Deno.mkdir(outside);
    await Deno.writeTextFile(join(outside, "keep"), "data");
    await Deno.symlink(outside, join(source, "current"));
    assert((await pruneRuntimeCache(home, [], root)).deferred);
    assert(await exists(old));
    await Deno.remove(source, { recursive: true });
    const templates = join(root, `loom-vm-templates-${Deno.uid()}`);
    await Deno.mkdir(templates);
    await Deno.symlink(outside, join(templates, "a".repeat(32)));
    assert.equal((await pruneRuntimeCache(home, [], root)).templates, 0);
    assert(await exists(join(outside, "keep")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("a missing runtime or changed backend does not pin every historical image", async () => {
  for (const scenario of ["missing-runtime", "changed-backend"]) {
    const f = await baseFixture();
    try {
      for (let i = 0; i < 8; i++) await f.base(`base-history${i}`, `/runtime-${i}`);
      const bindings =
        scenario === "missing-runtime"
          ? [f.binding, { ...f.binding, artifact: "/not-prepared" }]
          : [{ ...f.binding, smolvm: "/upgraded-backend" }];
      const result = await pruneRepoBases(f.home, bindings, f.root);
      assert.equal(result.removed, 9, scenario);
      assert.equal(result.retained, 1, scenario);
      assert.equal(await currentRepoBase(f.home, f.binding.artifact), f.current);
      assert.equal(await exists(f.old), false);
    } finally {
      await Deno.remove(f.root, { recursive: true });
    }
  }
});

test("explicit pruning retires unconfigured images even before a replacement is prepared", async () => {
  const f = await baseFixture();
  try {
    // A shutdown without configuration must preserve every selected image.
    assert.equal((await pruneRepoBases(f.home, undefined, f.root)).removed, 0);
    const custom = await f.base("base-custom", "/custom-runtime");
    const live = join(f.root, "loom-session-vm-live");
    await Deno.mkdir(live);
    await Deno.writeTextFile(join(live, "base-generation"), "base-old");
    const result = await pruneRepoBases(
      f.home,
      [
        { ...f.binding, artifact: "/not-prepared" },
        { ...f.binding, artifact: "/custom-runtime" },
      ],
      f.root,
    );
    assert.equal(result.removed, 1);
    assert.equal(result.retained, 2);
    assert(await exists(f.old), "a running VM keeps its obsolete base");
    assert(await exists(custom), "other configured custom images survive");
    assert.equal(await exists(f.current), false);
    assert.equal(await currentRepoBase(f.home, f.binding.artifact), undefined);
    await Deno.remove(live, { recursive: true });
    assert.equal((await pruneRepoBases(f.home, undefined, f.root)).removed, 1);
    assert(await exists(custom));
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

test("pruning reports recovery markers, held ownership locks and backing links", async () => {
  const f = await baseFixture();
  let owner: Deno.FsFile | undefined;
  try {
    const busy = await f.base("base-busy", "/busy-runtime");
    const linked = await f.base("base-linked", "/linked-runtime");
    await Deno.writeTextFile(join(f.old, "active.json"), "{}");
    owner = await lockSessionState(busy);
    await Deno.link(join(linked, "disks/storage.raw"), join(f.root, "backing.raw"));
    const result = await pruneRepoBases(f.home, [f.binding], f.root);
    assert.equal(result.removed, 0);
    const reasons = new Map(result.retainedBases.map((base) => [base.directory, base.reason]));
    assert.match(reasons.get("base-old")!, /active.json/);
    assert.match(reasons.get("base-busy")!, /still running/);
    assert.match(reasons.get("base-linked")!, /backing links/);
    assert.equal(reasons.get("base-current"), "current selection");
  } finally {
    owner?.close();
    await Deno.remove(f.root, { recursive: true });
  }
});
