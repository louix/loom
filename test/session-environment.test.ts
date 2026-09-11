import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeSessionEnvironment,
  sessionStartupTimeout,
} from "../core/src/session-environment.ts";
import { prepareEnvironment } from "../runtime/src/session-vm/environment.ts";
import { normalizeConfig, loadConfig } from "../backend/daemon/src/config/config.ts";
import { expandNetworkPresets } from "../runtime/src/session-vm/network-policy.ts";
import { vmArguments, vmCreateArguments, type VmBinding } from "../runtime/src/packaged/vm.ts";

test("network presets compose with exact hosts and reject unknown grants", () => {
  const config = normalizeConfig({
    isolation: {
      network_presets: ["nix", "javascript", "nix"],
      extra_allowed_hosts: ["REGISTRY.NPMJS.ORG", "example.com"],
    },
  });
  assert(config.isolation.extraAllowedHosts.includes("cache.nixos.org"));
  assert(config.isolation.extraAllowedHosts.includes("release-assets.githubusercontent.com"));
  assert(config.isolation.extraAllowedHosts.includes("jsr.io"));
  assert(config.isolation.extraAllowedHosts.includes("example.com"));
  assert.equal(
    config.isolation.extraAllowedHosts.filter((h) => h === "registry.npmjs.org").length,
    1,
  );
  assert.deepEqual(expandNetworkPresets(undefined), []);
  for (const invalid of ["nix", ["cargo"], ["__proto__"], ["*"], [1]])
    assert.throws(() => expandNetworkPresets(invalid), /network_presets/);
});

test("environment configuration validates commands and bounded setup time", () => {
  for (const invalid of [
    null,
    [],
    { nix: "yes" },
    { command_prefix: "nix develop" },
    { command_prefix: [""] },
    { command_prefix: ["bad\0arg"] },
    { prepare: false },
    { timeout_seconds: 0 },
    { timeout_seconds: 2_073_601 },
    { timeout_seconds: 1.5 },
    { typo: true },
    { memory_mib: 511 },
    { memory_mib: 65537 },
    { memory_mib: "8192" },
    { memory_mib: 1024.5 },
    { cpus: 0 },
    { cpus: 65 },
    { cpus: "2" },
    { cpus: 1.5 },
  ])
    assert.throws(() => normalizeSessionEnvironment(invalid), /isolation.environment/);
  assert.equal(sessionStartupTimeout(normalizeSessionEnvironment(undefined)), 120_000);
  assert.equal(
    sessionStartupTimeout(
      normalizeSessionEnvironment({ prepare: "setup", timeout_seconds: 2_073_600 }),
    ),
    2_073_720_000,
  );
  assert.equal(
    sessionStartupTimeout(
      normalizeSessionEnvironment({ prepare: "custom setup", timeout_seconds: 20 }),
    ),
    140_000,
  );
});

test("environment and presets belong to the selected trusted repo", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = dir + "/config.toml";
    await Deno.writeTextFile(
      file,
      `[[repo]]\npath=${JSON.stringify(dir)}\n[repo.isolation]\nnetwork_presets=["javascript"]\n[repo.isolation.environment]\nprepare="custom setup"\n`,
    );
    assert.equal(loadConfig(dir, file).isolation.environment?.prepare, "custom setup");
    assert.equal(loadConfig(dir + "/other", file).isolation.environment?.prepare, "");
    assert.deepEqual(loadConfig(dir + "/other", file).isolation.extraAllowedHosts, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("configured activation precedes arbitrary setup and preserves exports for the session", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const config = normalizeSessionEnvironment({
      command_prefix: [
        "/bin/sh",
        "-c",
        "export LOOM_TEST_ACTIVATED='a b; $(literal)'; echo not-a-worker-frame; exec \"$@\"",
        "activation",
      ],
      prepare:
        "test \"$LOOM_TEST_ACTIVATED\" = 'a b; $(literal)'\nprintf ready > result\nexport LOOM_TEST_PREPARED=yes\necho setup-output",
    });
    const env = await prepareEnvironment(config, { shell: "/bin/sh", cwd: dir });
    assert.equal(await Deno.readTextFile(dir + "/result"), "ready");
    assert.equal(env?.LOOM_TEST_ACTIVATED, "a b; $(literal)");
    assert.equal(env?.LOOM_TEST_PREPARED, "yes");
    assert.equal(await prepareEnvironment(undefined, { shell: "/missing" }), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("failed and timed-out setup never yields a ready environment or raw command output", async () => {
  await assert.rejects(
    prepareEnvironment(normalizeSessionEnvironment({ prepare: "echo private-token >&2; exit 7" }), {
      shell: "/bin/sh",
    }),
    (error: Error) =>
      /preparation failed/.test(error.message) && !error.message.includes("private-token"),
  );
  await assert.rejects(
    prepareEnvironment(normalizeSessionEnvironment({ command_prefix: ["/missing-command"] }), {
      shell: "/bin/sh",
    }),
    /preparation failed/,
  );
  const config = normalizeSessionEnvironment({ prepare: "exec sleep 10", timeout_seconds: 1 });
  await assert.rejects(prepareEnvironment(config, { shell: "/bin/sh" }), /timed out/);
});

test("writable Nix uses a read-only artifact and private ext4 upper on both closure formats", () => {
  const binding: VmBinding = {
    version: 1,
    artifact: "/nix/store/" + "a".repeat(32) + "-runtime",
    smolvm: "/bin/smolvm",
    workspace: "/home/test/repo",
    state: "/tmp/session",
    token: "test",
    writableNix: true,
    gitSocket: "/tmp/session/git.sock",
    manifest: {
      version: 1,
      system: "x86_64-linux",
      backend: "smolvm",
      entrypoint: "/nix/store/" + "b".repeat(32) + "-worker/bin/worker",
      args: [],
    },
  };
  for (const environment of [
    undefined,
    normalizeSessionEnvironment({ memory_mib: 8192, cpus: 2 }),
  ]) {
    const args = vmCreateArguments(binding, environment);
    assert.equal(args[args.indexOf("--mem") + 1], environment ? "8192" : "2048");
    assert.equal(args[args.indexOf("--cpus") + 1], environment ? "2" : "1");
  }
  for (const erofs of [false, true]) {
    const args = vmArguments({
      ...binding,
      manifest: { ...binding.manifest, ...(erofs ? { closureFormat: "erofs" as const } : {}) },
    });
    assert(args.includes(binding.artifact + ":/run/loom/runtime:ro"));
    assert(!args.some((a) => a.includes("daemon-socket") || a === "--net"));
    const script = args[args.indexOf("-c") + 1]!;
    assert(script.includes("upperdir=/storage/loom-nix/upper"));
    assert(script.includes("mount --bind /storage/loom-nix/var /nix/var"));
    assert.equal(script.includes("mount -t erofs"), erofs);
  }
  const imageArgs = vmArguments({
    ...binding,
    manifest: { ...binding.manifest, guestImage: "guest-image.tar" },
  });
  const imageScript = imageArgs[imageArgs.indexOf("-c") + 1]!;
  assert(imageScript.includes("mount --bind /nix/store /run/loom/store-lower"));
  assert(imageScript.includes("upperdir=/storage/loom-nix/upper"));
  assert(imageScript.includes("/opt/loom/runtime /run/loom/runtime"));
  assert(!imageArgs.includes(binding.artifact + ":/run/loom/runtime:ro"));
});
