/** Live regression: Nix pnpm must compile native addons in a host-mounted repo.
 * Run with a rebuilt session runtime artifact and its smolvm executable.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { gitFixture } from "./lib/git-fixture.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { normalizeSessionEnvironment } from "../core/src/session-environment.ts";
import { expandNetworkPresets } from "../runtime/src/session-vm/network-policy.ts";

const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm, "Pass a rebuilt session runtime artifact and pinned smolvm");
const f = await gitFixture();
const oldState = Deno.env.get("XDG_STATE_HOME");
Deno.env.set("XDG_STATE_HOME", join(f.root, "state"));
let worker: Awaited<ReturnType<typeof launchSessionVm>> | undefined;
try {
  const lock = JSON.parse(await Deno.readTextFile(new URL("../flake.lock", import.meta.url)));
  const nixpkgs = lock.nodes.nixpkgs;
  await Deno.writeTextFile(
    join(f.repo, "flake.nix"),
    `{
    inputs.nixpkgs.url = "github:NixOS/nixpkgs/${nixpkgs.locked.rev}";
    outputs = { self, nixpkgs }: let pkgs = nixpkgs.legacyPackages.${Deno.build.arch}-linux; in {
      devShells.${Deno.build.arch}-linux.default = pkgs.mkShell {
        packages = [ pkgs.nodejs_24 pkgs.pnpm pkgs.python3 pkgs.gnumake pkgs.gcc pkgs.cmake ];
      };
    };
  }`,
  );
  await Deno.writeTextFile(
    join(f.repo, "flake.lock"),
    JSON.stringify({
      nodes: { nixpkgs, root: { inputs: { nixpkgs: "nixpkgs" } } },
      root: "root",
      version: 7,
    }),
  );
  await Deno.writeTextFile(
    join(f.repo, "package.json"),
    JSON.stringify({
      name: "loom-native-addon-regression",
      private: true,
      dependencies: { "cpu-features": "0.0.10", "header-probe": "file:./header-probe" },
    }),
  );
  await Deno.writeTextFile(
    join(f.repo, "pnpm-workspace.yaml"),
    'allowBuilds:\n  cpu-features: true\n  "header-probe@file:header-probe": true\n',
  );
  // Nix Node can automatically provide local headers during `rebuild`. Exercise
  // node-gyp's download/extraction explicitly as a dependency lifecycle script.
  await Deno.mkdir(join(f.repo, "header-probe"));
  await Deno.writeTextFile(
    join(f.repo, "header-probe/package.json"),
    JSON.stringify({
      name: "header-probe",
      version: "1.0.0",
      scripts: { install: 'node "$npm_config_node_gyp" install' },
    }),
  );
  await f.git("-C", f.repo, "add", ".");
  await f.git("-C", f.repo, "commit", "-qm", "Native addon fixture");
  worker = await launchSessionVm({
    artifact,
    smolvm,
    workspace: f.repo,
    repoRoot: f.repo,
    sessionDirectory: join(f.root, "candidate"),
    preparationOnly: true,
    auth: {},
    providerHosts: [],
    extraAllowedHosts: expandNetworkPresets(["nix", "javascript"]),
    environment: normalizeSessionEnvironment({
      nix: true,
      command_prefix: ["nix", "develop", "path:.", "--no-write-lock-file", "--command"],
      prepare: `pnpm install
node -e 'const cpu = require("cpu-features")(); if (!cpu.arch) process.exit(1); console.log("LOOM_NATIVE_ADDON_OK", cpu.arch)'`,
    }),
  });
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
      output = (output + chunk).slice(-65536);
      console.error(chunk.trimEnd());
    }
  };
  await Promise.all([drain(worker.output), drain(worker.diagnostics!)]);
  assert.equal(await worker.exitCode, 0, output);
  assert(output.includes("LOOM_NATIVE_ADDON_OK"), output);
  assert(output.includes("headers.tar.gz"), "The test must exercise downloaded header extraction");
  assert(!output.includes("TAR_ENTRY_ERROR"), output);
} finally {
  if (worker) {
    worker.terminate();
    await worker.cleanup!();
  }
  await f.close();
  if (oldState === undefined) Deno.env.delete("XDG_STATE_HOME");
  else Deno.env.set("XDG_STATE_HOME", oldState);
}
