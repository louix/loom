/** Guest-root acceptance probes using the production mount and environment policy. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { vmArguments, vmEnvironment, reapVm, type VmBinding } from "../runtime/src/packaged/vm.ts";
import type { resolveRuntime } from "../runtime/src/packaged/artifact.ts";

export const checkRuntimeIsolation = async (
  prepared: Awaited<ReturnType<typeof resolveRuntime>>,
  workspace: string,
  hostOnly: string,
) => {
  const state = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-vm-" });
  const binding: VmBinding = {
    version: 1,
    artifact: prepared.lock.artifact,
    smolvm: prepared.lock.smolvm,
    manifest: prepared.manifest,
    workspace,
    state,
    token: "acceptance-test-only".repeat(2),
  };
  try {
    for (const dir of ["home", "cache", "data", "config"]) await Deno.mkdir(join(state, dir));
    const args = vmArguments(binding);
    const prefix = [
      ...args.slice(0, args.indexOf("--")).filter((arg) => arg !== "-i"),
      "--timeout",
      "30s",
    ];
    const run = (extra: string[], command: string[]) =>
      new Deno.Command(binding.smolvm, {
        args: [...prefix, ...extra, "--", ...command],
        clearEnv: true,
        env: vmEnvironment(state),
        cwd: state,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
    const host = Deno.networkInterfaces().find(
      (i) => i.family === "IPv4" && !i.address.startsWith("127."),
    )?.address;
    assert.ok(host, "Network positive control requires a non-loopback host IPv4 address");
    let requests = 0;
    const server = Deno.serve({ hostname: host, port: 0, onListen() {} }, () => {
      requests++;
      return new Response("loom-network-control");
    });
    try {
      const wget = [
        "/bin/busybox",
        "wget",
        "-q",
        "-T",
        "2",
        "-O",
        "-",
        `http://${host}:${server.addr.port}/`,
      ];
      const allowed = await run(["--allow-cidr", `${host}/32`], wget);
      assert.ok(allowed.success, new TextDecoder().decode(allowed.stderr));
      assert.equal(new TextDecoder().decode(allowed.stdout), "loom-network-control");
      const before = requests;
      const denied = await run([], wget);
      assert.ok(!denied.success, "Default guest unexpectedly reached the host");
      assert.match(new TextDecoder().decode(denied.stderr), /Network unreachable/);
      assert.equal(requests, before);
    } finally {
      await server.shutdown();
    }
    // Paths are positional shell arguments, never interpolated shell code.
    const checks = await run(
      [],
      [
        "/bin/sh",
        "-c",
        `set -eu
test -f "$1/code.ts"
test ! -e "$2"
test ! -e "$1/outside-link"
test ! -e /nix/var/nix/daemon-socket/socket
if touch /nix/store/loom-must-not-write 2>/dev/null; then exit 31; fi
ls -1 /nix/store
`,
        "loom-isolation-probe",
        workspace,
        hostOnly,
      ],
    );
    assert.ok(checks.success, new TextDecoder().decode(checks.stderr));
    const inventory = (await Deno.readTextFile(join(binding.artifact, "store-paths")))
      .trim()
      .split("\n")
      .map((p) => p.slice("/nix/store/".length))
      .sort();
    assert.deepEqual(new TextDecoder().decode(checks.stdout).trim().split("\n").sort(), inventory);
    return { mode: "isolation", passed: true, closurePaths: inventory.length };
  } finally {
    await reapVm(binding);
    await Deno.remove(state, { recursive: true });
  }
};
