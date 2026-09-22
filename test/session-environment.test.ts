import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeSessionEnvironment,
  sessionStartupTimeout,
} from "../core/src/session-environment.ts";
import { prepareEnvironment, guestPathProfile } from "../runtime/src/session-vm/environment.ts";
import { normalizeConfig, loadConfig } from "../backend/daemon/src/config/config.ts";
import { expandNetworkPresets } from "../runtime/src/session-vm/network-policy.ts";
import { vmArguments, vmCreateArguments, type VmBinding } from "../runtime/src/packaged/vm.ts";

test("guest login profile restores the prepared PATH as literal shell data", async () => {
  const path = "/nix/store/dev/bin:/workspace/a'b/$(exit 91):/bin";
  const result = await new Deno.Command("/bin/sh", {
    args: ["-c", `PATH=/usr/bin:/bin\n${guestPathProfile(path)}printf '%s' "$PATH"`],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(result.success);
  assert.equal(new TextDecoder().decode(result.stdout), path);
});

test("network presets compose with exact hosts and reject unknown grants", () => {
  const config = normalizeConfig({
    session: {
      isolation: {
        network_presets: ["nix", "javascript", "python", "rust", "nix", "rust"],
        extra_allowed_hosts: ["REGISTRY.NPMJS.ORG", "example.com"],
      },
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
  assert.deepEqual(expandNetworkPresets(["python"]), ["pypi.org", "files.pythonhosted.org"]);
  assert(config.isolation.extraAllowedHosts.includes("pypi.org"));
  assert(config.isolation.extraAllowedHosts.includes("files.pythonhosted.org"));
  for (const host of [
    "crates.io",
    "index.crates.io",
    "static.crates.io",
    "static.rust-lang.org",
    "sh.rustup.rs",
  ]) {
    assert.equal(config.isolation.extraAllowedHosts.filter((h) => h === host).length, 1);
    assert(!expandNetworkPresets(["nix"]).includes(host));
  }
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
    { init: false },
    { init: "bad\0command" },
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
      normalizeSessionEnvironment({ command_prefix: ["/bin/sh"], timeout_seconds: 2_073_600 }),
    ),
    2_073_720_000,
  );
  assert.equal(
    sessionStartupTimeout(
      normalizeSessionEnvironment({ command_prefix: ["/bin/sh"], timeout_seconds: 20 }),
    ),
    140_000,
  );
});

test("environment and presets belong to the selected trusted repo", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = dir + "/config.jsonc";
    await Deno.writeTextFile(
      file,
      `{
  "repos": [
    {
      "path": ${JSON.stringify(dir)},
      "session": {
        "isolation": {
          "network_presets": [
            "javascript"
          ],
          "environment": {
            "command_prefix": ["/bin/sh"]
          }
        }
      }
    }
  ]
}`,
    );
    assert.deepEqual(loadConfig(dir, file).isolation.environment?.commandPrefix, ["/bin/sh"]);
    assert.deepEqual(loadConfig(dir + "/other", file).isolation.environment?.commandPrefix, []);
    assert.deepEqual(loadConfig(dir + "/other", file).isolation.extraAllowedHosts, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("activation captures exports and keeps command output off the worker protocol", async () => {
  const config = normalizeSessionEnvironment({
    command_prefix: [
      "/bin/sh",
      "-c",
      'export LOOM_TEST_ACTIVATED=yes; echo not-a-frame; exec "$@"',
      "activation",
    ],
  });
  assert.equal(
    (await prepareEnvironment(config, { shell: "/bin/sh" }))?.LOOM_TEST_ACTIVATED,
    "yes",
  );
  assert.equal(await prepareEnvironment(undefined, { shell: "/missing" }), undefined);
});

test("failed and timed-out activation is bounded and redacts command output", async () => {
  await assert.rejects(
    prepareEnvironment(
      normalizeSessionEnvironment({
        command_prefix: ["/bin/sh", "-c", "echo private-token >&2; exit 7"],
      }),
      { shell: "/bin/sh" },
    ),
    (error: Error) =>
      /preparation failed/.test(error.message) && !error.message.includes("private-token"),
  );
  await assert.rejects(
    prepareEnvironment(
      normalizeSessionEnvironment({
        command_prefix: ["/bin/sh", "-c", "exec sleep 10"],
        timeout_seconds: 1,
      }),
      { shell: "/bin/sh" },
    ),
    /timed out/,
  );
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
    manifest: {
      version: 1,
      system: "x86_64-linux",
      backend: "smolvm",
      entrypoint: "/nix/store/" + "b".repeat(32) + "-worker/bin/worker",
      args: [],
      guestImage: "guest-image.tar",
      environmentCompatibility: "a".repeat(64),
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
    assert(args.includes(binding.artifact + ":/run/loom/code:ro"));
    assert(!args.some((a) => a.includes("daemon-socket") || a === "--net"));
    const script = args[args.indexOf("-c") + 1]!;
    assert(script.includes("upperdir=/storage/loom-nix/upper"));
    assert(script.includes("mount --bind /storage/loom-nix/var /nix/var"));
    assert.equal(script.includes("mount -t erofs"), erofs);
  }
});
