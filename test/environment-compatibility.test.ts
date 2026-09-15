import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { environmentIdentity } from "../runtime/src/session-vm/environment-identity.ts";
import {
  currentRepoBase,
  hasCompatibleRepoBase,
  publishRepoBase,
} from "../runtime/src/session-vm/repo-base.ts";
import { decodeManifest, type RuntimeManifest } from "../runtime/src/packaged/artifact.ts";
import { vmArguments, vmExecArguments, type VmBinding } from "../runtime/src/packaged/vm.ts";
import { repoEnvironmentWarning } from "../cli/src/environment.ts";
import { normalizeConfig } from "../backend/daemon/src/config/config.ts";

const manifest = (key = "a".repeat(64)): RuntimeManifest => ({
  version: 1,
  system: "x86_64-linux",
  backend: "smolvm",
  entrypoint: "/nix/store/" + "a".repeat(32) + "-session/bin/loom-session",
  args: ["/nix/store/" + "b".repeat(32) + "-loom/libexec/loom/runtime/src/session-vm/guest.ts"],
  guestImage: "guest-image.tar",
  environmentCompatibility: key,
});

test("prepared bases survive code releases, reject incompatible inputs, and publish across releases", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const home = join(root, "bases");
  const artifact = async (name: string, key?: string) => {
    const path = join(root, name);
    await Deno.mkdir(path);
    await Deno.writeTextFile(join(path, "manifest.json"), JSON.stringify(manifest(key)));
    return path;
  };
  try {
    const first = await artifact("release-one");
    const next = await artifact("release-two");
    const incompatible = await artifact("new-guest-image", "b".repeat(64));
    assert.equal(await environmentIdentity(first), await environmentIdentity(next));
    const binding = { artifact: first, smolvm: "/backend/bin/smolvm", writableNix: true };
    const base = async (name: string) => {
      const path = join(home, name);
      await Deno.mkdir(join(path, "disks"), { recursive: true });
      for (const name of ["storage", "overlay"]) {
        const f = await Deno.open(join(path, "disks", name + ".raw"), {
          create: true,
          write: true,
        });
        await f.truncate(1024 * 1024);
        f.close();
      }
      await Deno.writeTextFile(
        join(path, "disks/identity.json"),
        JSON.stringify({
          version: 1,
          artifact: await environmentIdentity(first),
          smolvm: binding.smolvm,
          writableNix: true,
          host: `${Deno.build.arch}-${Deno.build.os}`,
        }),
      );
      return path;
    };
    const oldBase = await base("base-first");
    await publishRepoBase(home, oldBase, new AbortController().signal, first);
    assert.equal(await currentRepoBase(home, next), oldBase);
    assert(await hasCompatibleRepoBase(home, { ...binding, artifact: next }));
    for (const change of [
      { artifact: incompatible },
      { smolvm: "/new-backend/bin/smolvm" },
      { writableNix: false },
    ])
      assert.equal(await hasCompatibleRepoBase(home, { ...binding, ...change }), false);
    assert.equal(await currentRepoBase(home, next), oldBase);
    const replacement = await base("base-next");
    await publishRepoBase(home, replacement, new AbortController().signal, next);
    assert.equal(await currentRepoBase(home, first), replacement);
    await assert.rejects(Deno.stat(oldBase), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("split runtimes launch current code on stable guest tools for directory and erofs closures", () => {
  for (const erofs of [false, true])
    for (const writableNix of [false, true]) {
      const b: VmBinding = {
        version: 1,
        artifact: "/runtime",
        smolvm: "/backend",
        workspace: "/workspace",
        state: "/private",
        token: "token",
        writableNix,
        manifest: { ...manifest(), ...(erofs ? { closureFormat: "erofs" as const } : {}) },
      };
      const args = vmArguments(b);
      assert(args.includes("/runtime:/run/loom/code:ro"));
      const exec = vmExecArguments(b);
      assert.deepEqual(exec.slice(-2), [b.manifest.entrypoint, b.manifest.args[0]]);
      const script = exec[exec.indexOf("--") + 3]!;
      assert(script.includes("lowerdir=/run/loom/store-code:/run/loom/store-base"));
      assert(script.includes("ln -sfn /opt/loom/runtime /run/loom/runtime"));
      assert.equal(script.includes("upperdir=/storage/loom-nix/upper"), writableNix);
      assert.equal(script.includes("mount -t erofs"), erofs);
    }
});

test("compatibility metadata requires a versioned image and a bounded digest", () => {
  assert.deepEqual(decodeManifest(manifest()), manifest());
  for (const key of ["", "../base", "x".repeat(64), "a".repeat(65), 4])
    assert.throws(() => decodeManifest({ ...manifest(), environmentCompatibility: key }));
  assert.throws(() => decodeManifest({ ...manifest(), guestImage: undefined }));
});

test("environment preflight warns only for enabled VM providers needing a prepared image", async () => {
  const config = normalizeConfig({
    providers: {
      codex: {
        profiles: {
          default: {},
        },
      },
    },
    session: {
      isolation: {
        enabled: true,
        codex: {
          artifact: "/missing/runtime",
          smolvm: "/missing/backend",
        },
        environment: {
          nix: true,
        },
      },
    },
  });
  config.providerAccess.only = ["codex"];
  assert.equal(
    await repoEnvironmentWarning("/repo", config),
    "Environment image missing or out of date.",
  );
  config.providerAccess.disabled = ["codex"];
  assert.equal(await repoEnvironmentWarning("/repo", config), null);
  config.providerAccess.disabled = [];
  delete config.isolation.codex;
  assert.equal(await repoEnvironmentWarning("/repo", config), null);
});
